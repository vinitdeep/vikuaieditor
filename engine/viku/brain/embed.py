"""Sentence embeddings: intfloat/multilingual-e5-small (MIT), ONNX on CPU via onnxruntime + `tokenizers`.

Model files live in <data>/models/embed/multilingual-e5-small/ (model.onnx + tokenizer.json). First use copies them
from the repo (`models/embed/multilingual-e5-small/onnx/`) or downloads them from Hugging Face.
E5 convention: "query: " for the probe text, "passage: " for indexed text. Pooling = attention-masked mean of
last_hidden_state, then L2-normalise -> 384-d. E5 cosines sit in ~0.7-1.0: rank/contrast them, don't threshold raw.

Interface:
  available() -> bool                    model files present (does not load the session)
  ensure_model(job=None) -> Path         copy / download once
  embed_texts(texts, prefix="passage: ", batch=32, cache=True) -> np.ndarray (n, 384) float32, L2-normalised
  similarity_to_favourites(text) -> float   kept-vs-rejected centroid contrast (seed + feedback centroids)
Embeddings are cached by sha1(prefix + text) in <data>/models/embed/cache.sqlite.
"""
from __future__ import annotations

import hashlib
import shutil
import sqlite3
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np

from .. import config

NAME = "multilingual-e5-small"
DIM = 384
MAX_LEN = 512
HF = "https://huggingface.co/intfloat/multilingual-e5-small/resolve/main/"
FILES = {"model.onnx": "onnx/model.onnx", "tokenizer.json": "onnx/tokenizer.json"}
REPO_DIR = Path(__file__).resolve().parents[3] / "models" / "embed" / NAME / "onnx"

_lock = threading.Lock()
_db_lock = threading.Lock()
_sess = None
_tok = None
_inputs: list[str] = []
STATS = {"load_s": None, "encoded": 0, "cache_hits": 0, "encode_s": 0.0}


def model_dir() -> Path:
    return config.sub("models") / "embed" / NAME


def available() -> bool:
    d = model_dir()
    if all((d / f).exists() for f in FILES):
        return True
    return all((REPO_DIR / f).exists() for f in FILES)


def ensure_model(job=None) -> Path:
    d = model_dir()
    d.mkdir(parents=True, exist_ok=True)
    for f, rel in FILES.items():
        dst = d / f
        if dst.exists():
            continue
        src = REPO_DIR / f
        tmp = dst.with_suffix(dst.suffix + ".part")
        if src.exists():
            if job:
                job.update(0.0, f"copying embedding model {f}")
            shutil.copyfile(src, tmp)
        else:
            if job:
                job.update(0.0, f"downloading embedding model {f} (Hugging Face)")
            req = urllib.request.Request(HF + rel, headers={"User-Agent": "viku-engine"})
            with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as o:
                shutil.copyfileobj(r, o, 1 << 20)
        tmp.replace(dst)
    lic = d / "LICENSE.txt"
    if not lic.exists():
        lic.write_text("intfloat/multilingual-e5-small - MIT License - https://huggingface.co/intfloat/multilingual-e5-small\n",
                       encoding="utf-8")
    return d


def _load():
    global _sess, _tok, _inputs
    if _sess is not None:
        return
    with _lock:
        if _sess is not None:
            return
        import onnxruntime as ort
        from tokenizers import Tokenizer
        t = time.perf_counter()
        d = ensure_model()
        so = ort.SessionOptions()
        so.log_severity_level = 3
        sess = ort.InferenceSession(str(d / "model.onnx"), so, providers=["CPUExecutionProvider"])
        tok = Tokenizer.from_file(str(d / "tokenizer.json"))
        tok.enable_truncation(MAX_LEN)
        tok.no_padding()
        _inputs = [i.name for i in sess.get_inputs()]
        _tok, _sess = tok, sess
        STATS["load_s"] = round(time.perf_counter() - t, 2)


def _encode(texts: list[str], batch: int = 32) -> np.ndarray:
    """Raw encode (no cache). Sorted by token length so batches carry little padding."""
    _load()
    enc = _tok.encode_batch(texts)
    order = np.argsort([len(e.ids) for e in enc])
    out = np.zeros((len(texts), DIM), np.float32)
    t = time.perf_counter()
    k = 0
    while k < len(order):
        # token budget per batch keeps long passages from blowing up memory
        idx = [order[k]]
        L = len(enc[order[k]].ids)
        k += 1
        while k < len(order) and len(idx) < batch and len(enc[order[k]].ids) * (len(idx) + 1) <= 8192:
            idx.append(order[k])
            L = len(enc[order[k]].ids)
            k += 1
        ids = np.zeros((len(idx), L), np.int64)
        mask = np.zeros((len(idx), L), np.int64)
        for r, i in enumerate(idx):
            e = enc[i].ids
            ids[r, :len(e)] = e
            mask[r, :len(e)] = 1
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in _inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        h = _sess.run(None, feed)[0]
        m = mask[..., None].astype(np.float32)
        v = (h * m).sum(1) / np.maximum(m.sum(1), 1e-9)
        v /= np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)
        out[idx] = v
    STATS["encode_s"] += time.perf_counter() - t
    STATS["encoded"] += len(texts)
    return out


def _db() -> sqlite3.Connection:
    c = sqlite3.connect(model_dir() / "cache.sqlite", timeout=30, check_same_thread=False)
    c.execute("CREATE TABLE IF NOT EXISTS emb(h TEXT PRIMARY KEY, v BLOB)")
    return c


def key(text: str, prefix: str) -> str:
    return hashlib.sha1((prefix + (text or "")).encode("utf-8")).hexdigest()


def embed_texts(texts: list[str], prefix: str = "passage: ", batch: int = 32, cache: bool = True,
                progress=None) -> np.ndarray:
    """(n, 384) float32, L2-normalised. `progress(done, total)` is called between chunks."""
    texts = [(t or "").strip() for t in texts]
    if not texts:
        return np.zeros((0, DIM), np.float32)
    if not cache:
        out = np.zeros((len(texts), DIM), np.float32)
        step = 512
        for a in range(0, len(texts), step):
            out[a:a + step] = _encode([prefix + t for t in texts[a:a + step]], batch)
            if progress:
                progress(min(a + step, len(texts)), len(texts))
        return out
    model_dir().mkdir(parents=True, exist_ok=True)
    keys = [key(t, prefix) for t in texts]
    out = np.zeros((len(texts), DIM), np.float32)
    have: dict[str, np.ndarray] = {}
    with _db_lock:
        c = _db()
        uk = list(dict.fromkeys(keys))
        for a in range(0, len(uk), 500):
            ch = uk[a:a + 500]
            for h, v in c.execute(f"SELECT h, v FROM emb WHERE h IN ({','.join('?' * len(ch))})", ch):
                have[h] = np.frombuffer(v, np.float32)
        c.close()
    STATS["cache_hits"] += sum(1 for k in keys if k in have)
    todo = list(dict.fromkeys(k for k in keys if k not in have))
    if todo:
        first = {k: t for k, t in zip(keys, texts)}
        step = 512
        for a in range(0, len(todo), step):
            ch = todo[a:a + step]
            V = _encode([prefix + first[k] for k in ch], batch)
            with _db_lock:
                c = _db()
                c.executemany("INSERT OR REPLACE INTO emb VALUES(?,?)", [(k, v.tobytes()) for k, v in zip(ch, V)])
                c.commit()
                c.close()
            for k, v in zip(ch, V):
                have[k] = v
            if progress:
                progress(min(a + step, len(todo)), len(todo))
    for i, k in enumerate(keys):
        out[i] = have[k]
    return out


def embed_one(text: str, prefix: str = "query: ") -> np.ndarray:
    return embed_texts([text], prefix)[0]


# ------------------------------------------------------------ favourites --
def similarity_to_favourites(text: str) -> float:
    """cos(text, kept centroid) - cos(text, rejected centroid); centroids from the shipped seed ranker
    (and the learned ranker once /learn has run). 0.0 when no model."""
    from . import ranker
    m = ranker.load_model()
    cp, cn = m.get("centroid_pos"), m.get("centroid_neg")
    if not cp or not cn or not available():
        return 0.0
    v = embed_texts([text])[0]
    return float(v @ np.asarray(cp, np.float32) - v @ np.asarray(cn, np.float32))
