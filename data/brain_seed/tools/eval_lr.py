"""Step 4b: can a plain logistic regression on the e5 window embedding separate
good (label >= 0.6) from bad (label <= 0.3) windows?  numpy only.

Windows overlap (stride ~10 s, two lengths), so a random K-fold leaks near-duplicates
across folds. We report three splits:
  random   5-fold over windows (optimistic upper bound)
  blocked  5-fold over contiguous 5-minute blocks of each sermon (honest)
  cross    train on one sermon, test on the other (hardest)
"""
import json
import sys
from pathlib import Path

import numpy as np

SEED = Path(__file__).resolve().parents[1]


def auc(y, s):
    order = np.argsort(s)
    r = np.empty(len(s))
    r[order] = np.arange(1, len(s) + 1)
    # average ranks for ties
    for v in np.unique(s):
        m = s == v
        if m.sum() > 1:
            r[m] = r[m].mean()
    pos = y == 1
    n1, n0 = pos.sum(), (~pos).sum()
    return (r[pos].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def fit_lr(X, y, l2=1.0, iters=500, lr=0.5):
    Xb = np.hstack([X, np.ones((len(X), 1))])
    w = np.zeros(Xb.shape[1])
    pw = (len(y) - y.sum()) / max(y.sum(), 1)  # class balance
    sw = np.where(y == 1, pw, 1.0)
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Xb @ w))
        g = Xb.T @ ((p - y) * sw) / sw.sum() + l2 * np.r_[w[:-1], 0] / len(y)
        w -= lr * g
    return w


def predict(w, X):
    return np.hstack([X, np.ones((len(X), 1))]) @ w


def standardise(Xtr, Xte):
    mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-6
    return (Xtr - mu) / sd, (Xte - mu) / sd


def cv(X, y, folds, l2):
    scores = np.zeros(len(y))
    per = []
    for k in np.unique(folds):
        te = folds == k
        tr = ~te
        if len(np.unique(y[te])) < 2:
            continue
        a, b = standardise(X[tr], X[te])
        w = fit_lr(a, y[tr], l2=l2)
        scores[te] = predict(w, b)
        per.append(auc(y[te], scores[te]))
    return auc(y, scores), per


def main():
    rows = [json.loads(l) for l in open(SEED / "windows.jsonl", encoding="utf-8")]
    X = np.load(SEED / "window_embeddings.npy")
    lab = np.array([r["label"] for r in rows])
    keep = (lab >= 0.6) | (lab <= 0.3)
    y = (lab[keep] >= 0.6).astype(float)
    Xk = X[keep]
    rk = [r for r, k in zip(rows, keep) if k]
    rng = np.random.default_rng(0)
    rand_f = rng.integers(0, 5, len(y))
    blocks = np.array([f"{r['sermon']}:{int(r['start'] // 300)}" for r in rk])
    ub = np.unique(blocks)
    perm = rng.permutation(len(ub))
    bmap = {b: perm[i] % 5 for i, b in enumerate(ub)}
    block_f = np.array([bmap[b] for b in blocks])
    serm_f = np.array([0 if r["sermon"] == "btf" else 1 for r in rk])
    res = {"n_pos": int(y.sum()), "n_neg": int(len(y) - y.sum()), "excluded_0.4": int((~keep).sum())}
    for l2 in (1.0, 10.0, 100.0, 1000.0):
        a_r, _ = cv(Xk, y, rand_f, l2)
        a_b, pb = cv(Xk, y, block_f, l2)
        # cross-sermon: average of both directions
        a_x0 = cv(Xk, y, serm_f, l2)[1]
        res[f"l2={l2}"] = {"random5": round(a_r, 3), "blocked5": round(a_b, 3),
                          "blocked_folds": [round(v, 3) for v in pb],
                          "cross_sermon(test btf, test salvation)": [round(v, 3) for v in a_x0]}
    # cosine-to-centroid baseline (what the app's 'semantic score' would do with no training)
    a_c = []
    for k in range(5):
        te = block_f == k
        tr = ~te
        cp = Xk[tr & (y == 1)].mean(0)
        cn = Xk[tr & (y == 0)].mean(0)
        a_c.append(Xk[te] @ cp - Xk[te] @ cn)
    sc = np.zeros(len(y))
    for k in range(5):
        sc[block_f == k] = a_c[k]
    res["centroid_cosine_blocked5"] = round(auc(y, sc), 3)
    print(json.dumps(res, indent=1))
    (SEED / "tools" / "work" / "eval_lr.json").write_text(json.dumps(res, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
