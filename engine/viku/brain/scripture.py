"""Verse detection + scripture-card placement.

find_refs(text): a book name (English or native, from the offline Bible) followed within ~30 chars by
chapter and verse numbers (ASCII / Odia / Devanagari digits; "ଅଧ୍ୟାୟ", "ପଦ", "अध्याय", "पद", "chapter",
"verse" may sit between them). Only explicit references are detected in v1 - paraphrased verses
still need the editor (or Phase 3 semantic matching against the Bible index).
place_verses(): a card shows only during a cutaway (never over the speaker's face) - the cutaway that
overlaps the caption, or the next one starting within 8 s. Text from the offline IRV / WEB.
"""
from __future__ import annotations

import re

from .. import bible

NUM = re.compile(r"(\d{1,3})\D{0,14}?(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?")


def find_refs(text: str) -> list[str]:
    t = bible.norm(text)
    out = []
    for name, code in bible.book_names():
        if len(name) < 3:
            continue
        i = t.find(name)
        while i >= 0:
            before_ok = i == 0 or not t[i - 1].isalnum()
            m = NUM.search(t[i + len(name): i + len(name) + 32])
            if before_ok and m:
                ref = f"{bible.BOOK_EN[code]} {m.group(1)}:{m.group(2)}" + (f"-{m.group(3)}" if m.group(3) else "")
                if ref not in out:
                    out.append(ref)
            i = t.find(name, i + 1)
    return out


def place_verses(captions: list[dict], cutaways: list[dict], lang: str) -> list[dict]:
    if lang not in bible.TRANSLATIONS or not bible.db_path(lang).exists() or not cutaways:
        return []
    cuts = sorted(cutaways, key=lambda c: c["t0"])
    used: set[int] = set()
    out = []
    for c in captions:
        for ref in find_refs(c["text"]):
            k = next((i for i, cu in enumerate(cuts) if i not in used and
                      (cu["t0"] <= c["t1"] and cu["t1"] >= c["t0"] or 0 <= cu["t0"] - c["t0"] <= 8)), None)
            if k is None:
                continue
            try:
                v = bible.verse(ref, lang)
            except Exception:  # noqa: BLE001
                continue
            used.add(k)
            cu = cuts[k]
            txt = v["text"]
            if len(txt) > 170:
                cut = max(txt.rfind(x, 0, 170) for x in ("।", ";", ",", " "))
                txt = txt[:cut if cut > 60 else 170].rstrip(" ,;") + " …"
            out.append({"t0": round(cu["t0"] + 0.3, 3), "t1": round(cu["t1"] - 0.3, 3), "text": txt,
                        "ref": v["display_ref"], "top_y": 0, "attribution": v["attribution"]})
    return out
