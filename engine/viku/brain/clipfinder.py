"""Viku Brain v1 clip finder: windows -> features -> score -> ranked candidate reels.

Windows: transcript cues joined at pauses into 20-60 s spans that end at a natural pause (>= 0.4 s).
Features (raw, then z-scored across the sermon's windows):
  energy / energy_var  mean + std of voiced frame dB (relative to the sermon median)
  speech_rate          letters per voiced second
  direct_address       "you" words per minute (ଆପଣ/ତୁମେ, आप/तुम, you)
  victory / enemy      encouragement-victory words / enemy-problem words per minute (lexicon.json)
  scripture            scripture mentions (book names, ଅଧ୍ୟାୟ/अध्याय/chapter ...) per minute
  ends_on_hope         hope words in the last 2 cues;  ends_negative: judgement words there
  call_response        share of cues that are only amen/hallelujah/yes fillers
  asr_conf             mean ASR confidence (music / crowd noise reads low)
  duration_fit         closeness to ~45 s
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


def build_windows(items: list[dict], min_len=20.0, max_len=60.0, end_gap=0.4) -> list[tuple[int, int]]:
    out = []
    n = len(items)
    for i in range(n):
        if i > 0 and items[i]["start"] - items[i - 1]["end"] < 0.25:
            continue  # start on a pause
        for j in range(i, n):
            d = items[j]["end"] - items[i]["start"]
            if d > max_len:
                break
            if d >= min_len:
                gap = items[j + 1]["start"] - items[j]["end"] if j + 1 < n else 9.0
                if gap >= end_gap:
                    out.append((i, j))
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


def score_windows(p: dict, wins: list[list[dict]], lang_default: str, job=None) -> tuple[np.ndarray, np.ndarray, list[dict], dict]:
    """Raw features + embeddings for every window -> ranker scores (z-scored within this sermon)."""
    db, med, thr = sermon_audio(p)
    rows = []
    for k, its in enumerate(wins):
        rows.append(ranker.raw_features(its, lang_default, db if len(db) else None, med, thr, audio.FRAME))
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


def suggest(p: dict, count: int = 8, rng: list | None = None, job=None) -> list[dict]:
    items = sorted([t for t in p.get("transcript", []) if t.get("text")], key=lambda t: t["start"])
    if rng:
        items = [t for t in items if t["start"] >= rng[0] and t["end"] <= rng[1]]
    if len(items) < 3:
        return []
    lang_default = p["language"] if p["language"] != "auto" else "or"
    if p["language"] != "auto":
        items = [dict(t, lang=p["language"]) for t in items]
    wins = build_windows(items)
    if not wins:
        wins = [(0, len(items) - 1)]
    sc, contrib, rows, model = score_windows(p, [items[i:j + 1] for i, j in wins], lang_default, job)
    # house rule: a reel ends on a finished (encouraging) line, never on a setup like "then I ..." / "but ..."
    dangling = np.array([is_dangling(items[j], lang_default) for _, j in wins])
    sc = np.where(dangling, sc * 0.6, sc)
    order = np.argsort(-sc)
    picked: list[int] = []
    for k in order:
        i, j = wins[k]
        s, e = items[i]["start"], items[j]["end"]
        if any(min(e, items[wins[q][1]]["end"]) - max(s, items[wins[q][0]]["start"]) > 0.25 * (e - s) for q in picked):
            continue
        picked.append(int(k))
        if len(picked) >= count:
            break
    out = []
    for rank, k in enumerate(picked):
        i, j = wins[k]
        its = items[i:j + 1]
        langs: dict[str, float] = {}
        for it in its:
            L = it.get("lang", lang_default)
            langs[L] = langs.get(L, 0) + it["end"] - it["start"]
        lang = max(langs, key=langs.get)
        segs = planner.plan(its, p.get("pauses", []), lang)
        rs = ranker.reasons(contrib[k], model)
        out.append({"id": f"s{rank + 1}", "score": round(float(sc[k]), 4), "title": pick_title(its, lang),
                    "segments": segs, "window": [items[i]["start"], items[j]["end"]],
                    "duration": round(sum(b - a for a, b in segs), 2), "reasons": [r["why"] for r in rs],
                    "reason_details": rs, "language": lang,
                    "features": {f: (None if np.isnan(rows[k][f]) else round(float(rows[k][f]), 4)) for f in ranker.RAW},
                    "model": model.get("kind")})
    return out


def pick_title(items: list[dict], lang: str) -> str:
    """Hook title (<= 6 words + "!" / "?") from the window's lines - see brain/hooks.py."""
    from . import hooks
    return hooks.hook(items, lang)["title"] or T.short_title(items[-1]["text"])


def window_features(p: dict, segments: list, lang: str) -> dict:
    """Raw ranker features + text for an arbitrary reel (its segments' transcript) - used to label feedback."""
    items = sorted([t for t in p.get("transcript", []) if any(t["start"] < e and t["end"] > s for s, e in segments)],
                   key=lambda t: t["start"])
    if not items:
        return {}
    db, med, thr = sermon_audio(p)
    f = ranker.raw_features(items, lang, db if len(db) else None, med, thr, audio.FRAME)
    return {k: (None if np.isnan(v) else v) for k, v in f.items()} | {"_text": window_text(items)}
