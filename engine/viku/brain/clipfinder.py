"""Viku Brain v1 clip finder: windows -> features -> score -> ranked candidate reels.

Windows: transcript cues joined at pauses into spans of 0.6-1.3 x the target reel length (the Automate slider,
10 s - 5 min) that end at a natural pause (>= 0.4 s); the picked windows are then fitted (fit_length) so the
jump-cut reel lands in 90-100 % of the target.
Features (raw, then z-scored across the sermon's windows):
  energy / energy_var  mean + std of voiced frame dB (relative to the sermon median)
  speech_rate          letters per voiced second
  direct_address       "you" words per minute (ଆପଣ/ତୁମେ, आप/तुम, you)
  victory / enemy      encouragement-victory words / enemy-problem words per minute (lexicon.json)
  scripture            scripture mentions (book names, ଅଧ୍ୟାୟ/अध्याय/chapter ...) per minute
  ends_on_hope         hope words in the last 2 cues;  ends_negative: judgement words there
  call_response        share of cues that are only amen/hallelujah/yes fillers
  asr_conf             mean ASR confidence (music / crowd noise reads low)
  duration_fit         closeness to the target length
  semantic             similarity to kept-vs-rejected reels (Phase 3 embedding hook; 0 until then)
Score = sigmoid(bias + w . z) with weights.json, or the learned ranker (<data>/models/brain/ranker.json).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .. import config
from ..media import audio
from . import embed, planner, ranker, text as T

FEATURES = ["energy", "energy_var", "speech_rate", "direct_address", "victory", "enemy", "scripture",
            "ends_on_hope", "ends_negative", "call_response", "asr_conf", "duration_fit", "semantic"]
REASONS = {
    "energy": "high energy delivery", "energy_var": "lively, varied voice", "speech_rate": "fast, passionate pace",
    "direct_address": "speaks straight to 'you'", "victory": "victory / encouragement words",
    "enemy": "victory over the enemy / problems", "scripture": "mentions scripture",
    "ends_on_hope": "ends on hope", "asr_conf": "clear speech", "duration_fit": "good reel length",
    "semantic": "like reels you kept",
}


def brain_dir() -> Path:
    return config.sub("models") / "brain"


def framedb(p: dict) -> np.ndarray:
    """20 ms frame dB of the whole sermon, cached next to the project."""
    from .. import projects
    d = projects.pdir(p["id"])
    f = d / "framedb.npy"
    if f.exists():
        return np.load(f)
    import soundfile as sf
    out = []
    with sf.SoundFile(p["wav16"]) as snd:
        hop = int(audio.SR * audio.FRAME)
        while True:
            x = snd.read(hop * 3000, dtype="float32", always_2d=False)
            if len(x) == 0:
                break
            out.append(audio.frame_db(x))
    db = np.concatenate(out) if out else np.zeros(0, np.float32)
    np.save(f, db)
    return db


MIN_CAP, MAX_CAP = 10.0, 300.0
MAX_ENDS = 16  # per start, for caps above 60 s (keeps feature + embedding work near the 60 s cost)
MAX_HOLE = 10.0  # a window never spans a longer gap between cues (an un-analysed stretch, a song, a break)


def clamp_len(max_seconds: float = 60.0) -> float:
    return min(max(float(max_seconds or 60.0), MIN_CAP), MAX_CAP)


def length_bounds(max_seconds: float = 60.0) -> tuple[float, float, float]:
    """Reel length (10 s - 5 min) -> (min window, max window, target) in SOURCE seconds for ranking.

    The slider is the length the editor wants, not only a ceiling. Windows are ranked around it (jump cuts later
    remove 10-30 % of a source span, so windows reach past the target); `fit_length` then moves the chosen window's
    edges until the jump-cut reel lands in [reel_floor(target), target]."""
    cap = clamp_len(max_seconds)
    return max(5.0, cap * 0.6), cap * 1.3, cap


def reel_floor(target: float) -> float:
    """Shortest acceptable reel for a target length: 60 s -> 54 s, 10 s -> 8 s, 300 s -> 270 s."""
    return target - max(2.0, 0.1 * target)


def build_windows(items: list[dict], min_len=20.0, max_len=60.0, end_gap=0.4) -> list[tuple[int, int]]:
    """Candidate (start, end) cue pairs for ranking. Above ~1 min only every 2nd-5th start is used (each window is
    embedded; a 2 min target over a 1 h sermon was ~3,900 windows / ~8 min) - fit_length still moves the edges."""
    out = []
    n = len(items)
    stride = max(1, round(max_len / 78.0))   # 60 s target (78 s windows) -> every start, 120 s -> 2, 300 s -> 5
    seen = -1
    for i in range(n):
        if i > 0 and items[i]["start"] - items[i - 1]["end"] < 0.25:
            continue  # start on a pause
        seen += 1
        if seen % stride:
            continue
        ends = []
        for j in range(i, n):
            d = items[j]["end"] - items[i]["start"]
            if d > max_len or (j > i and items[j]["start"] - items[j - 1]["end"] > MAX_HOLE):
                break
            if d >= min_len:
                gap = items[j + 1]["start"] - items[j]["end"] if j + 1 < n else 9.0
                if gap >= end_gap:
                    ends.append(j)
        if len(ends) > MAX_ENDS:
            # long targets: evenly spaced end points, always including the shortest and the longest
            ends = [ends[round(k * (len(ends) - 1) / (MAX_ENDS - 1))] for k in range(MAX_ENDS)]
        out.extend((i, j) for j in dict.fromkeys(ends))
    return out


def features_v1(items: list[dict], lang: str, db: np.ndarray, med: float, thr: float) -> dict:
    """v1 features (hand-weight baseline, weights.json) - kept for train_seed's baseline comparison."""
    s, e = items[0]["start"], items[-1]["end"]
    dur = max(e - s, 1e-3)
    mins = dur / 60
    seg = db[int(s / audio.FRAME):int(e / audio.FRAME)]
    v = seg[seg > thr] if len(seg) else seg
    txt = " ".join(it["text"] for it in items)
    voiced = max(len(v) * audio.FRAME, 1.0)
    last = " ".join(it["text"] for it in items[-2:])
    cr = sum(1 for it in items if is_filler(it["text"], lang)) / len(items)
    return {
        "energy": float(v.mean() - med) if len(v) else 0.0,
        "energy_var": float(v.std()) if len(v) else 0.0,
        "speech_rate": T.letters(txt) / voiced,
        "direct_address": T.lex_hits(txt, "direct_address", lang) / mins,
        "victory": T.lex_hits(txt, "victory", lang) / mins,
        "enemy": T.lex_hits(txt, "enemy", lang) / mins,
        "scripture": (T.lex_hits(txt, "scripture", lang) + scripture_names(txt)) / mins,
        "ends_on_hope": float(min(T.lex_hits(last, "hope_end", lang), 3)),
        "ends_negative": float(min(T.lex_hits(last, "negative_end", lang), 3)),
        "call_response": cr,
        "asr_conf": float(np.mean([it.get("conf") or 0.0 for it in items])),
        "duration_fit": max(0.0, 1 - abs(dur - 45) / 25),
        "semantic": embed.similarity_to_favourites(txt),
    }


def scripture_names(txt: str) -> int:
    from .. import bible
    t = bible.norm(txt)
    n = 0
    for name, _ in bible.book_names():
        if len(name) >= 4 and name in t:
            n += 1
    return min(n, 3)


def is_filler(text: str, lang: str) -> bool:
    toks = T.tokens(text)
    if not toks:
        return True
    lx = T.lexicon()["call_response"]
    words = [T.norm(w) for L in (lang, "en") for w in lx.get(L, [])]
    single = {w for w in words if " " not in w}
    rest = [t for t in toks if not any(t == w or (len(w) > 2 and t.startswith(w)) for w in single)]
    phr = sum(T.norm(text).count(w) for w in words if " " in w)
    return len(rest) <= max(0, phr * 2) or (len(rest) <= 1 and len(toks) <= 3)


DANGLING = {"or": ["ତାହେଲେ", "ତେବେ", "କିନ୍ତୁ", "ଯଦି", "ଆଉ", "ଏବଂ", "କାରଣ", "ଯେ", "ଯେଉଁ", "ଯୋଉ"],
            "hi": ["तो", "लेकिन", "पर", "अगर", "और", "क्योंकि", "कि", "जो", "जब", "तब"],
            "en": ["then", "but", "if", "and", "because", "that", "when", "so"]}


REF_INTRO = {"or": ["ଅଧ୍ୟ", "ପଦ", "ପୋଦ"], "hi": ["अध्या", "पद"], "en": ["chapter", "verse"]}  # incl. ASR spellings


def is_dangling(last: dict, lang_default: str) -> bool:
    """Last cue is a fragment: very short, or its last word is a conjunction / 'if-then' setup."""
    toks = T.tokens(last.get("text", ""))
    if not toks or last["end"] - last["start"] < 0.9:
        return True
    L = last.get("lang") or lang_default
    tail = {T.norm(w) for w in DANGLING.get(L, []) + DANGLING["en"]}
    if toks[-1] in tail or (len(toks) <= 3 and any(t in tail for t in toks)):
        return True
    # "Matthew 4, verse 4 ..." - announcing a reference sets up a quote that the window then cuts off
    ref_words = REF_INTRO.get(L, []) + REF_INTRO["en"]
    return len(toks) <= 7 and (T.lex_hits(last.get("text", ""), "scripture", L) > 0
                               or any(t.startswith(w) for t in toks for w in ref_words))


def sermon_audio(p: dict):
    db = framedb(p) if p.get("wav16") and Path(p["wav16"]).exists() else np.zeros(0, np.float32)
    med = float(np.median(db)) if len(db) else -40.0
    return db, med, float(audio.threshold(db)) if len(db) else -99.0


def window_text(items: list[dict]) -> str:
    return " ".join(it["text"] for it in items)


def score_windows(p: dict, wins: list[list[dict]], lang_default: str, job=None, target: float = 45.0
                  ) -> tuple[np.ndarray, np.ndarray, list[dict], dict]:
    """Raw features + embeddings for every window -> ranker scores (z-scored within this sermon)."""
    db, med, thr = sermon_audio(p)
    rows = []
    for k, its in enumerate(wins):
        rows.append(ranker.raw_features(its, lang_default, db if len(db) else None, med, thr, audio.FRAME, target))
        if job is not None and k % 200 == 0:
            job.check()
            job.update(0.1 + 0.4 * k / max(len(wins), 1), f"window features {k}/{len(wins)}")
    R = np.array([[r[f] for f in ranker.RAW] for r in rows], float)
    m = ranker.load_model()
    if not m:
        raise RuntimeError("no ranker model (ranker_seed.json missing)")
    texts = [window_text(its) for its in wins]
    if job is not None:
        job.update(0.5, f"embedding {len(texts)} windows")
    E = embed.embed_texts(texts, "passage: ",
                          progress=(lambda d, n: job.update(0.5 + 0.35 * d / max(n, 1), f"embedding windows {d}/{n}"))
                          if job is not None else None)
    sc, contrib = ranker.score(R, E, m)
    return sc, contrib, rows, m


FIT_SPAN = 2.5      # fit_length never looks at a source span longer than 2.5 x the target
OVER = 0.5          # a reel may run this much past the target (30.4 s on a 30 s slider is fine)
FIT_TRIES = 60      # windows fitted per /suggest before giving up on finding more non-overlapping reels


def _planned(items: list[dict], a: int, b: int, pauses: list, lang: str) -> tuple[list, float]:
    segs = planner.plan(items[a:b + 1], pauses, lang, 1e9)   # uncapped: measure the real jump-cut length
    return segs, sum(e - s for s, e in segs)


def fit_length(items: list[dict], i: int, j: int, pauses: list, lang: str, target: float
               ) -> tuple[int, int, list[list[float]], float]:
    """Move window (i, j)'s edges so the JUMP-CUT reel lands in [reel_floor(target), target + OVER].

    The end moves first (nearest fitting end to the ranked one, a finished line preferred over a dangling one); when
    the analysed stretch after the window runs out, the start moves earlier. Never crosses a > MAX_HOLE gap (an
    un-analysed stretch) or the analysed range. -> (i, j, segments, seconds); shorter than the floor only when the
    analysed speech around the window is too short."""
    floor, n = reel_floor(target), len(items)
    lo = i
    while lo > 0 and items[lo]["start"] - items[lo - 1]["end"] <= MAX_HOLE:
        lo -= 1
    hi = j
    while hi + 1 < n and items[hi + 1]["start"] - items[hi]["end"] <= MAX_HOLE:
        hi += 1

    def end_tier(b: int) -> int:
        """How cleanly the reel can stop after cue b. Cues carry 0.15 s of padding on each side, so a cue gap of
        0.4 = 0.7 s of real silence (tier 0), >= 0 = a real pause of >= 0.3 s (tier 1), < 0 = a long run of speech
        that segment() split at its quietest frame (tier 2: last resort, only when nothing else hits the length)."""
        if b == hi or b + 1 >= n:
            return 0
        gap = items[b + 1]["start"] - items[b]["end"]
        return 0 if gap >= 0.4 - 1e-6 else 1 if gap >= -1e-6 else 2

    def ok_start(a: int) -> bool:   # a hook starts after a real pause (>= 0.3 s of silence)
        return a == 0 or items[a]["start"] - items[a - 1]["end"] >= -1e-6

    cands = []
    for b in range(i, hi + 1):
        if items[b]["end"] - items[i]["start"] > FIT_SPAN * target:
            break
        segs, d = _planned(items, i, b, pauses, lang)
        if d <= target + OVER:
            cands.append((b, segs, d, end_tier(b)))
    if not cands:
        segs = planner.plan(items[i:j + 1], pauses, lang, target)
        return i, j, segs, sum(e - s for s, e in segs)

    def key(c):
        b, _, d, tier = c
        if d >= floor:   # in range: a finished line, then the cleanest pause, then nearest to the ranked end
            return (0, is_dangling(items[b], lang), tier, abs(b - j))
        # too short: the longest ending, a dangling / unpaused one weighed like the ranker's dangling penalty (a
        # 6 s reel ending "when we ..." still beats a clean 0.9 s one; suggest() skips such windows when it can)
        return (1, -d * (0.6 if is_dangling(items[b], lang) else 1.0) * (0.8 if tier == 2 else 1.0))
    b, segs, d, _ = min(cands, key=key)
    a = i
    if d < floor:   # the speech after the window ran out: reach back for earlier lines (same end)
        for a2 in range(i - 1, lo - 1, -1):
            if items[b]["end"] - items[a2]["start"] > FIT_SPAN * target:
                break
            if not ok_start(a2):
                continue
            s2, d2 = _planned(items, a2, b, pauses, lang)
            if d2 > target + OVER:
                break
            a, segs, d = a2, s2, d2
            if d >= floor:
                break
    return a, b, segs, d


def _window_lang(its: list[dict], lang_default: str) -> str:
    langs: dict[str, float] = {}
    for it in its:
        L = it.get("lang", lang_default)
        langs[L] = langs.get(L, 0) + it["end"] - it["start"]
    return max(langs, key=langs.get)


def suggest(p: dict, count: int = 8, rng: list | None = None, job=None, max_seconds: float = 60.0,
            max_overlap: float = 0.25) -> list[dict]:
    """max_overlap: share of a clip that may overlap an earlier pick (0.25 = separate reels; Automate's single-reel
    picker allows 0.5, since its clips are alternatives and only one is made)."""
    min_len, max_len, target = length_bounds(max_seconds)
    items = sorted([t for t in p.get("transcript", []) if t.get("text")], key=lambda t: t["start"])
    if rng:
        items = [t for t in items if t["start"] >= rng[0] and t["end"] <= rng[1]]
    if len(items) < 3:
        return []
    lang_default = p["language"] if p["language"] != "auto" else "or"
    if p["language"] != "auto":
        items = [dict(t, lang=p["language"]) for t in items]
    wins = build_windows(items, min_len, max_len)
    if not wins:   # the analysed part is shorter than the target: rank what there is, fit_length stretches it
        wins = build_windows(items, 5.0, max_len) or [(0, len(items) - 1)]
    sc, contrib, rows, model = score_windows(p, [items[i:j + 1] for i, j in wins], lang_default, job, target)
    # house rule: a reel ends on a finished (encouraging) line, never on a setup like "then I ..." / "but ..."
    dangling = np.array([is_dangling(items[j], lang_default) for _, j in wins])
    sc = np.where(dangling, sc * 0.6, sc)
    order = np.argsort(-sc)
    pauses = p.get("pauses", [])
    picked: list[tuple] = []   # (k, i, j, lang, segs, seconds) with the window fitted to the target length
    spans: list[tuple[float, float]] = []

    def overlaps(s: float, e: float) -> bool:
        return any(min(e, b) - max(s, a) > max_overlap * (e - s) for a, b in spans)
    tries = 0
    too_short = 0.75 * reel_floor(target)
    spare: list[tuple] = []   # fitted windows far below the target: used only if not enough others fit
    for k in order:
        i, j = wins[k]
        if overlaps(items[i]["start"], items[j]["end"]):
            continue
        tries += 1
        if tries > FIT_TRIES:
            break
        lang = _window_lang(items[i:j + 1], lang_default)
        i2, j2, segs, secs = fit_length(items, i, j, pauses, lang, target)
        if overlaps(items[i2]["start"], items[j2]["end"]):
            continue
        if secs < too_short:
            spare.append((int(k), i2, j2, lang, segs, secs))
            continue
        picked.append((int(k), i2, j2, lang, segs, secs))
        spans.append((items[i2]["start"], items[j2]["end"]))
        if len(picked) >= count:
            break
    for c in sorted(spare, key=lambda c: -c[5]):   # e.g. a 30 s part with a 5 min slider: the longest first
        if len(picked) >= count:
            break
        if not overlaps(items[c[1]]["start"], items[c[2]]["end"]):
            picked.append(c)
            spans.append((items[c[1]]["start"], items[c[2]]["end"]))
    picked.sort(key=lambda c: -float(sc[c[0]]))
    out = []
    sermon = [t["text"] for t in items]
    for rank, (k, i, j, _, segs, secs) in enumerate(picked):
        its = items[i:j + 1]
        lang = _window_lang(its, lang_default)
        rs = ranker.reasons(contrib[k], model)
        title, flag = pick_title(its, lang, sermon, f"{_short_name(p)} · Clip {rank + 1}")
        out.append({"id": f"s{rank + 1}", "score": round(float(sc[k]), 4), "title": title, "title_flag": flag,
                    "segments": segs, "window": [items[i]["start"], items[j]["end"]],
                    "duration": round(secs, 2), "target_seconds": target,
                    "short_of_target": bool(secs < reel_floor(target)), "reasons": [r["why"] for r in rs],
                    "reason_details": rs, "language": lang,
                    "features": {f: (None if np.isnan(rows[k][f]) else round(float(rows[k][f]), 4)) for f in ranker.RAW},
                    "model": model.get("kind")})
    return out


def _short_name(p: dict) -> str:
    name = p.get("name") or "Sermon"
    return T.short_title(name.split(" _ ")[0].strip() or name, 32)


def window_verses(items: list[dict], lang: str) -> list[dict]:
    """Verses a window quotes: explicit references always, by meaning only when the Bible index is already built
    (never trigger the 7-8 min index build from /suggest). -> [{"ref": "<native> · <English>"}]"""
    from .. import bible
    from . import scripture
    if lang not in bible.TRANSLATIONS or not bible.db_path(lang).exists():
        return []
    caps = [{"t0": it["start"], "t1": it["end"], "text": it["text"]} for it in items]
    try:
        hits = scripture.detect(caps, lang, semantic=bible.index_ready(lang))
    except Exception:  # noqa: BLE001 - a title fallback must never fail /suggest
        return []
    out = []
    for h in hits[:1]:
        try:
            out.append({"ref": bible.verse(h["ref"], lang)["display_ref"]})
        except Exception:  # noqa: BLE001
            out.append({"ref": h["ref"]})
    return out


def pick_title(items: list[dict], lang: str, sermon: list[str] | None = None, fallback_name: str = ""
               ) -> tuple[str, str | None]:
    """Hook title (<= 6 words + "!" / "?") from the window's lines through the same ASR-quality gate as reels
    (brain/hooks.py). When no line passes: the quoted verse's reference, else "<project> · Clip N", flagged
    "review". -> (title, title_flag)."""
    from . import hooks
    hk = hooks.hook(items, lang, sermon=sermon, fallback_name=fallback_name)
    if hk.get("title_flag") == "review":
        vs = window_verses(items, lang)
        if vs:
            hk = hooks.hook(items, lang, vs, sermon=sermon, fallback_name=fallback_name)
    return hk["title"] or fallback_name, hk.get("title_flag")


def window_features(p: dict, segments: list, lang: str) -> dict:
    """Raw ranker features + text for an arbitrary reel (its segments' transcript) - used to label feedback."""
    items = sorted([t for t in p.get("transcript", []) if any(t["start"] < e and t["end"] > s for s, e in segments)],
                   key=lambda t: t["start"])
    if not items:
        return {}
    db, med, thr = sermon_audio(p)
    f = ranker.raw_features(items, lang, db if len(db) else None, med, thr, audio.FRAME)
    return {k: (None if np.isnan(v) else v) for k, v in f.items()} | {"_text": window_text(items)}
