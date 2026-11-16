"""Jump-cut planner: inside a chosen window, drop filler / repeats / call-and-response and cut only
inside measured pauses (>= 0.25 s). -> segments [[s, e], ...] in absolute source seconds.

Rules
  - a cue that is only amen / hallelujah / yes / ok (lexicon call_response), or < 0.8 s with <= 2 words, is filler
  - a cue whose word set overlaps the previous kept cue by > 60 % (Jaccard) is a repeat (the first is kept)
  - the first and last cue are always kept (hook + punchline)
  - a cue is dropped only if both of its edges sit in a pause >= 0.25 s, so every cut lands in silence
  - segment edges are snapped into the pause (0.12 s of air kept), the result is capped at 60 s
"""
from __future__ import annotations

from . import text as T

MIN_PAUSE = 0.25
AIR = 0.12
MAX_LEN = 60.0


def _pause_at(t: float, pauses: list, tol: float = 0.2):
    for a, b in pauses:
        if b - a >= MIN_PAUSE and a - tol <= t <= b + tol:
            return a, b
    return None


def _jaccard(a: str, b: str) -> float:
    x, y = set(T.tokens(a)), set(T.tokens(b))
    return len(x & y) / max(len(x | y), 1)


def plan(items: list[dict], pauses: list, lang: str) -> list[list[float]]:
    from .clipfinder import is_filler
    if not items:
        return []
    pz = [p for p in pauses if items[0]["start"] - 2 <= p[0] <= items[-1]["end"] + 2]
    keep = [True] * len(items)
    last_kept = None
    for k, it in enumerate(items):
        if k in (0, len(items) - 1):
            last_kept = it
            continue
        dur = it["end"] - it["start"]
        drop = is_filler(it["text"], lang) or (dur < 0.8 and len(T.tokens(it["text"])) <= 2)
        if not drop and last_kept is not None and _jaccard(it["text"], last_kept["text"]) > 0.6:
            drop = True
        if drop and _pause_at(it["start"], pz) and _pause_at(it["end"], pz):
            keep[k] = False
        else:
            last_kept = it
    segs: list[list[float]] = []
    k = 0
    while k < len(items):
        if not keep[k]:
            k += 1
            continue
        j = k
        while j + 1 < len(items) and keep[j + 1]:
            j += 1
        s, e = items[k]["start"], items[j]["end"]
        ps, pe = _pause_at(s, pz), _pause_at(e, pz)
        if ps:
            s = max(ps[0], ps[1] - AIR)
        if pe:
            e = min(pe[1], pe[0] + AIR)
        segs.append([round(s, 3), round(e, 3)])
        k = j + 1
    # cap length: drop leading segments first (keep the punchline), then trim the first at a pause
    while sum(b - a for a, b in segs) > MAX_LEN and len(segs) > 1:
        segs.pop(0)
    if segs and segs[0][1] - segs[0][0] > MAX_LEN:
        e = segs[0][1]
        cands = [p for p in pz if p[1] >= e - MAX_LEN and p[1] < e - 5]
        segs[0][0] = round(max(cands[0][0], cands[0][1] - AIR), 3) if cands else round(e - MAX_LEN, 3)
    # merge segments separated by less than a frame
    out: list[list[float]] = []
    for s, e in segs:
        if out and s - out[-1][1] < 0.05:
            out[-1][1] = e
        else:
            out.append([s, e])
    return out
