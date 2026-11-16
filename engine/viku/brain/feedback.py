"""Editor feedback (<data>/feedback.jsonl) and the /learn job.

keep / reject: stored with the reel's window features so the ranker can learn from them.
caption_edit:  before -> after; word replacements go into the correction memory immediately.
learn(): >= 10 keep/reject labels -> logistic regression ranker (numpy) -> models/brain/ranker.json;
          correction memory rebuilt from every caption edit.
"""
from __future__ import annotations

import json
import threading
import time

from .. import config, projects
from . import captions, clipfinder

_lock = threading.Lock()
KINDS = {"keep", "reject", "caption_edit"}


def path():
    return config.data_dir() / "feedback.jsonl"


def add(reel_id: str, kind: str, before=None, after=None, lang: str | None = None) -> dict:
    if kind not in KINDS:
        raise projects.Invalid(f"kind must be one of {sorted(KINDS)}")
    rec = {"t": time.time(), "reel_id": reel_id, "kind": kind, "before": before, "after": after}
    try:
        p, r = projects.find_reel(reel_id)
        rec["lang"] = lang or r.get("language")
        if kind in ("keep", "reject"):
            rec["features"] = clipfinder.window_features(p, r["segments"], rec["lang"] or "or")
            rec["segments"] = r["segments"]
    except (projects.NotFound, ValueError, IndexError):
        rec["lang"] = lang
    if kind == "caption_edit" and isinstance(before, str) and isinstance(after, str):
        rec["learned"] = captions.learn_edit(before, after, rec.get("lang") or "or")
    with _lock:
        with path().open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def records() -> list[dict]:
    if not path().exists():
        return []
    out = []
    for line in path().read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def learn(job=None) -> dict:
    recs = records()
    labelled = [r for r in recs if r["kind"] in ("keep", "reject") and r.get("features")]
    edits = [r for r in recs if r["kind"] == "caption_edit"]
    res = {"labels": len(labelled), "caption_edits": len(edits)}
    res["corrections"] = captions.rebuild_memory(edits)
    if len(labelled) >= 10 and len({r["kind"] for r in labelled}) == 2:
        m = clipfinder.learn([r["features"] for r in labelled], [1 if r["kind"] == "keep" else 0 for r in labelled])
        res["ranker"] = {k: m[k] for k in ("n_labels", "positives", "train_accuracy")}
    else:
        res["ranker"] = f"hand weights kept (need >= 10 keep/reject labels incl. both kinds, have {len(labelled)})"
    return res
