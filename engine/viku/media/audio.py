"""Energy analysis of the 16 kHz mono wav: frame dB, voiced mask, pauses, ASR chunks, peaks.

The segmenter is a port of IndicConformerASR/subtitles.py: speech threshold relative to the
loud parts of the recording, voiced frames grouped while bridging short gaps, long pieces
cut recursively at their quietest frame.
"""
from __future__ import annotations

import numpy as np

SR = 16000
FRAME = 0.02  # 20 ms


def frame_db(wav: np.ndarray) -> np.ndarray:
    hop = int(SR * FRAME)
    n = len(wav) // hop
    if n == 0:
        return np.zeros(0, np.float32)
    fr = wav[: n * hop].reshape(n, hop).astype(np.float32)
    return (20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9)).astype(np.float32)


def threshold(db: np.ndarray) -> float:
    if len(db) == 0:
        return -60.0
    return float(max(np.percentile(db, 95) - 30, np.percentile(db, 10) + 6))


def voiced_runs(db: np.ndarray, min_gap: float, thresh: float | None = None) -> list[tuple[int, int]]:
    th = threshold(db) if thresh is None else thresh
    voiced = db > th
    segs, start, last = [], None, None
    gap = int(round(min_gap / FRAME))
    for i in np.flatnonzero(voiced):
        if start is None:
            start = i
        elif i - last > gap:
            segs.append((start, last + 1))
            start = i
        last = i
    if start is not None:
        segs.append((start, last + 1))
    return segs


def pauses(db: np.ndarray, offset: float = 0.0, min_pause: float = 0.25, thresh: float | None = None) -> list[list[float]]:
    """Silences >= min_pause between voiced runs, absolute seconds."""
    runs = voiced_runs(db, 0.0, thresh)
    out = []
    for (a0, b0), (a1, _) in zip(runs, runs[1:]):
        g = (a1 - b0) * FRAME
        if g >= min_pause:
            out.append([round(offset + b0 * FRAME, 3), round(offset + a1 * FRAME, 3)])
    return out


def segment(wav: np.ndarray, max_cue: float = 6.0, min_gap: float = 0.30, min_len: float = 0.4,
            thresh: float | None = None) -> list[tuple[float, float]]:
    """Speech chunks (seconds relative to wav start) for ASR / caption cues."""
    db = frame_db(wav)
    n = len(db)
    segs = voiced_runs(db, min_gap, thresh)
    out, maxf = [], int(max_cue / FRAME)
    stack = list(reversed(segs))
    while stack:
        a, b = stack.pop()
        if b - a <= maxf:
            out.append((a, b))
            continue
        lo, hi = a + maxf // 3, min(b - maxf // 3, a + maxf)
        cut = lo + int(np.argmin(db[lo:hi])) if hi > lo else a + maxf
        stack += [(cut, b), (a, cut)]
    pad = int(0.15 / FRAME)
    return [(round(max(0, a - pad) * FRAME, 3), round(min(n, b + pad) * FRAME, 3))
            for a, b in out if (b - a) * FRAME >= min_len]


def peaks(wav: np.ndarray, per_sec: int = 100) -> np.ndarray:
    """(N, 2) int8 min/max per bucket of 1/per_sec s."""
    hop = SR // per_sec
    n = len(wav) // hop
    if n == 0:
        return np.zeros((0, 2), np.int8)
    fr = wav[: n * hop].reshape(n, hop)
    mn = np.clip(fr.min(1) * 127, -127, 127).astype(np.int8)
    mx = np.clip(fr.max(1) * 127, -127, 127).astype(np.int8)
    return np.stack([mn, mx], 1)


def resample_peaks(pk: np.ndarray, per_sec: int, start: float, end: float, px: int) -> list[list[int]]:
    a = max(0, int(start * per_sec))
    b = min(len(pk), max(a + 1, int(end * per_sec)))
    seg = pk[a:b]
    if len(seg) == 0 or px <= 0:
        return []
    edges = np.linspace(0, len(seg), px + 1).astype(int)
    out = []
    for i in range(px):
        s = seg[edges[i]:max(edges[i + 1], edges[i] + 1)]
        out.append([int(s[:, 0].min()), int(s[:, 1].max())] if len(s) else [0, 0])
    return out
