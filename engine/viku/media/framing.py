"""Fixed framing: one crop per camera shot / jump-cut segment, scale + crop only.

YuNet (OpenCV face detector, assets/yunet.onnx) runs ONLY to choose each crop (port of track.py +
static_tracks.py). The crop never moves inside a shot:
  - speaker stays put (2-98 % spread of his x <= 250 px): tight 9:16 crop (405 px of 1280) on his median
  - speaker walks: a wider crop covering his path + margin, scaled to full width over a blurred fill
Jump-cut segments alternate a static punch-in z = 1.0 / 1.12.
`compose()` turns a 1280x720 RGB frame into the 1080x1920 output with a given crop.
"""
from __future__ import annotations

import subprocess

import cv2
import numpy as np

from ..config import ASSETS
from ..jobs import Job
from . import ff

W, H, CW = 1280, 720, 405
OW, OH = 1080, 1920
SAMPLE = 6
SW, SH = 640, 360
STILL, MARGIN, PUNCH = 250, 320, 1.12


def track_faces(src: str, dur: float, job: Job, prog=(0.0, 1.0)) -> tuple[np.ndarray, list[int]]:
    """-> (cx per sample at SAMPLE/s in 1280-px source coords, NaN where unknown), sample idx of camera cuts."""
    det = cv2.FaceDetectorYN.create(str(ASSETS / "yunet.onnx"), "", (SW, SH), 0.6)
    p = job.popen([ff.ffmpeg(), "-nostdin", "-loglevel", "error", "-i", src, "-vf", f"fps={SAMPLE},scale={SW}:{SH}",
                   "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    raw, cuts, prev, miss, last, i = [], [], None, 0, None, 0
    n = SW * SH * 3
    total = max(int(dur * SAMPLE), 1)
    try:
        while True:
            b = p.stdout.read(n)
            if len(b) < n:
                break
            f = np.frombuffer(b, np.uint8).reshape(SH, SW, 3)
            small = cv2.cvtColor(cv2.resize(f, (160, 90)), cv2.COLOR_BGR2GRAY).astype(np.int16)
            if last is not None and np.abs(small - last).mean() > 28:
                if not cuts or i - cuts[-1] >= SAMPLE // 2:  # one cut per flash / fast pan
                    cuts.append(i)
                prev = None
            last = small
            _, faces = det.detect(f)
            cands = [] if faces is None else [((x + w / 2) * W / SW, w, s) for x, y, w, h, *_, s in faces]
            cands = [c for c in cands if c[1] > 18]
            pick = None
            if cands:
                if prev is None or miss >= SAMPLE:
                    pick = max(cands, key=lambda c: c[1] * c[2])[0]
                else:
                    near = [c for c in cands if abs(c[0] - prev) < 200]
                    if near:
                        pick = min(near, key=lambda c: abs(c[0] - prev))[0]
            raw.append(np.nan if pick is None else pick)
            if pick is None:
                miss += 1
            else:
                prev, miss = pick, 0
            i += 1
            if i % SAMPLE == 0:
                job.check()
                job.update(prog[0] + (prog[1] - prog[0]) * min(i / total, 1), "framing: finding the speaker")
        p.wait()
    finally:
        job.release(p)
    return np.array(raw, float), cuts


def static_crops(cx_s: np.ndarray, cam_cuts: list[int], jumps: list[float], dur: float) -> list[dict]:
    """Per-shot fixed crops in reel seconds: [{"t0","t1","cx","cw","z"}]."""
    n = len(cx_s)
    xs = cx_s.copy()
    hit = ~np.isnan(xs)
    idx = np.arange(n)
    xs = np.interp(idx, idx[hit], xs[hit]) if hit.any() else np.full(n, W / 2)
    # times: camera cuts at sample precision, jumps exact
    cam_t = {round(c / SAMPLE, 3) for c in cam_cuts if 0 < c < n}
    cam_t = {t for t in cam_t if all(abs(t - j) > 0.3 for j in jumps)}  # a join is itself a cut
    cut_t = sorted(cam_t | {round(t, 3) for t in jumps if 0 < t < dur})
    edges_t = [0.0] + cut_t + [round(dur, 3)]
    seg_z = []
    for t in edges_t[:-1]:
        k = sum(1 for j in jumps if j <= t + 1e-6)
        seg_z.append(PUNCH if (jumps and k % 2) else 1.0)
    crops = []
    for (t0, t1), z in zip(zip(edges_t[:-1], edges_t[1:]), seg_z):
        if t1 - t0 < 1e-3:
            continue
        a, b = int(t0 * SAMPLE), max(int(np.ceil(t1 * SAMPLE)), int(t0 * SAMPLE) + 1)
        seg = xs[min(a, n - 1):min(b, n)] if n else np.array([W / 2])
        if len(seg) == 0:
            seg = np.array([xs[-1] if n else W / 2])
        k = 3
        pad = np.pad(seg, k, mode="edge")
        seg = np.array([np.median(pad[j:j + 2 * k + 1]) for j in range(len(seg))])
        lo, hi = np.percentile(seg, [2, 98])
        if hi - lo <= STILL:
            w, c = CW, (lo + hi) / 2
        else:
            w, c = float(min(max(hi - lo + MARGIN, CW), W)), (lo + hi) / 2
        c = min(max(c, w / 2), W - w / 2)
        crops.append({"t0": round(t0, 3), "t1": round(t1, 3), "cx": round(float(c), 1), "cw": round(float(w), 1),
                      "z": round(z, 3)})
    return crops


def crop_at(crops: list[dict], t: float) -> dict:
    for c in crops:
        if c["t0"] - 1e-6 <= t < c["t1"]:
            return c
    return crops[-1] if crops else {"cx": W / 2, "cw": CW, "z": 1.0}


def compose(f: np.ndarray, x: float, cw: float = CW, z: float = 1.0) -> np.ndarray:
    """Source frame (720x1280 RGB) -> 1080x1920 by scale + crop only (reel_track.compose)."""
    fw = W
    if z > 1.001:
        ch = int(round(H / z))
        y0 = int(round((H - ch) * 0.30))
        fw = int(round(W * z))
        f = cv2.resize(f[y0:y0 + ch], (fw, H), interpolation=cv2.INTER_CUBIC)
        x = x * z
    cw = int(round(min(max(cw, CW), fw)))
    a = int(round(min(max(x - cw / 2, 0), fw - cw)))
    crop = f[:, a:a + cw]
    if cw <= CW + 1:
        return cv2.resize(crop, (OW, OH), interpolation=cv2.INTER_LANCZOS4)
    fh = int(round(H * OW / cw))
    fg = cv2.resize(crop, (OW, fh), interpolation=cv2.INTER_LANCZOS4)
    b0 = int(round(min(max(x - CW / 2, 0), fw - CW)))
    bg = cv2.resize(f[:, b0:b0 + CW], (OW // 8, OH // 8), interpolation=cv2.INTER_AREA)
    bg = cv2.GaussianBlur(bg, (0, 0), 6)
    bg = (cv2.resize(bg, (OW, OH), interpolation=cv2.INTER_LINEAR) * 0.45).astype(np.uint8)
    y = (OH - fh) // 2
    bg[y:y + fh] = fg
    return bg


def plan_crops(src: str, dur: float, jumps: list[float], job: Job, prog=(0.0, 1.0)) -> list[dict]:
    cx, cuts = track_faces(src, dur, job, prog)
    if len(cx) == 0:
        return [{"t0": 0.0, "t1": round(dur, 3), "cx": W / 2, "cw": CW, "z": 1.0}]
    return static_crops(cx, cuts, jumps, dur)

