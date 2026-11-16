"""Step 1: cut each sermon into 20-60 s windows (boundaries only at pauses >= 0.6 s),
choose the text per language, and write tools/work/windows_base.jsonl (no labels yet)
plus a judging sheet per sermon (tools/work/sheet_<sermon>.txt).

Run:  python build_windows.py
"""
import json
from seedlib import SEED, HERE, load_cues, cue_lang

WORK = HERE / "work"
WORK.mkdir(exist_ok=True)

GAP = 0.6          # a window may only start/end at a pause this long
STRIDE = 10.0      # seconds between window starts
MIN_D, MAX_D = 20.0, 60.0
TARGETS = (28.0, 48.0)  # two lengths per start (short + long)

# sermon portion (absolute seconds). BTF cues start at the notices before the sermon
# and run through the closing prayer; Salvation SRT is the whole service video.
RANGES = {"btf": (2880.0, 8200.0), "salvation": (0.0, 5260.0)}

# Extra windows that must exist exactly (user-made reels; jump-cut segments too).
from user_labels import USER_RANGES  # noqa: E402


def hindi_for_cue(hi_cues, a, b):
    if not hi_cues:
        return None
    parts = []
    for c in hi_cues:
        if c[1] <= a or c[0] >= b:
            continue
        ov = min(b, c[1]) - max(a, c[0])
        if ov >= 0.5 * (c[1] - c[0]):  # assign each Hindi cue to the Odia cue it mostly sits in
            parts.append(c[2])
    return " ".join(parts)


def annotate(sermon):
    or_c, hi_c = load_cues(sermon)
    lo, hi = RANGES[sermon]
    cues = []
    for c in or_c:
        if c[0] < lo or c[1] > hi or not c[2].strip():
            continue
        h = hindi_for_cue(hi_c, c[0], c[1])
        lang = cue_lang(c[2], h)
        cues.append({"s": c[0], "e": c[1], "or": c[2].strip(), "hi": (h or "").strip(), "lang": lang})
    # smooth isolated single-cue flips (short cues are noisy)
    for i in range(1, len(cues) - 1):
        p, n = cues[i - 1]["lang"], cues[i + 1]["lang"]
        if p == n != cues[i]["lang"] and cues[i]["e"] - cues[i]["s"] < 3.0:
            cues[i]["lang"] = p
    return cues


def window_from(cues, i, j, sermon):
    seg = cues[i:j + 1]
    s, e = seg[0]["s"], seg[-1]["e"]
    dur_hi = sum(c["e"] - c["s"] for c in seg if c["lang"] == "hi")
    dur_all = sum(c["e"] - c["s"] for c in seg) or 1.0
    frac = dur_hi / dur_all
    lang = "hi" if frac >= 0.7 else ("or" if frac <= 0.3 else "mixed")
    parts = []
    for c in seg:
        use_hi = c["lang"] == "hi" and c["hi"]
        parts.append(c["hi"] if use_hi else c["or"])
    return {"sermon": sermon, "start": round(s, 2), "end": round(e, 2), "lang": lang,
            "hi_frac": round(frac, 2), "text": " ".join(parts),
            "text_or": " ".join(c["or"] for c in seg),
            "text_hi_asr": " ".join(c["hi"] for c in seg if c["hi"]) if sermon == "btf" else None}


def build(sermon):
    cues = annotate(sermon)
    # indices that may start a window: first cue, or a cue preceded by a pause >= GAP
    starts = [0] + [k for k in range(1, len(cues)) if cues[k]["s"] - cues[k - 1]["e"] >= GAP]
    ends = set(k - 1 for k in starts if k > 0) | {len(cues) - 1}
    wins, last = [], -1e9
    for i in starts:
        if cues[i]["s"] - last < STRIDE:
            continue
        cands = []
        for j in range(i, len(cues)):
            d = cues[j]["e"] - cues[i]["s"]
            if d > MAX_D:
                break
            if j in ends and d >= MIN_D:
                cands.append((j, d))
        if not cands:
            continue
        picked = sorted({min(cands, key=lambda x: abs(x[1] - t))[0] for t in TARGETS})
        for j in picked:
            wins.append(window_from(cues, i, j, sermon))
        last = cues[i]["s"]
    # exact user ranges (whole reels and jump-cut segments)
    for r in USER_RANGES:
        if r["sermon"] != sermon:
            continue
        a, b = r["start"], r["end"]
        ii = [k for k, c in enumerate(cues) if c["e"] > a + 0.3 and c["s"] < b - 0.3]
        if not ii:
            continue
        w = window_from(cues, ii[0], ii[-1], sermon)
        w["start"], w["end"] = a, b
        w["user_reel"] = r["name"]
        wins.append(w)
    wins.sort(key=lambda w: (w["start"], w["end"]))
    return cues, wins


def main():
    allw = []
    for sermon in RANGES:
        cues, wins = build(sermon)
        (WORK / f"cues_{sermon}.json").write_text(json.dumps(cues, ensure_ascii=False), encoding="utf-8")
        allw += wins
        # judging sheet: cue-level, grouped into ~15 s blocks with times
        lines, blk, bs = [], [], None
        for c in cues:
            if bs is None:
                bs = c["s"]
            t = c["hi"] if (c["lang"] == "hi" and c["hi"]) else c["or"]
            blk.append(("[H] " if c["lang"] == "hi" else "") + t)
            if c["e"] - bs >= 15:
                lines.append(f"{bs:7.1f}-{c['e']:7.1f} | " + " / ".join(blk))
                blk, bs = [], None
        if blk:
            lines.append(f"{bs:7.1f}-{cues[-1]['e']:7.1f} | " + " / ".join(blk))
        (WORK / f"sheet_{sermon}.txt").write_text("\n".join(lines), encoding="utf-8")
        print(sermon, "cues", len(cues), "windows", len(wins), "sheet lines", len(lines))
    with open(WORK / "windows_base.jsonl", "w", encoding="utf-8") as f:
        for w in allw:
            f.write(json.dumps(w, ensure_ascii=False) + "\n")
    print("total windows", len(allw))


if __name__ == "__main__":
    main()
