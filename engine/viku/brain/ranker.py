"""Viku Brain clip ranker: logistic regression over engineered window features + an embedding projection.

Raw features per window (`raw_features`; NaN when the input is missing, e.g. no audio / no ASR confidence):
  energy, energy_var       voiced-frame dB mean (vs sermon median) and spread           (audio)
  pace                     letters per second of window
  direct_address, victory, enemy, scripture, admin_notice     lexicon hits per minute, counted per cue in the
                           cue's own language (sermons switch Odia/Hindi) + English loanwords
  ends_on_hope, ends_negative  hope / judgement words in the last 2 cues
  call_response            share of cues that are only amen / hallelujah / yes fillers
  asr_conf                 mean ASR confidence
  duration_fit             closeness to the target length (~45 s for a 60 s cap: 0.75 x the cap)
Embedding features (multilingual-e5-small, "passage: " + window text):
  semantic                 cos(kept centroid) - cos(rejected centroid)
  pc1..pcK                 projection on the seed's top-K principal components
Every column is z-scored within the sermon being ranked (shrunk toward the seed's reference stats when there are
few windows), NaN -> 0. Score = sigmoid(bias + w . z).

Models: `ranker_seed.json` (shipped, trained on data/brain_seed by `python -m viku.brain.train_seed`) and
<data>/models/brain/ranker.json (written by /learn: seed rows + editor keep/reject feedback, feedback weighted higher).
"""
from __future__ import annotations

import functools
import json
from pathlib import Path

import numpy as np

from .. import config
from . import text as T

HERE = Path(__file__).parent
SEED_MODEL = HERE / "ranker_seed.json"
SEED_ROWS = HERE / "ranker_seed_rows.npz"
RAW = ["energy", "energy_var", "pace", "direct_address", "victory", "enemy", "scripture", "admin_notice",
       "ends_on_hope", "ends_negative", "call_response", "asr_conf", "duration_fit"]
K_PCA = 8
SHRINK_N = 30.0  # pseudo-windows of seed stats mixed into a sermon's z-score stats
FEEDBACK_WEIGHT = 5.0

REASONS = {
    "energy": "high energy delivery", "energy_var": "lively, varied voice", "pace": "fast, passionate pace",
    "direct_address": "speaks straight to 'you'", "victory": "victory / encouragement words",
    "enemy": "victory over the enemy / problems", "scripture": "mentions scripture",
    "admin_notice": "not a notice / announcement", "ends_on_hope": "ends on hope",
    "ends_negative": "doesn't end on fear", "call_response": "little crowd call-and-response",
    "asr_conf": "clear speech", "duration_fit": "good reel length", "semantic": "sounds like reels you liked",
}


# ---------------------------------------------------------------- features --
def lex(items: list[dict], group: str, default_lang: str) -> int:
    return sum(T.lex_hits(it["text"], group, it.get("lang") or default_lang) for it in items)


@functools.lru_cache(maxsize=16)
def _filler_words(lang: str) -> tuple[frozenset, tuple[str, ...]]:
    lx = T.lexicon()["call_response"]
    words = [T.norm(w) for L in (lang, "en") for w in lx.get(L, [])]
    return frozenset(w for w in words if " " not in w), tuple(w for w in words if " " in w)


@functools.lru_cache(maxsize=100000)
def is_filler(text: str, lang: str) -> bool:
    toks = T.tokens(text)
    if not toks:
        return True
    single, phrases = _filler_words(lang)
    longs = [w for w in single if len(w) > 2]
    rest = [t for t in toks if t not in single and not any(t.startswith(w) for w in longs)]
    phr = sum(T.norm(text).count(w) for w in phrases)
    return len(rest) <= max(0, phr * 2) or (len(rest) <= 1 and len(toks) <= 3)


@functools.lru_cache(maxsize=100000)
def scripture_names(txt: str) -> int:
    from .. import bible
    t = bible.norm(txt)
    n = 0
    for name, _ in bible.book_names():
        if len(name) >= 4 and name in t:
            n += 1
    return min(n, 3)


def raw_features(items: list[dict], default_lang: str, db: np.ndarray | None = None, med: float = 0.0,
                 thr: float = -99.0, frame: float = 0.02, target: float = 45.0) -> dict:
    s, e = items[0]["start"], items[-1]["end"]
    dur = max(e - s, 1e-3)
    mins = dur / 60
    txt = " ".join(it["text"] for it in items)
    last = items[-2:]
    f = {k: float("nan") for k in RAW}
    if db is not None and len(db):
        seg = db[int(s / frame):int(e / frame)]
        v = seg[seg > thr] if len(seg) else seg
        if len(v):
            f["energy"] = float(v.mean() - med)
            f["energy_var"] = float(v.std())
    f["pace"] = T.letters(txt) / dur
    for g in ("direct_address", "victory", "enemy", "admin_notice"):
        f[g] = lex(items, g, default_lang) / mins
    f["scripture"] = (lex(items, "scripture", default_lang) + min(sum(scripture_names(it["text"]) for it in items), 3)) / mins
    f["ends_on_hope"] = float(min(lex(last, "hope_end", default_lang), 3))
    f["ends_negative"] = float(min(lex(last, "negative_end", default_lang), 3))
    f["call_response"] = sum(1 for it in items if is_filler(it["text"], it.get("lang") or default_lang)) / len(items)
    confs = [it["conf"] for it in items if it.get("conf") is not None]
    if confs:
        f["asr_conf"] = float(np.mean(confs))
    # same shape as the trained 45 +/- 25 s, scaled to the requested length
    f["duration_fit"] = max(0.0, 1 - abs(dur - target) / (25 * target / 45))
    return f


def emb_features(E: np.ndarray, m: dict) -> np.ndarray:
    """(n, 1 + K) semantic contrast + PCA projections."""
    cp, cn = np.asarray(m["centroid_pos"], np.float32), np.asarray(m["centroid_neg"], np.float32)
    mu, comp = np.asarray(m["pca_mean"], np.float32), np.asarray(m["pca_components"], np.float32)
    sem = E @ cp - E @ cn
    return np.column_stack([sem, (E - mu) @ comp.T])


def feature_names(k: int = K_PCA) -> list[str]:
    return RAW + ["semantic"] + [f"pc{i + 1}" for i in range(k)]


def zscore_group(X: np.ndarray, ref_mu: np.ndarray, ref_sd: np.ndarray, n0: float = SHRINK_N) -> np.ndarray:
    """z-score the rows of ONE sermon, stats shrunk toward the reference; NaN -> 0 (= average)."""
    Z = np.zeros_like(X, dtype=float)
    for j in range(X.shape[1]):
        col = X[:, j]
        ok = ~np.isnan(col)
        n = ok.sum()
        if n == 0:
            continue
        m_g = col[ok].mean()
        v_g = col[ok].var()
        mu = (n * m_g + n0 * ref_mu[j]) / (n + n0)
        var = (n * (v_g + (m_g - mu) ** 2) + n0 * (ref_sd[j] ** 2 + (ref_mu[j] - mu) ** 2)) / (n + n0)
        sd = max(np.sqrt(var), 1e-6)
        Z[ok, j] = (col[ok] - mu) / sd
    return np.clip(Z, -5, 5)


# --------------------------------------------------------------- training --
def fit_lr(X: np.ndarray, y: np.ndarray, sw: np.ndarray | None = None, l2: float = 1.0, iters: int = 600,
           lr: float = 0.5) -> tuple[np.ndarray, float]:
    """Class-balanced, sample-weighted logistic regression (numpy, full-batch GD). y may be soft (0..1)."""
    n, d = X.shape
    sw = np.ones(n) if sw is None else np.asarray(sw, float)
    pos = (y >= 0.5)
    wp = sw[~pos].sum() / max(sw[pos].sum(), 1e-9)
    sw = sw * np.where(pos, wp, 1.0)
    sw = sw / sw.mean()
    w, b = np.zeros(d), 0.0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X @ w + b)))
        g = (p - y) * sw
        w -= lr * (X.T @ g / n + l2 * w / n)
        b -= lr * g.mean()
    return w, float(b)


def pca(E: np.ndarray, k: int = K_PCA) -> tuple[np.ndarray, np.ndarray]:
    mu = E.mean(0)
    _, _, vt = np.linalg.svd(E - mu, full_matrices=False)
    return mu, vt[:k]


def centroids(E: np.ndarray, y: np.ndarray, sw: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    sw = np.ones(len(y)) if sw is None else sw
    pos, neg = y >= 0.5, y < 0.5
    cp = (E[pos] * sw[pos, None]).sum(0) / max(sw[pos].sum(), 1e-9)
    cn = (E[neg] * sw[neg, None]).sum(0) / max(sw[neg].sum(), 1e-9)
    return cp / np.linalg.norm(cp), cn / np.linalg.norm(cn)


def build_matrix(R: np.ndarray, E: np.ndarray, groups: np.ndarray, m: dict) -> np.ndarray:
    """raw (n, len(RAW)) + embeddings -> z-scored design matrix (per group)."""
    X = np.column_stack([R, emb_features(E, m)])
    mu, sd = np.asarray(m["ref_mean"]), np.asarray(m["ref_std"])
    Z = np.zeros_like(X, dtype=float)
    for g in np.unique(groups):
        k = groups == g
        Z[k] = zscore_group(X[k], mu, sd, m.get("shrink_n", SHRINK_N))
    return Z


def train(R: np.ndarray, E: np.ndarray, y: np.ndarray, groups: np.ndarray, sw: np.ndarray | None = None,
          l2: float = 30.0, base: dict | None = None) -> dict:
    """Fit centroids (+ PCA unless `base` gives one), reference stats and the LR. y: 1 = good, 0 = bad."""
    sw = np.ones(len(y)) if sw is None else sw
    m: dict = {}
    if base:
        m["pca_mean"], m["pca_components"] = base["pca_mean"], base["pca_components"]
    else:
        mu, comp = pca(E)
        m["pca_mean"], m["pca_components"] = mu.tolist(), comp.tolist()
    cp, cn = centroids(E, y, sw)
    m["centroid_pos"], m["centroid_neg"] = cp.tolist(), cn.tolist()
    X = np.column_stack([R, emb_features(E, m)])
    ref_mu = np.nanmean(X, 0)
    ref_sd = np.nanstd(X, 0)
    ref_sd[~(ref_sd > 1e-6)] = 1.0
    ref_mu[np.isnan(ref_mu)] = 0.0
    m["ref_mean"], m["ref_std"], m["shrink_n"] = ref_mu.tolist(), ref_sd.tolist(), SHRINK_N
    Z = build_matrix(R, E, groups, m)
    w, b = fit_lr(Z, y, sw, l2=l2)
    m["features"] = feature_names(len(m["pca_components"]))
    m["weights"] = {f: float(v) for f, v in zip(m["features"], w)}
    m["bias"] = b
    m["l2"] = l2
    return m


# ---------------------------------------------------------------- scoring --
@functools.lru_cache(maxsize=1)
def seed_model() -> dict:
    if SEED_MODEL.exists():
        return json.loads(SEED_MODEL.read_text(encoding="utf-8")) | {"kind": "seed"}
    return {}


def user_model_path() -> Path:
    return config.sub("models") / "brain" / "ranker.json"


def load_model() -> dict:
    f = user_model_path()
    if f.exists():
        try:
            m = json.loads(f.read_text(encoding="utf-8"))
            if m.get("features") and m.get("centroid_pos"):
                return m | {"kind": "learned"}
        except (json.JSONDecodeError, OSError):
            pass
    return seed_model()


def score(R: np.ndarray, E: np.ndarray, m: dict) -> tuple[np.ndarray, np.ndarray]:
    """One sermon's windows -> (probabilities, per-feature contributions)."""
    Z = build_matrix(R, E, np.zeros(len(R)), m)
    w = np.array([m["weights"][f] for f in m["features"]])
    contrib = Z * w
    s = m["bias"] + contrib.sum(1)
    return 1 / (1 + np.exp(-s)), contrib


def reasons(contrib_row: np.ndarray, m: dict, n: int = 4) -> list[dict]:
    """Top contributing features; the embedding columns are summed into one 'semantic' reason."""
    agg: dict[str, float] = {}
    for f, c in zip(m["features"], contrib_row):
        key = "semantic" if f.startswith("pc") or f == "semantic" else f
        agg[key] = agg.get(key, 0.0) + float(c)
    top = sorted(agg.items(), key=lambda kv: -kv[1])
    return [{"feature": f, "why": REASONS.get(f, f), "contribution": round(c, 3)} for f, c in top[:n] if c > 0.05]
