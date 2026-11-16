"""Cutaway planner: picturable caption lines -> library illustrations, house rules from the skill.

- speaker stays on screen for the 4.2 s title hook and the closing line
- cutaways start/end on caption edges (which sit in pauses), 3-5 s each, ~50-60 % coverage, at most 8
- any gap back to the speaker is >= 0.75 s, otherwise the two share the cut point
- picks come from concepts.json (spoken word -> English library tags) + library keyword search;
  an image is used once per reel; lines with no match stay on the speaker
- moves alternate push-in z 1.12->1.22 / pull-out 1.22->1.12, |pan| <= 80 source px
"""
from __future__ import annotations

from .. import library
from . import text as T

PANS = [[0, 0], [50, -60], [-50, 0], [0, -80], [40, 40], [-40, 60], [0, 0], [30, -40]]
MIN_LEN, MAX_LEN, MAX_N, COVER = 3.0, 5.0, 8, 0.6
HOOK = 4.4


def concept_tags(text: str, lang: str) -> list[str]:
    tags = []
    for c in T.concepts():
        words = c.get(lang, []) + c.get("en", [])
        if T.count_hits(text, words):
            tags += c["tags"]
    return tags


def plan(captions: list[dict], dur: float, lang: str) -> list[dict]:
    if not captions or dur < 8:
        return []
    caps = sorted(captions, key=lambda c: c["t0"])
    closing_t0 = caps[-1]["t0"]
    used: set[str] = set()
    out: list[dict] = []
    covered = 0.0
    k = 0
    while k < len(caps) and len(out) < MAX_N and covered < COVER * dur:
        c = caps[k]
        if c["t0"] < HOOK or c["t0"] >= closing_t0:
            k += 1
            continue
        tags = concept_tags(c["text"], lang)
        if not tags:
            k += 1
            continue
        hits = library.search(" ".join(dict.fromkeys(tags)), limit=5, exclude=used)
        if not hits:
            k += 1
            continue
        # extend over following captions until 3-5 s, never into the closing line
        t0, t1, j = c["t0"], c["t1"], k
        while t1 - t0 < MIN_LEN and j + 1 < len(caps) and caps[j + 1]["t0"] < closing_t0 \
                and caps[j + 1]["t1"] - t0 <= MAX_LEN:
            j += 1
            t1 = caps[j]["t1"]
        if t1 - t0 < 2.0:
            k += 1
            continue
        if t1 - t0 > MAX_LEN:
            t1 = t0 + MAX_LEN
        if out:
            gap = t0 - out[-1]["t1"]
            if gap < 0:
                t0 = out[-1]["t1"]
            elif gap < 0.75:
                t0 = out[-1]["t1"]  # share the cut point (image -> image dissolve)
        t1 = min(t1, closing_t0 - 0.75 if closing_t0 - 0.75 > t0 + 2 else closing_t0)
        if t1 - t0 < 2.0:
            k = j + 1
            continue
        i = len(out)
        zin = i % 3 != 2
        h = hits[0]
        used.add(h["id"])
        out.append({"img": h["path"], "lib_id": h["id"], "t0": round(t0, 3), "t1": round(t1, 3),
                    "z0": 1.12 if zin else 1.22, "z1": 1.22 if zin else 1.12, "pan": PANS[i % len(PANS)],
                    "why": tags[:4]})
        covered += t1 - t0
        k = j + 1
    return out
