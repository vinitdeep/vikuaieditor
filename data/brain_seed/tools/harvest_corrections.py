"""Step 3: harvest ASR -> hand-corrected caption pairs.

Raw ASR (IndicConformer) for each reel's time range is aligned word-by-word (difflib)
with the hand-corrected caption cues in the spec files. Small 'replace' opcodes that
look like genuine corrections are kept. Output: work/corrections_raw.jsonl with counts
and examples; the curated list is ../caption_corrections.jsonl (see curate step).
"""
import difflib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from seedlib import AIVE, BTF_WORK, SALV_SRT, load_srt, HERE

SPECS = AIVE / "specs"
PUNCT = re.compile(r"[\s—–…,.!?;:\"'“”‘’()\[\]|।॥\-]+")
ZW = re.compile(r"[‌‍﻿]")


def norm_tokens(text):
    text = unicodedata.normalize("NFC", ZW.sub("", text))
    return [t for t in PUNCT.split(text) if t]


def raw_in(cues, a, b):
    return " ".join(c[2] for c in cues if c[1] > a + 0.2 and c[0] < b - 0.2)


def jobs():
    or_abs = json.loads((BTF_WORK / "cues_abs.json").read_text(encoding="utf-8"))
    hi_abs = json.loads((BTF_WORK / "cues_hi_abs.json").read_text(encoding="utf-8"))
    salv = load_srt(SALV_SRT)
    for f in sorted((SPECS / "btf").glob("*.json")) + sorted((SPECS / "btf" / "_superseded").glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        name = f.stem
        lang = "hi" if name.startswith("hi-") else "or"
        if name.endswith(".jc"):
            base = name[:-3]
            srt = BTF_WORK / "jc" / f"{base}.src.{lang}.srt"
            if not srt.exists():
                continue
            raw = load_srt(srt)
            for c in d["cues_reel"]:
                yield lang, name, raw_in(raw, c[0], c[1]), c[2]
            continue  # (the abs-time spec twin is skipped below; jc raw ASR is the clip re-transcription)
        if "segments" in d and d.get("start") == 0.0:
            continue  # reel-relative render spec; the .jc.json twin is used instead
        if "cues" not in d or not d["cues"]:
            continue
        src = hi_abs if lang == "hi" else or_abs
        for c in d["cues"]:
            yield lang, name, raw_in(src, c[0], c[1]), c[2]
    for f in sorted(SPECS.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        for c in d["cues"]:
            yield "or", f.stem, raw_in(salv, c[0], c[1]), c[2]


def main():
    pairs = Counter()
    where = defaultdict(set)
    n_cues = 0
    for lang, reel, raw, fixed in jobs():
        n_cues += 1
        a, b = norm_tokens(raw), norm_tokens(fixed)
        sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
        for op, i1, i2, j1, j2 in sm.get_opcodes():
            if op != "replace":
                continue
            w, r = a[i1:i2], b[j1:j2]
            if len(w) > 3 or len(r) > 3:
                continue
            ws, rs = " ".join(w), " ".join(r)
            if ws == rs:
                continue
            sim = difflib.SequenceMatcher(None, ws.replace(" ", ""), rs.replace(" ", "")).ratio()
            if sim < (0.25 if len(w) == len(r) == 1 else 0.34):
                continue
            pairs[(lang, ws, rs)] += 1
            where[(lang, ws, rs)].add(reel)
    out = HERE / "work" / "corrections_raw.jsonl"
    with open(out, "w", encoding="utf-8") as f:
        for (lang, w, r), n in pairs.most_common():
            f.write(json.dumps({"lang": lang, "wrong": w, "right": r, "n": n,
                                "reels": sorted(where[(lang, w, r)])}, ensure_ascii=False) + "\n")
    print("cues aligned", n_cues, "candidate pairs", len(pairs), "->", out)


if __name__ == "__main__":
    main()
