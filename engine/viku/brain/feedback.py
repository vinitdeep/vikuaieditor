"""Editor feedback (<data>/feedback.jsonl) and the /learn job.

keep / reject: stored with the reel's window features so the ranker can learn from them.
caption_edit:  before -> after; word replacements go into the correction memory immediately.
learn(): shipped seed windows (ranker_seed_rows.npz) + every keep/reject (weighted x5) -> logistic-regression ranker
          (ranker.py: engineered features + embedding contrast/PCA) -> <data>/models/brain/ranker.json;
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


def _feedback_rows(labelled: list[dict]) -> tuple[list[dict], list[str], list[float]]:
    """Raw ranker features + text per keep/reject record (recomputed when the record predates ranker v2)."""
    from . import ranker
    feats, texts, ys = [], [], []
    for r in labelled:
        f = r.get("features") or {}
        if "_text" not in f and r.get("segments"):
            try:
                p, rr = projects.find_reel(r["reel_id"])
                f = clipfinder.window_features(p, r["segments"], r.get("lang") or rr.get("language") or "or")
            except (projects.NotFound, ValueError, IndexError):
                f = {}
        if not f or not f.get("_text"):
            continue
        feats.append({k: (float("nan") if f.get(k) is None else float(f[k])) for k in ranker.RAW})
        texts.append(f["_text"])
        ys.append(1.0 if r["kind"] == "keep" else 0.0)
    return feats, texts, ys


def learn(job=None) -> dict:
    import numpy as np

    from . import embed, ranker
    recs = records()
    labelled = [r for r in recs if r["kind"] in ("keep", "reject")]
    edits = [r for r in recs if r["kind"] == "caption_edit"]
    res = {"labels": len(labelled), "caption_edits": len(edits)}
    res["corrections"] = captions.rebuild_memory(edits)
    feats, texts, ys = _feedback_rows(labelled)
    seed = ranker.seed_model()
    if not feats or not ranker.SEED_ROWS.exists() or not seed:
        res["ranker"] = "seed ranker kept (no keep/reject feedback with transcript text yet)"
        return res
    if job:
        job.update(0.3, f"embedding {len(texts)} feedback reels")
    S = np.load(ranker.SEED_ROWS)
    Rf = np.array([[f[k] for k in ranker.RAW] for f in feats], float)
    Ef = embed.embed_texts(texts, "passage: ")
    R = np.vstack([S["raw"].astype(float), Rf])
    E = np.vstack([S["emb"].astype(np.float32), Ef])
    y = np.concatenate([S["y"].astype(float), ys])
    sw = np.concatenate([S["sw"].astype(float), np.full(len(ys), ranker.FEEDBACK_WEIGHT)])
    groups = np.concatenate([S["groups"].astype(str), np.array(["feedback"] * len(ys))])
    if job:
        job.update(0.6, "fitting ranker")
    m = ranker.train(R, E, y, groups, sw, l2=seed.get("l2", 30.0), base=seed)
    Z = ranker.build_matrix(R, E, groups, m)
    w = np.array([m["weights"][f] for f in m["features"]])
    pr = 1 / (1 + np.exp(-(Z @ w + m["bias"])))
    fb = groups == "feedback"
    m["trained"] = {"seed_windows": int((~fb).sum()), "feedback": int(fb.sum()), "feedback_weight": ranker.FEEDBACK_WEIGHT,
                    "feedback_keep": int(sum(ys)), "feedback_train_accuracy": float(((pr[fb] > 0.5) == (y[fb] > 0.5)).mean()),
                    "date": time.strftime("%Y-%m-%d %H:%M")}
    m["cv"] = seed.get("cv")
    f = ranker.user_model_path()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(m), encoding="utf-8")
    res["ranker"] = m["trained"]
    return res
