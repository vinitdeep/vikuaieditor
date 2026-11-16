"""Step 2: label every window -> ../windows.jsonl

Order of precedence
  1. source=user     window IS a user-made reel range (or one jump-cut segment of it)
  2. source=derived  window overlaps a user-verdict range by >= 60 % of its own length
  3. source=judged   time-weighted mean of the hand-judged span scores (work/spans_*.json,
                     contiguous spans scored 0/0.3/0.6/0.9 by reading the transcript),
                     snapped to {0, 0.3, 0.6, 0.9}; capped at 0.3 if the window's last
                     8 s fall in a 0.0 span (does not end on a declaration).
"""
import json
from collections import Counter

from seedlib import HERE, SEED
from user_labels import USER_RANGES

WORK = HERE / "work"
LEVELS = (0.0, 0.3, 0.6, 0.9)


def load_spans(sermon):
    spans = []
    for f in sorted(WORK.glob(f"spans_{sermon}_*.json")):
        spans += json.loads(f.read_text(encoding="utf-8"))
    spans.sort(key=lambda s: s["start"])
    return spans


def ov(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def judge(w, spans):
    a, b = w["start"], w["end"]
    dur = b - a
    hits = [(ov(a, b, s["start"], s["end"]), s) for s in spans]
    hits = [h for h in hits if h[0] > 0]
    if not hits:
        return None
    covered = sum(h[0] for h in hits)
    m = sum(h[0] * h[1]["score"] for h in hits) / covered
    label = min(LEVELS, key=lambda x: abs(x - m))
    # dominant strong span: >= 50 % of the window in a 0.9 span keeps it at 0.9
    if any(h[1]["score"] >= 0.9 and h[0] >= 0.5 * dur for h in hits):
        label = 0.9
    tail = [s for s in spans if ov(b - 8.0, b, s["start"], s["end"]) > 4.0]
    reasons, tags = [], []
    for o, s in sorted(hits, key=lambda h: -h[0]):
        for r in s.get("reasons", []):
            if r not in reasons and len(reasons) < 3:
                reasons.append(r)
        for t in s.get("tags", []):
            if t not in tags:
                tags.append(t)
    if tail and tail[-1]["score"] == 0.0 and label > 0.3:
        label = 0.3
        why = "fear/judgement" if "fear_judgement" in tail[-1].get("tags", []) else ",".join(tail[-1].get("tags", [])[:2])
        reasons = reasons[:3] + [f"ends badly ({why})"]
    return label, reasons[:4], tags, round(m, 3)


def main():
    base = [json.loads(l) for l in open(WORK / "windows_base.jsonl", encoding="utf-8")]
    spans = {s: load_spans(s) for s in ("btf", "salvation")}
    out = []
    for k, w in enumerate(base):
        a, b = w["start"], w["end"]
        dur = b - a
        j = judge(w, spans[w["sermon"]])
        rec = {"id": f"{w['sermon']}-{a:07.2f}-{b:07.2f}", "sermon": w["sermon"], "start": a, "end": b,
               "lang": w["lang"], "text": w["text"]}
        if w["lang"] != "or" and w.get("text_or"):
            rec["text_or_asr"] = w["text_or"]
        if w.get("user_reel"):
            r = next(r for r in USER_RANGES if r["name"] == w["user_reel"] and r["sermon"] == w["sermon"])
            rec.update(label=r["label"], source="user",
                       reasons=[r["verdict"], f"reel {r['reel']}"] + (j[1][:2] if j else []), user_reel=r["name"])
        else:
            best = max(((ov(a, b, r["start"], r["end"]), r) for r in USER_RANGES if r["sermon"] == w["sermon"]),
                       key=lambda t: t[0], default=(0, None))
            if best[1] is not None and best[0] >= 0.6 * dur:
                r = best[1]
                rec.update(label=r["label"], source="derived",
                           reasons=[r["verdict"], f"{best[0] / dur:.0%} inside reel {r['reel']}"] + (j[1][:2] if j else []),
                           user_reel=r["name"])
            elif j:
                rec.update(label=j[0], source="judged", reasons=j[1])
            else:
                continue
        if j:
            rec["judged_mean"] = j[3]
            rec["tags"] = j[2]
        out.append(rec)
    with open(SEED / "windows.jsonl", "w", encoding="utf-8") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("windows", len(out))
    print("by source", Counter(r["source"] for r in out))
    print("by label", sorted(Counter(r["label"] for r in out).items()))
    print("by sermon/lang", Counter((r["sermon"], r["lang"]) for r in out))
    stats = {"total": len(out),
             "by_label": {str(k): v for k, v in sorted(Counter(r["label"] for r in out).items())},
             "by_source": dict(Counter(r["source"] for r in out)),
             "by_lang": dict(Counter(r["lang"] for r in out)),
             "by_sermon": dict(Counter(r["sermon"] for r in out)),
             "label_by_lang": {lg: {str(k): v for k, v in sorted(Counter(r["label"] for r in out if r["lang"] == lg).items())}
                               for lg in ("or", "hi", "mixed")}}
    (WORK / "stats.json").write_text(json.dumps(stats, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
