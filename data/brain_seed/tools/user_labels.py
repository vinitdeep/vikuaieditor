"""User verdicts on reels already made from the two seed sermons (absolute source seconds).

label policy:
  1.0  liked by the user
  0.9  built afterwards in the liked style (jump-cut reels), treated as positive
  0.7  Salvation reels, delivered and accepted
  0.4  made but NOT liked (weak positive / neutral)
  0.0  rejected earlier as not encouraging (superseded drafts)
"""
import json
from pathlib import Path

SPECS = Path(r"C:\Users\vinit\Documents\Claude\Projects\AI Video Editing\specs")


def _rng(rel):
    d = json.loads((SPECS / rel).read_text(encoding="utf-8"))
    return d["start"], d["end"]


_DEF = [
    # (sermon, name, label, verdict, ranges)
    ("btf", "4-dont-fall-down", 1.0, "liked", [_rng("btf/4-dont-fall-down.json")]),
    ("btf", "hi-1-main-kar-sakunga", 1.0, "liked", [_rng("btf/hi-1-main-kar-sakunga.json")]),
    ("btf", "hi-4-satan-defeated", 1.0, "liked", [_rng("btf/hi-4-satan-defeated.json")]),
    ("btf", "6-satan-defeated", 0.9, "positive (jump-cut, liked style)",
     [(7224.65, 7239.45), (7182.55, 7195.90), (8055.40, 8071.20)]),
    ("btf", "hi-6-akele-nahi", 0.9, "positive (jump-cut, liked style)",
     [(5167.70, 5185.50), (5415.45, 5447.25), (5474.90, 5478.60)]),
    ("btf", "1-made-beautiful", 0.4, "made, not liked", [_rng("btf/1-made-beautiful.json")]),
    ("btf", "2-made-to-praise", 0.4, "made, not liked", [_rng("btf/2-made-to-praise.json")]),
    ("btf", "3-why-the-bible", 0.4, "made, not liked", [_rng("btf/3-why-the-bible.json")]),
    ("btf", "5-share-the-gospel", 0.4, "made, not liked", [_rng("btf/5-share-the-gospel.json")]),
    ("btf", "hi-2-painter-part1", 0.4, "made, not liked", [_rng("btf/hi-2-painter-part1.json")]),
    ("btf", "hi-3-painter-part2", 0.4, "made, not liked", [_rng("btf/hi-3-painter-part2.json")]),
    ("btf", "hi-5-prayer-blessing", 0.4, "made, not liked", [_rng("btf/hi-5-prayer-blessing.json")]),
    ("btf", "x-1-perfect-creation", 0.0, "rejected: not encouraging", [_rng("btf/_superseded/1-perfect-creation.json")]),
    ("btf", "x-3-one-third-angels", 0.0, "rejected: not encouraging", [_rng("btf/_superseded/3-one-third-angels.json")]),
    ("btf", "x-5-hold-the-word", 0.0, "rejected: not encouraging", [_rng("btf/_superseded/5-hold-the-word.json")]),
    ("salvation", "1-not-by-works", 0.7, "delivered + accepted", [_rng("1-not-by-works.json")]),
    ("salvation", "2-with-what-heart", 0.7, "delivered + accepted", [_rng("2-with-what-heart.json")]),
    ("salvation", "3-outside-church", 0.7, "delivered + accepted", [_rng("3-outside-church.json")]),
    ("salvation", "4-thief-on-the-cross", 0.7, "delivered + accepted", [_rng("4-thief-on-the-cross.json")]),
    ("salvation", "5-christ-in-me", 0.7, "delivered + accepted", [_rng("5-christ-in-me.json")]),
]

USER_RANGES = []
for sermon, name, label, verdict, ranges in _DEF:
    for k, (a, b) in enumerate(ranges):
        USER_RANGES.append({"sermon": sermon, "name": name if len(ranges) == 1 else f"{name}#seg{k + 1}",
                            "reel": name, "label": label, "verdict": verdict,
                            "start": float(a), "end": float(b)})
