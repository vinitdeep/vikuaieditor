"""Train the shipped clip ranker on the Viku Brain seed (data/brain_seed) and report honest CV numbers.

    uv run python -m viku.brain.train_seed [--project <id with the btf audio>] [--no-write]

Writes engine/viku/brain/ranker_seed.json (model) and ranker_seed_rows.npz (raw features + fp16 embeddings + labels,
used by /learn to retrain with editor feedback). Prints blocked-CV AUC (5-min blocks held out), cross-sermon AUC and
the hand-weight baseline (weights.json over the v1 features) on the same windows.
Labels: good = label >= 0.6, bad = label <= 0.3; the 0.4 "made but not liked" windows count as bad for training
(soft target 0.2) and are left out of the AUC like the seed README does.
Audio features exist only for `btf` (the Before-the-Foundation wav of the test project); Salvation's are NaN -> 0.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from . import ranker, text as T

ROOT = Path(__file__).resolve().parents[3]
SEED = ROOT / "data" / "brain_seed"
BTF_PROJECT = "20261117-045435-6d0d"


def auc(y, s):
    order = np.argsort(s, kind="mergesort")
    r = np.empty(len(s))
    r[order] = np.arange(1, len(s) + 1)
    for v in np.unique(s):
        m = s == v
        if m.sum() > 1:
            r[m] = r[m].mean()
    pos = y == 1
    n1, n0 = pos.sum(), (~pos).sum()
    return float((r[pos].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def load_seed():
    rows = [json.loads(l) for l in open(SEED / "windows.jsonl", encoding="utf-8")]
    E = np.load(SEED / "window_embeddings.npy").astype(np.float32)
    cues = {s: json.load(open(SEED / "tools" / "work" / f"cues_{s}.json", encoding="utf-8")) for s in ("btf", "salvation")}
    items = []
    for r in rows:
        its = []
        for c in cues[r["sermon"]]:
            if c["s"] >= r["start"] - 0.05 and c["e"] <= r["end"] + 0.05:
                lang = c.get("lang") or "or"
                txt = c.get("hi") if lang == "hi" and c.get("hi") else c.get("or", "")
                its.append({"start": c["s"], "end": c["e"], "text": txt or "", "lang": lang})
        if not its:
            its = [{"start": r["start"], "end": r["end"], "text": r["text"], "lang": "or"}]
        items.append(its)
    return rows, E, items


def audio_for(project_id: str):
    from .. import projects
    from ..brain import clipfinder
    from ..media import audio
    p = projects.load(project_id)
    db = clipfinder.framedb(p)
    return db, float(np.median(db)), float(audio.threshold(db))


def baseline_scores(rows, items, dbs) -> np.ndarray:
    """v1 hand weights over the v1 features, z-scored per sermon (what /suggest did before this model)."""
    from . import clipfinder, embed
    w = json.loads((Path(__file__).parent / "weights.json").read_text(encoding="utf-8"))
    old = embed.similarity_to_favourites
    embed.similarity_to_favourites = lambda _t: 0.0
    try:
        F = []
        for r, its in zip(rows, items):
            lang = "hi" if r["lang"] == "hi" else "or"
            db, med, thr = dbs.get(r["sermon"], (np.zeros(0), -40.0, -99.0))
            F.append(clipfinder.features_v1(its, lang, db, med, thr))
    finally:
        embed.similarity_to_favourites = old
    names = list(w["weights"])
    X = np.array([[f[k] for k in names] for f in F], float)
    out = np.zeros(len(rows))
    serm = np.array([r["sermon"] for r in rows])
    for s in np.unique(serm):
        k = serm == s
        mu, sd = X[k].mean(0), X[k].std(0)
        sd[sd < 1e-6] = 1
        out[k] = w["bias"] + ((X[k] - mu) / sd) @ np.array([w["weights"][n] for n in names])
    return out


def cv_scores(R, E, ytr, sw, groups, folds, l2, k_pca=ranker.K_PCA, cols=None):
    """Out-of-fold scores; centroids / PCA / LR are fitted on the training folds only."""
    out = np.full(len(ytr), np.nan)
    for f in np.unique(folds):
        te, tr = folds == f, folds != f
        m = ranker.train(R[tr], E[tr], ytr[tr], groups[tr], sw[tr], l2=l2)
        m["pca_components"] = m["pca_components"][:k_pca]
        Z = ranker.build_matrix(R, E, groups, m)  # z-stats per sermon use no labels
        if cols is not None:
            Z = Z[:, cols]
        # refit LR on the chosen columns / K (train() fitted all of them)
        w, b = ranker.fit_lr(Z[tr], ytr[tr], sw[tr], l2=l2)
        out[te] = Z[te] @ w + b
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=BTF_PROJECT)
    ap.add_argument("--no-write", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    rows, E, items = load_seed()
    dbs = {}
    try:
        dbs["btf"] = audio_for(a.project)
    except Exception as e:  # noqa: BLE001
        print("no btf audio:", e)
    R = np.array([[ranker.raw_features(its, "or", *(dbs[r["sermon"]] if r["sermon"] in dbs else (None, 0, -99)))[k]
                   for k in ranker.RAW] for r, its in zip(rows, items)], float)
    lab = np.array([r["label"] for r in rows])
    groups = np.array([r["sermon"] for r in rows])
    ytr = np.where(lab >= 0.6, 1.0, np.where(lab >= 0.4 - 1e-6, 0.2, 0.0))
    sw = np.where(np.array([r["source"] for r in rows]) == "judged", 1.0, 2.0)  # user verdicts count double
    ev = (lab >= 0.6) | (lab <= 0.3)
    yb = (lab >= 0.6).astype(int)
    rng = np.random.default_rng(0)
    blocks = np.array([f"{r['sermon']}:{int(r['start'] // 300)}" for r in rows])
    ub = np.unique(blocks)
    perm = rng.permutation(len(ub))
    bmap = {b: perm[i] % 5 for i, b in enumerate(ub)}
    bfold = np.array([bmap[b] for b in blocks])
    sfold = np.array([0 if g == "btf" else 1 for g in groups])
    print(f"features in {time.time() - t0:.1f}s; windows {len(rows)} (eval pos {yb[ev].sum()} / neg {(1 - yb[ev]).sum()})")

    base = baseline_scores(rows, items, dbs)
    res = {"baseline_hand_weights": {"all": round(auc(yb[ev], base[ev]), 3),
                                      "btf": round(auc(yb[ev & (groups == 'btf')], base[ev & (groups == 'btf')]), 3),
                                      "salvation": round(auc(yb[ev & (groups == 'salvation')],
                                                             base[ev & (groups == 'salvation')]), 3)}}
    nr = len(ranker.RAW)
    variants = {"full": None, "engineered_only": list(range(nr)),
                "embedding_only": list(range(nr, nr + 1 + ranker.K_PCA))}
    for l2 in (3.0, 30.0, 100.0):
        for name, cols in variants.items():
            s = cv_scores(R, E, ytr, sw, groups, bfold, l2, cols=cols)
            per = [auc(yb[ev & (bfold == f)], s[ev & (bfold == f)]) for f in range(5)]
            x = cv_scores(R, E, ytr, sw, groups, sfold, l2, cols=cols)
            res[f"{name} l2={l2:g}"] = {"blocked5": round(auc(yb[ev], s[ev]), 3), "blocked_folds": [round(v, 3) for v in per],
                                        "test_btf": round(auc(yb[ev & (sfold == 0)], x[ev & (sfold == 0)]), 3),
                                        "test_salvation": round(auc(yb[ev & (sfold == 1)], x[ev & (sfold == 1)]), 3)}
    for k, v in res.items():
        print(f"{k:28s} {v}")
    best_l2 = max((30.0, 3.0, 100.0), key=lambda l: res[f"full l2={l:g}"]["blocked5"])
    m = ranker.train(R, E, ytr, groups, sw, l2=best_l2)
    m["cv"] = res
    m["trained"] = {"windows": len(rows), "positives": int((ytr >= 0.5).sum()), "l2": best_l2,
                    "date": time.strftime("%Y-%m-%d"), "source": "data/brain_seed (btf + salvation)"}
    print("weights:", {k: round(v, 3) for k, v in m["weights"].items()}, "bias", round(m["bias"], 3))
    if not a.no_write:
        out = Path(__file__).parent
        (out / "ranker_seed.json").write_text(json.dumps(m, indent=0), encoding="utf-8")
        np.savez_compressed(out / "ranker_seed_rows.npz", raw=R.astype(np.float32), emb=E.astype(np.float16),
                            y=ytr.astype(np.float32), sw=sw.astype(np.float32), groups=groups)
        print("wrote", out / "ranker_seed.json")


if __name__ == "__main__":
    main()
