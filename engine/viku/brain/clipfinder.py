"""Viku Brain v1 clip finder: windows -> features -> score -> ranked candidate reels.

Windows: transcript cues joined at pauses into 20-60 s spans that end at a natural pause (>= 0.4 s).
Features (raw, then z-scored across the sermon's windows):
  energy / energy_var  mean + std of voiced frame dB (relative to the sermon median)
  speech_rate          letters per voiced second
  direct_address       "you" words per minute (ଆପଣ/ତୁମେ, आप/तुम, you)
  victory / enemy      encouragement-victory words / enemy-problem words per minute (lexicon.json)
  scripture            scripture mentions (book names, ଅଧ୍ୟାୟ/अध्याय/chapter ...) per minute
  ends_on_hope         hope words in the last 2 cues;  ends_negative: judgement words there
  call_response        share of cues that are only amen/hallelujah/yes fillers
  asr_conf             mean ASR confidence (music / crowd noise reads low)
  duration_fit         closeness to ~45 s
  semantic             similarity to kept-vs-rejected reels (Phase 3 embedding hook; 0 until then)
Score = sigmoid(bias + w . z) with weights.json, or the learned ranker (<data>/models/brain/ranker.json).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .. import config
from ..media import audio
from . import embed, planner, text as T

FEATURES = ["energy", "energy_var", "speech_rate", "direct_address", "victory", "enemy", "scripture",
            "ends_on_hope", "ends_negative", "call_response", "asr_conf", "duration_fit", "semantic"]
REASONS = {
    "energy": "high energy delivery", "energy_var": "lively, varied voice", "speech_rate": "fast, passionate pace",
    "direct_address": "speaks straight to 'you'", "victory": "victory / encouragement words",
    "enemy": "victory over the enemy / problems", "scripture": "mentions scripture",
    "ends_on_hope": "ends on hope", "asr_conf": "clear speech", "duration_fit": "good reel length",
    "semantic": "like reels you kept",
}


def brain_dir() -> Path:
    return config.sub("models") / "brain"


def framedb(p: dict) -> np.ndarray:
    """20 ms frame dB of the whole sermon, cached next to the project."""
    from .. import projects
    d = projects.pdir(p["id"])
    f = d / "framedb.npy"
    if f.exists():
        return np.load(f)
    import soundfile as sf
    out = []
    with sf.SoundFile(p["wav16"]) as snd:
        hop = int(audio.SR * audio.FRAME)
        while True:
            x = snd.read(hop * 3000, dtype="float32", always_2d=False)
            if len(x) == 0:
                break
            out.append(audio.frame_db(x))
    db = np.concatenate(out) if out else np.zeros(0, np.float32)
    np.save(f, db)
    return db


def build_windows(items: list[dict], min_len=20.0, max_len=60.0, end_gap=0.4) -> list[tuple[int, int]]:
    out = []
    n = len(items)
    for i in range(n):
        if i > 0 and items[i]["start"] - items[i - 1]["end"] < 0.25:
            continue  # start on a pause
        for j in range(i, n):
            d = items[j]["end"] - items[i]["start"]
            if d > max_len:
                break
            if d >= min_len:
                gap = items[j + 1]["start"] - items[j]["end"] if j + 1 < n else 9.0
                if gap >= end_gap:
                    out.append((i, j))
    return out


def features(items: list[dict], lang: str, db: np.ndarray, med: float, thr: float) -> dict:
    s, e = items[0]["start"], items[-1]["end"]
    dur = max(e - s, 1e-3)
    mins = dur / 60
    seg = db[int(s / audio.FRAME):int(e / audio.FRAME)]
    v = seg[seg > thr] if len(seg) else seg
    txt = " ".join(it["text"] for it in items)
    voiced = max(len(v) * audio.FRAME, 1.0)
    last = " ".join(it["text"] for it in items[-2:])
    cr = sum(1 for it in items if is_filler(it["text"], lang)) / len(items)
    return {
        "energy": float(v.mean() - med) if len(v) else 0.0,
        "energy_var": float(v.std()) if len(v) else 0.0,
        "speech_rate": T.letters(txt) / voiced,
        "direct_address": T.lex_hits(txt, "direct_address", lang) / mins,
        "victory": T.lex_hits(txt, "victory", lang) / mins,
        "enemy": T.lex_hits(txt, "enemy", lang) / mins,
        "scripture": (T.lex_hits(txt, "scripture", lang) + scripture_names(txt)) / mins,
        "ends_on_hope": float(min(T.lex_hits(last, "hope_end", lang), 3)),
        "ends_negative": float(min(T.lex_hits(last, "negative_end", lang), 3)),
        "call_response": cr,
        "asr_conf": float(np.mean([it.get("conf") or 0.0 for it in items])),
        "duration_fit": max(0.0, 1 - abs(dur - 45) / 25),
        "semantic": embed.similarity_to_favourites(txt),
    }


def scripture_names(txt: str) -> int:
    from .. import bible
    t = bible.norm(txt)
    n = 0
    for name, _ in bible.book_names():
        if len(name) >= 4 and name in t:
            n += 1
    return min(n, 3)


def is_filler(text: str, lang: str) -> bool:
    toks = T.tokens(text)
    if not toks:
        return True
    lx = T.lexicon()["call_response"]
    words = [T.norm(w) for L in (lang, "en") for w in lx.get(L, [])]
    single = {w for w in words if " " not in w}
    rest = [t for t in toks if not any(t == w or (len(w) > 2 and t.startswith(w)) for w in single)]
    phr = sum(T.norm(text).count(w) for w in words if " " in w)
    return len(rest) <= max(0, phr * 2) or (len(rest) <= 1 and len(toks) <= 3)


def load_model() -> dict:
    f = brain_dir() / "ranker.json"
    if f.exists():
        m = json.loads(f.read_text(encoding="utf-8"))
        if m.get("n_labels", 0) >= 10:
            return m | {"kind": "learned"}
    w = json.loads((Path(__file__).parent / "weights.json").read_text(encoding="utf-8"))
    return {"kind": "hand", "bias": w["bias"], "weights": w["weights"]}


def zscore(rows: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    X = np.array([[r[f] for f in FEATURES] for r in rows], float)
    mu, sd = X.mean(0), X.std(0)
    sd[sd < 1e-6] = 1.0
    return (X - mu) / sd, mu, sd


def score_rows(rows: list[dict], model: dict) -> tuple[np.ndarray, np.ndarray]:
    """-> (scores 0..1, per-feature contributions)."""
    if not rows:
        return np.zeros(0), np.zeros((0, len(FEATURES)))
    if model["kind"] == "learned":
        X = np.array([[r[f] for f in FEATURES] for r in rows], float)
        mu, sd = np.array(model["mean"]), np.array(model["std"])
        Z = (X - mu) / sd
    else:
        Z, _, _ = zscore(rows)
    w = np.array([model["weights"].get(f, 0.0) for f in FEATURES])
    contrib = Z * w
    s = model.get("bias", 0.0) + contrib.sum(1)
    return 1 / (1 + np.exp(-s / 2)), contrib


def suggest(p: dict, count: int = 8, rng: list | None = None, job=None) -> list[dict]:
    items = sorted([t for t in p.get("transcript", []) if t.get("text")], key=lambda t: t["start"])
    if rng:
        items = [t for t in items if t["start"] >= rng[0] and t["end"] <= rng[1]]
    if len(items) < 3:
        return []
    lang_default = p["language"] if p["language"] != "auto" else "or"
    db = framedb(p)
    med = float(np.median(db)) if len(db) else -40.0
    thr = audio.threshold(db)
    wins = build_windows(items)
    if not wins:
        wins = [(0, len(items) - 1)]
    rows, meta = [], []
    for k, (i, j) in enumerate(wins):
        its = items[i:j + 1]
        langs = {}
        for it in its:
            langs[it.get("lang", lang_default)] = langs.get(it.get("lang", lang_default), 0) + it["end"] - it["start"]
        lang = max(langs, key=langs.get)
        if p["language"] != "auto":
            lang = p["language"]
        rows.append(features(its, lang, db, med, thr))
        meta.append((i, j, lang))
        if job is not None and k % 200 == 0:
            job.check()
            job.update(0.1 + 0.6 * k / len(wins), f"scoring windows {k}/{len(wins)}")
    model = load_model()
    sc, contrib = score_rows(rows, model)
    order = np.argsort(-sc)
    picked: list[int] = []
    for k in order:
        i, j, _ = meta[k]
        s, e = items[i]["start"], items[j]["end"]
        if any(min(e, items[meta[q][1]]["end"]) - max(s, items[meta[q][0]]["start"]) > 0.25 * (e - s) for q in picked):
            continue
        picked.append(int(k))
        if len(picked) >= count:
            break
    out = []
    for rank, k in enumerate(picked):
        i, j, lang = meta[k]
        its = items[i:j + 1]
        segs = planner.plan(its, p.get("pauses", []), lang)
        c = contrib[k]
        top = [FEATURES[q] for q in np.argsort(-c) if c[q] > 0.15 and FEATURES[q] in REASONS][:4]
        out.append({"id": f"s{rank + 1}", "score": round(float(sc[k]), 4), "title": pick_title(its, lang),
                    "segments": segs, "window": [items[i]["start"], items[j]["end"]],
                    "duration": round(sum(b - a for a, b in segs), 2), "reasons": [REASONS[f] for f in top],
                    "language": lang, "features": {f: round(float(rows[k][f]), 4) for f in FEATURES},
                    "model": model["kind"]})
    return out


def pick_title(items: list[dict], lang: str) -> str:
    last = items[-1]["text"]
    if T.lex_hits(last, "hope_end", lang):
        return T.short_title(last)
    best = max(items, key=lambda it: (T.lex_hits(it["text"], "victory", lang), len(it["text"])))
    return T.short_title(best["text"])


def window_features(p: dict, segments: list, lang: str) -> dict:
    """Features for an arbitrary reel (its segments' transcript) - used to label feedback."""
    items = sorted([t for t in p.get("transcript", []) if any(t["start"] < e and t["end"] > s for s, e in segments)],
                   key=lambda t: t["start"])
    if not items:
        return {}
    db = framedb(p) if p.get("wav16") else np.zeros(0)
    med = float(np.median(db)) if len(db) else -40.0
    return features(items, lang, db, med, audio.threshold(db))


def fit_logreg(X: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 3000, lr: float = 0.1) -> tuple[np.ndarray, float]:
    """Plain numpy logistic regression (gradient descent, L2)."""
    n, d = X.shape
    w, b = np.zeros(d), 0.0
    for _ in range(iters):
        z = X @ w + b
        pr = 1 / (1 + np.exp(-z))
        g = pr - y
        w -= lr * (X.T @ g / n + l2 * w / n)
        b -= lr * g.mean()
    return w, float(b)


def learn(rows: list[dict], labels: list[int]) -> dict:
    X = np.array([[r.get(f, 0.0) for f in FEATURES] for r in rows], float)
    y = np.array(labels, float)
    mu, sd = X.mean(0), X.std(0)
    sd[sd < 1e-6] = 1.0
    w, b = fit_logreg((X - mu) / sd, y)
    # scale to the same "2x" logit convention as score_rows
    m = {"bias": b * 2, "weights": {f: float(v * 2) for f, v in zip(FEATURES, w)}, "mean": mu.tolist(),
         "std": sd.tolist(), "n_labels": int(len(y)), "positives": int(y.sum())}
    pred = 1 / (1 + np.exp(-(((X - mu) / sd) @ w + b)))
    m["train_accuracy"] = float(((pred > 0.5) == (y > 0.5)).mean())
    d = brain_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / "ranker.json").write_text(json.dumps(m, indent=1), encoding="utf-8")
    return m

