"""Cutaway planner (SKILL.md "Choosing cutaways") + image choice by meaning.

Plan
- ~6-8 cutaways per 50 s reel (scaled to the reel length), 3-5 s each, target 50-60 % coverage.
- Cut points sit in speech pauses: every caption boundary is snapped to the centre of the nearest pause in the
  reel's own voice track (frames below the speech threshold), never mid-word.
- The speaker stays on screen for the 0-4.2 s title hook, the closing line, and up to 3 emphasis lines / rhetorical
  questions (question words or "?", or loud lines carrying a victory / hope word).
- Any gap back to the speaker is >= 0.75 s; otherwise neighbouring cutaways share the cut point (image->image).
- Covering a jump-cut join earns a bonus (the picture hides the jump).
- Moves alternate push-in (z 1.12->1.22) / pull-out (1.22->1.12); pans stay within 80 source px.

Image choice
- e5 cosine between "query: <caption text of the span>" (Odia / Hindi / English) and each library image's
  "passage: <desc>" (library.describe: desc or slug words), hub-corrected: an image's mean/std similarity over the
  sermon's transcript cues is subtracted/divided out (otherwise generic images like "believers serving" win everywhere).
- + concept bonus: concepts.json maps ~900 spoken Odia / Hindi / English words (stems, ASR spellings) to English
  library tags; an image whose desc words show a concept the caption names gets +1.6 (+0.4 per extra concept), and
  when the library can show it, images showing none of the named concepts get -0.8 (e5's Odia/Hindi similarity is
  noisy, the spoken word is the stronger signal); + same-set bonus for images from the set the reel already uses;
  an image is used once per reel.
- Below the threshold (settings.cutaway_match_threshold, Odia stricter: e5's Odia is weaker) the cutaway carries a
  generation request `need = {prompt, slug, scene, text, tags}` instead of an image (img = None) for the app's
  AI Studio window; POST /reels/{id}/cutaways/{i}/image attaches the captured picture.
"""
from __future__ import annotations

import heapq
import re
from pathlib import Path

import numpy as np

from .. import config, library
from . import text as T

HOOK = 4.2          # title hook on screen 0.2-4.2 s
HOOK_MIN = 4.0      # first cutaway may start at 4.0 s (rule: speaker for the 0-4 s hook)
MIN_LEN, MAX_LEN = 3.0, 5.0
MIN_GAP = 0.75
COVER_LO, COVER_HI = 0.50, 0.60
PANS = [[0, 0], [50, -60], [-50, 0], [0, -80], [40, 40], [-40, 60], [0, 0], [30, -40]]
QUESTION = {
    "or": ["କଣ", "କ'ଣ", "କାହିଁକି", "କିପରି", "କେମିତି", "କିଏ", "କେବେ", "କେଉଁ", "କାହାକୁ"],
    "hi": ["क्या", "क्यों", "कैसे", "कौन", "कब", "किसको", "किसने"],
    "en": ["what", "why", "how", "who", "when", "which"],
}
GRADES = {"dark": "moody low-key blue-grey grade", "hope": "warm golden-hour grade",
          "neutral": "soft natural daylight grade"}
LANG_NAME = {"or": "Odia", "hi": "Hindi", "en": "English"}
CONCEPT_BONUS = 1.6   # image shows a concept the caption names (concepts.json)
CONCEPT_EXTRA = 0.4   # ... per further concept it shows (max 3 counted)
OFF_CONCEPT = 0.8     # caption names a concept the library can show, but this image shows none of them


# ------------------------------------------------------------- helpers --
def concept_groups(text: str, lang: str) -> list[dict]:
    """concepts.json rows whose spoken words (the caption's language + English loanwords) occur in `text`."""
    return [c for c in T.concepts() if T.count_hits(text, c.get(lang, []) + c.get("en", []))]


def concept_tags(text: str, lang: str) -> list[str]:
    return list(dict.fromkeys(t for c in concept_groups(text, lang) for t in c["tags"]))


def _stem(w: str) -> str:
    return w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w


def tag_hits(tag: str, words: set[str]) -> bool:
    """A library tag hits an image when every word of the tag is among the image's (stemmed) words:
    "fallen angel" needs both, so "angel music" is not a Satan picture."""
    return all(_stem(p) in words for p in tag.lower().split())


def thresholds(lang: str) -> float:
    st = config.settings()
    base = float(st.get("cutaway_match_threshold", 1.3))
    return base + (0.4 if lang == "or" else 0.0)


def voice_pauses(wav16: np.ndarray | None) -> list[tuple[float, float]]:
    from ..media import audio
    if wav16 is None or not len(wav16):
        return []
    db = audio.frame_db(wav16)
    thr = audio.threshold(db)
    quiet = db < thr
    out, k = [], 0
    while k < len(quiet):
        if quiet[k]:
            j = k
            while j < len(quiet) and quiet[j]:
                j += 1
            if (j - k) * audio.FRAME >= 0.12:
                out.append((k * audio.FRAME, j * audio.FRAME))
            k = j
        else:
            k += 1
    return out


def caption_energy(caps: list[dict], wav16: np.ndarray | None) -> list[float]:
    from ..media import audio
    if wav16 is None or not len(wav16):
        return [0.0] * len(caps)
    db = audio.frame_db(wav16)
    thr = audio.threshold(db)
    out = []
    for c in caps:
        seg = db[int(c["t0"] / audio.FRAME):int(c["t1"] / audio.FRAME)]
        v = seg[seg > thr]
        out.append(float(v.mean()) if len(v) else -99.0)
    return out


def snap_boundaries(caps: list[dict], pauses: list[tuple[float, float]], dur: float) -> list[float]:
    """Cut points: 0, every caption boundary snapped into the nearest pause (<= 0.35 s away), dur."""
    pts = [0.0]
    for a, b in zip(caps, caps[1:]):
        t = (a["t1"] + b["t0"]) / 2
        best = None
        for p0, p1 in pauses:
            c = (p0 + p1) / 2
            if p0 - 0.35 <= t <= p1 + 0.35 and (best is None or abs(c - t) < abs(best - t)):
                best = c
        pts.append(round(best if best is not None else t, 3))
    pts.append(round(dur, 3))
    return sorted(set(pts))


def protected_spans(caps: list[dict], energy: list[float], lang: str, dur: float) -> list[tuple[float, float, str]]:
    """Where the speaker must stay on screen: hook, closing line, <= 3 emphasis / question lines."""
    out = [(0.0, HOOK, "title hook")]
    if caps:
        out.append((caps[-1]["t0"], dur, "closing line"))
    qw = QUESTION.get(lang, []) + QUESTION["en"]
    ev = [e for e in energy if e > -90]
    loud = np.percentile(ev, 80) if ev else 99
    cands = []
    for c, e in zip(caps[:-1], energy[:-1]):
        if c["t1"] <= HOOK:
            continue
        score = 0.0
        why = ""
        if "?" in c["text"] or T.count_hits(c["text"], qw):
            score, why = 1.0 + max(0.0, e - loud) / 10, "rhetorical question"
        if e >= loud and (T.lex_hits(c["text"], "victory", lang) or T.lex_hits(c["text"], "hope_end", lang)
                          or "!" in c["text"]):
            score, why = max(score, 1.2 + (e - loud) / 10), "emphasis"
        if score:
            cands.append((score, c["t0"], c["t1"], why))
    cands.sort(reverse=True)
    for _, a, b, why in cands[:3]:
        out.append((a, b, why))
    return out


# ------------------------------------------------------------- matching --
class Matcher:
    """Caption text -> ranked library images (hub-corrected e5 similarity + concept / set bonuses)."""

    def __init__(self, ref_texts: list[str], lang: str):
        from . import embed
        self.lang = lang
        self.items = library.items()
        self.ok = bool(self.items) and embed.available()
        if not self.ok:
            return
        self.V = library.embeddings(self.items)
        ref = [t for t in ref_texts if t and len(t) > 3][:400]
        if len(ref) < 20:
            ref += [it["desc"] for it in self.items][:60]
        R = embed.embed_texts(ref, "query: ") @ self.V.T
        self.mu, self.sd = R.mean(0), np.maximum(R.std(0), 1e-4)
        # concept bonus uses the image's own words (desc / slug), not its folder words: every picture in a
        # "6-satan-defeated" folder would otherwise count as a "satan" picture
        self.tags = [{_stem(w) for w in library.words(it["desc"])} for it in self.items]

    def concept_hits(self, text: str) -> list[list[str]]:
        """-> per library image, the names of the caption's concepts that the image's words show."""
        groups = concept_groups(text, self.lang)
        return [[g.get("name", g["tags"][0]) for g in groups if any(tag_hits(t, w) for t in g["tags"])]
                for w in self.tags]

    def rank(self, text: str, exclude: set[str], prefer_set: str | None) -> list[tuple[float, int, dict]]:
        """score = hub-corrected e5 z + concept bonus (+ same-set bonus). When the caption names a picturable
        concept that some library image shows, images showing it get +CONCEPT_BONUS (+ a little per extra
        concept) and images showing none of them get -OFF_CONCEPT: e5's Odia/Hindi similarity is noisy
        (an Odia "final defeat" line sat at z 2.8 for "youth lost"), the spoken word is the stronger signal."""
        from . import embed
        if not self.ok:
            return []
        q = embed.embed_texts([text], "query: ")[0]
        z = (self.V @ q - self.mu) / self.sd
        hits = self.concept_hits(text)
        avail = any(hits)
        out = []
        for k, it in enumerate(self.items):
            if it["id"] in exclude:
                continue
            h = len(hits[k])
            bonus = CONCEPT_BONUS + CONCEPT_EXTRA * (min(h, 3) - 1) if h else (-OFF_CONCEPT if avail else 0.0)
            same = bool(prefer_set and it["set"] == prefer_set)
            if same:
                bonus += 0.4
            info = {"z": round(float(z[k]), 2), "concept": bool(h), "same_set": same}
            if h:
                info["concepts"] = hits[k]
            out.append((float(z[k]) + bonus, k, info))
        out.sort(key=lambda x: -x[0])
        return out[:5]


def need_request(text: str, lang: str, idx: int, tags: list[str]) -> dict:
    neg = T.lex_hits(text, "enemy", lang) + T.lex_hits(text, "negative_end", lang)
    pos = T.lex_hits(text, "victory", lang) + T.lex_hits(text, "hope_end", lang)
    dark_tags = {"satan", "darkness", "dark", "shadow", "storm", "despair", "serpent", "fire", "battle", "sin"}
    neg += 2 * len(dark_tags & set(tags))
    grade = GRADES["dark" if neg > pos else "hope" if pos else "neutral"]
    what = (", ".join(tags[:5]) + " - ") if tags else ""
    scene = (f"{what}a respectful scene that a viewer can picture for this {LANG_NAME.get(lang, lang)} sermon line: "
             f"“{text.strip()}”. Indian people and places, no gore.")
    # AI Studio / Gemini has no negative prompt and tends to ignore "no X": describe the people positively
    prompt = (f"VERTICAL 9:16 portrait. Photorealistic cinematic still, India, {grade}, shallow depth of field, "
              f"soft film grain, no text, no readable words. The people are Indian Christians with clean, plain, "
              f"unmarked foreheads and simple everyday clothes; the setting is a home, village, field or simple "
              f"church, never a temple or shrine; nothing from other religions. SCENE: {scene}")
    slug = f"{idx + 1:02d}-" + ("-".join(re.sub(r"[^a-z0-9]+", "", t.lower()) for t in tags[:2]) if tags else "scene")
    return {"prompt": prompt, "slug": slug, "scene": scene, "text": text.strip(), "tags": tags[:6], "grade": grade}


# ---------------------------------------------------------------- plan --
def plan(captions: list[dict], dur: float, lang: str, jumps: list[float] | None = None,
         wav16: np.ndarray | None = None, ref_texts: list[str] | None = None, library: bool = True) -> list[dict]:
    """library=False (Automate "Illustrations: Gemini"): the same moments are chosen, but none is filled from the
    picture library - every cutaway becomes a `need` request for a new AI image."""
    caps = sorted([c for c in captions if c.get("text", "").strip()], key=lambda c: c["t0"])
    if len(caps) < 3 or dur < 10:
        return []
    jumps = jumps or []
    energy = caption_energy(caps, wav16)
    pts = snap_boundaries(caps, voice_pauses(wav16), dur)
    prot = protected_spans(caps, energy, lang, dur)
    thr = thresholds(lang)
    max_n = int(np.clip(round(8 * dur / 50), 2, 8))
    target_lo, target_hi = COVER_LO * dur, COVER_HI * dur
    M = Matcher(ref_texts or [c["text"] for c in caps], lang)

    def blocked(a, b):
        # captions carry ~0.15 s ASR padding each side, so a protected line may poke 0.35 s past its cut point
        return any(min(b, p1) - max(a, p0) > 0.35 for p0, p1, _ in prot)

    def span_text(a, b, lead=0.0):
        return " ".join(c["text"] for c in caps if min(b, c["t1"]) - max(a - lead, c["t0"]) > 0.3 * (c["t1"] - c["t0"]))

    def candidates(lo, hi):
        out = []
        for i, a in enumerate(pts):
            for b in pts[i + 1:]:
                L = b - a
                if L < lo:
                    continue
                if L > hi:
                    break
                if a < HOOK_MIN or blocked(a, b):
                    continue
                txt = span_text(a, b)
                if len(txt) < 4:
                    continue
                ctx = span_text(a, b, lead=2.0)   # the line just before often names the picture
                out.append([a, b, txt, ctx])
        return out

    picked: list[dict] = []
    used: set[str] = set()

    def fits(a, b):
        for c in picked:
            if min(b, c["t1"]) - max(a, c["t0"]) > 1e-3:
                return False
            gap = a - c["t1"] if a >= c["t1"] else c["t0"] - b
            if 1e-3 < gap < MIN_GAP:
                return False
        return True

    def evaluate(a, b, txt, ctx):
        sets = [it.get("set") for it in picked if it.get("lib_set")]
        prefer = max(set(sets), key=sets.count) if sets else None
        r = M.rank(txt, used, prefer)
        if ctx != txt:
            r = sorted(r + [(s_ - 0.15, k_, d_) for s_, k_, d_ in M.rank(ctx, used, prefer)], key=lambda x: -x[0])
        # good = the embedding agrees strongly enough, or a concept word names the picture and the embedding
        # doesn't disagree (e5 misses e.g. "लुसीफर" -> "fallen angel")
        oks = [x for x in r if x[2]["z"] + (0.4 if x[2]["same_set"] else 0) >= thr
               or (x[2]["concept"] and x[2]["z"] >= -0.5)]
        best = oks[0] if oks else (r[0] if r else None)
        good = bool(oks)
        hides_join = any(a + 0.2 < j < b - 0.2 for j in jumps)
        L = b - a
        # prefer library matches, then longer spans (coverage), then joins hidden
        s = (max(best[0], thr) if good else -1.0) + 0.15 * L + (0.3 if hides_join else 0.0)
        return s, best, good

    covered = 0.0
    # pass 1 = house lengths 3-5 s; pass 2 (only if still under 50 %) relaxes to 2.5-5.5 s
    for lo, hi in ((MIN_LEN, MAX_LEN), (2.5, 5.5)):
        if covered >= target_lo or len(picked) >= max_n:
            break
        cands = candidates(lo, hi)
        # lazy greedy: re-evaluate the popped candidate against the current picks (repeats / same set)
        heap = []
        for k, (a, b, txt, ctx) in enumerate(cands):
            s, _, _ = evaluate(a, b, txt, ctx)
            heapq.heappush(heap, (-s, k))
        while heap and len(picked) < max_n and covered < target_lo:
            negs, k = heapq.heappop(heap)
            a, b, txt, ctx = cands[k]
            if not fits(a, b) or covered + (b - a) > target_hi + 0.5:
                continue
            s, best, good = evaluate(a, b, txt, ctx)
            if heap and s < -heap[0][0] - 1e-6:
                heapq.heappush(heap, (-s, k))
                continue
            item = {"t0": round(a, 3), "t1": round(b, 3), "text": txt}
            if good and library:
                it = M.items[best[1]]
                used.add(it["id"])
                item.update({"img": it["path"], "lib_id": it["id"], "set": it["set"], "lib_set": True,
                             "why": {"match": round(best[0], 2), **best[2], "desc": it["desc"]}})
            else:
                tags = concept_tags(txt, lang)
                item.update({"img": None, "lib_id": None, "need": None, "_tags": tags,
                             "why": {"match": round(best[0], 2) if best else None, "threshold": thr,
                                     "nearest": M.items[best[1]]["desc"] if best else None}})
            picked.append(item)
            covered += b - a
    picked.sort(key=lambda c: c["t0"])
    out = []
    for i, c in enumerate(picked):
        zin = i % 2 == 0
        it = {"t0": c["t0"], "t1": c["t1"], "img": c["img"], "lib_id": c["lib_id"],
              "z0": 1.12 if zin else 1.22, "z1": 1.22 if zin else 1.12, "pan": PANS[i % len(PANS)],
              "text": c["text"], "why": c["why"]}
        if c["img"] is None:
            it["need"] = need_request(c["text"], lang, i, c.get("_tags") or [])
        out.append(it)
    return out


def coverage(cutaways: list[dict], dur: float, filled_only: bool = False) -> float:
    cs = [c for c in cutaways if not filled_only or (c.get("img") and Path(c["img"]).exists())]
    return round(sum(c["t1"] - c["t0"] for c in cs) / max(dur, 1e-3), 3)


def check(cutaways: list[dict], dur: float) -> list[str]:
    """House-rule assertions (used by tests / QC): gaps, lengths, hook, pans."""
    errs = []
    prev = 0.0
    for c in sorted(cutaways, key=lambda c: c["t0"]):
        g = c["t0"] - prev
        if 1e-3 < g < MIN_GAP and prev > 0:
            errs.append(f"speaker flash {g:.2f}s before {c['t0']}")
        if c["t0"] < HOOK_MIN - 1e-3:
            errs.append(f"cutaway {c['t0']} inside the title hook")
        if not (2.5 - 0.01 <= c["t1"] - c["t0"] <= 5.5 + 0.01):
            errs.append(f"cutaway {c['t0']}-{c['t1']} length {c['t1'] - c['t0']:.2f}")
        if max(abs(v) for v in c.get("pan", [0, 0])) > 80:
            errs.append(f"pan too large at {c['t0']}")
        prev = c["t1"]
    return errs
