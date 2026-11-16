"""multilingual-e5-small on CPU via onnxruntime (no torch / transformers needed).

  python embed.py --selftest          # 1 Odia + 1 Hindi + 1 English sentence: dim + ms/sentence
  python embed.py --windows           # embed ../windows.jsonl -> ../window_embeddings.npy

E5 convention: prefix "query: " for the thing you search with, "passage: " for indexed text.
Pooling = attention-masked mean of last_hidden_state, then L2-normalise.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[3]  # Sermon Reel Studio
MODEL_DIR = ROOT / "models" / "embed" / "multilingual-e5-small" / "onnx"
SEED = Path(__file__).resolve().parents[1]
MAX_LEN = 512


class E5:
    def __init__(self, model_dir=MODEL_DIR, threads=0):
        so = ort.SessionOptions()
        if threads:
            so.intra_op_num_threads = threads
        self.sess = ort.InferenceSession(str(model_dir / "model.onnx"), so, providers=["CPUExecutionProvider"])
        self.tok = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.tok.enable_truncation(MAX_LEN)
        self.inputs = [i.name for i in self.sess.get_inputs()]

    def encode(self, texts, batch=16):
        out = []
        for k in range(0, len(texts), batch):
            enc = self.tok.encode_batch(texts[k:k + batch])
            L = max(len(e.ids) for e in enc)
            ids = np.zeros((len(enc), L), np.int64)
            mask = np.zeros((len(enc), L), np.int64)
            for r, e in enumerate(enc):
                ids[r, :len(e.ids)] = e.ids
                mask[r, :len(e.ids)] = 1
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self.inputs:
                feed["token_type_ids"] = np.zeros_like(ids)
            h = self.sess.run(None, feed)[0]  # last_hidden_state [B, L, 384]
            m = mask[..., None].astype(np.float32)
            v = (h * m).sum(1) / np.maximum(m.sum(1), 1e-9)
            v /= np.linalg.norm(v, axis=1, keepdims=True)
            out.append(v.astype(np.float32))
        return np.concatenate(out, 0)


def selftest():
    sents = {
        "or": "query: ଶୟତାନ ପରାଜିତ ହୋଇସାରିଛି, ଆପଣ ଭୟ କରନ୍ତୁ ନାହିଁ, ପ୍ରଭୁ ଆପଣଙ୍କ ସହିତ ଅଛନ୍ତି।",
        "hi": "query: शैतान हार चुका है, आप डरिए मत, प्रभु आपके साथ है।",
        "en": "query: Satan is already defeated, do not be afraid, the Lord is with you.",
        "en_neg": "query: Next Sunday the service starts at nine thirty, please bring your offering envelopes.",
    }
    t0 = time.perf_counter()
    m = E5()
    load = time.perf_counter() - t0
    names = list(sents)
    m.encode([sents[names[0]]])  # warm-up
    res = {}
    for n in names:
        t = time.perf_counter()
        for _ in range(5):
            v = m.encode([sents[n]])
        res[n] = ((time.perf_counter() - t) / 5 * 1000, len(m.tok.encode(sents[n]).ids))
    V = m.encode([sents[n] for n in names])
    print(f"providers={m.sess.get_providers()} load={load:.2f}s dim={V.shape[1]}")
    for n in names:
        print(f"  {n:6s} tokens={res[n][1]:3d}  {res[n][0]:.1f} ms/sentence")
    S = V @ V.T
    print("cosine or-hi %.3f or-en %.3f hi-en %.3f | en-en_neg %.3f" % (S[0, 1], S[0, 2], S[1, 2], S[2, 3]))
    # throughput on a 45 s window-sized passage, batch of 16
    w = [json.loads(l)["text"] for l in open(SEED / "windows.jsonl", encoding="utf-8")][:32] if (SEED / "windows.jsonl").exists() else []
    if w:
        t = time.perf_counter()
        m.encode(["passage: " + x for x in w])
        print(f"  windows: {len(w)} passages {(time.perf_counter() - t) / len(w) * 1000:.1f} ms/passage (batch 16)")


def embed_windows():
    rows = [json.loads(l) for l in open(SEED / "windows.jsonl", encoding="utf-8")]
    m = E5()
    t = time.perf_counter()
    X = m.encode(["passage: " + r["text"] for r in rows])
    np.save(SEED / "window_embeddings.npy", X.astype(np.float32))
    print(f"embedded {len(rows)} windows -> {X.shape} in {time.perf_counter() - t:.1f}s")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    if "--windows" in sys.argv:
        embed_windows()
