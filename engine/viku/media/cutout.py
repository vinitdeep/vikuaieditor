"""Offline pastor cut-out for thumbnails: U²-Net human segmentation (ONNX, CPU) + the SKILL.md fixes.

Model: `u2net_human_seg.onnx` from the rembg releases
(https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx), downloaded once into
`<data>/models/cutout/`. U²-Net (Qin et al. 2020, github.com/xuebinqin/U-2-Net) is Apache-2.0; rembg (which
publishes this ONNX export) is MIT. The licence note is written next to the model on download.

Pipeline (bust() / cut()):
  1. YuNet finds the face in the full-res source frame; a waist-up box is cropped around it.
  2. U²-Net -> soft alpha; keep only the largest connected component (drops logo blobs / other people).
  3. Seal the waist line, fill holes inside the closed silhouette, and make dark (jacket) pixels inside it
     opaque again, with colours taken from the ORIGINAL frame.
  4. Desaturate dark teal-hued pixels (stage light turns his black hair green/teal).
  5. Clear bright pixels just above the hair (halo of the backdrop).
"""
from __future__ import annotations

import threading
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from .. import config
from ..config import ASSETS

MODEL = "u2net_human_seg.onnx"
URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx"
LICENCE = """u2net_human_seg.onnx - human segmentation model used by Viku for thumbnail cut-outs.
Source:  {url}
Model:   U^2-Net (Xuebin Qin et al., "U^2-Net: Going Deeper with Nested U-Structure for Salient Object
         Detection", Pattern Recognition 2020), https://github.com/xuebinqin/U-2-Net - Apache License 2.0.
Export:  rembg by Daniel Gatis, https://github.com/danielgatis/rembg - MIT License.
Runtime: onnxruntime (MIT), CPUExecutionProvider.
"""
_sess = None
_lock = threading.Lock()


def model_dir() -> Path:
    d = config.sub("models") / "cutout"
    d.mkdir(parents=True, exist_ok=True)
    return d


def model_path() -> Path:
    return model_dir() / MODEL


def ready() -> bool:
    return model_path().exists()


def ensure_model(job=None) -> Path:
    f = model_path()
    if not f.exists():
        if job is not None:
            job.update(None, "downloading cut-out model (176 MB, once)")
        tmp = f.with_suffix(".part")
        req = urllib.request.Request(URL, headers={"User-Agent": "viku-engine"})
        with urllib.request.urlopen(req, timeout=300) as r, tmp.open("wb") as out:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                out.write(b)
                if job is not None:
                    job.check()
        tmp.replace(f)
    lic = model_dir() / "LICENSE.txt"
    if not lic.exists():
        lic.write_text(LICENCE.format(url=URL), encoding="utf-8")
    return f


def session():
    global _sess
    with _lock:
        if _sess is None:
            import onnxruntime as ort
            _sess = ort.InferenceSession(str(ensure_model()), providers=["CPUExecutionProvider"])
        return _sess


def segment(bgr: np.ndarray) -> np.ndarray:
    """-> alpha float32 [0,1], same size as the input (rembg's u2net pre/post-processing)."""
    h, w = bgr.shape[:2]
    x = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (320, 320), interpolation=cv2.INTER_LANCZOS4).astype(np.float32)
    x /= max(float(x.max()), 1e-6)
    x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    s = session()
    out = s.run(None, {s.get_inputs()[0].name: x.transpose(2, 0, 1)[None]})[0][0, 0]
    out = (out - out.min()) / max(float(out.max() - out.min()), 1e-6)
    return cv2.resize(out, (w, h), interpolation=cv2.INTER_LINEAR).astype(np.float32)


# ------------------------------------------------------------------ faces --
def faces(bgr: np.ndarray, thr: float = 0.6) -> np.ndarray:
    """YuNet on a BGR frame -> rows [x,y,w,h, re(x,y), le(x,y), nose(x,y), rm(x,y), lm(x,y), score]."""
    h, w = bgr.shape[:2]
    det = cv2.FaceDetectorYN.create(str(ASSETS / "yunet.onnx"), "", (w, h), thr)
    _, f = det.detect(bgr)
    return np.zeros((0, 15), np.float32) if f is None else f


def main_face(bgr: np.ndarray):
    f = faces(bgr)
    if not len(f):
        return None
    return max(f, key=lambda r: r[2] * r[3] * r[14])


def pose_score(bgr: np.ndarray) -> tuple[float, dict]:
    """Thumbnail pose quality: YuNet confidence x face size x frontal symmetry x eyes-open x sharpness."""
    f = main_face(bgr)
    if f is None:
        return 0.0, {}
    x, y, w, h = f[:4]
    rex, rey, lex, ley, nx, ny = f[4:10]
    conf = float(f[14])
    size = min(w / 90.0, 1.5)                              # ~90 px face (720p) is a good waist-up source
    ed = max(abs(lex - rex), 1.0)
    asym = abs(nx - (rex + lex) / 2) / ed                  # 0 = nose centred between the eyes
    roll = abs(ley - rey) / ed
    frontal = max(0.0, 1 - 1.6 * asym - 1.0 * roll)
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    r = max(int(ed * 0.22), 2)

    def patch(cx, cy):
        a, b = int(cy) - r, int(cx) - r
        return g[max(a, 0):a + 2 * r + 1, max(b, 0):b + 2 * r + 1]
    fx0, fy0 = int(max(x, 0)), int(max(y, 0))
    face = g[fy0:int(y + h), fx0:int(x + w)]
    if face.size == 0:
        return 0.0, {}
    fs = float(face.std()) + 1e-3
    pe = [patch(rex, rey), patch(lex, ley)]
    # open eyes: dark pupil + white sclera -> high local contrast; closed lids are flat skin
    eye = float(np.mean([(p.max() - p.min()) / (4 * fs) if p.size else 0 for p in pe]))
    eyes_open = min(eye, 1.2)
    sharp = min(float(cv2.Laplacian(face, cv2.CV_32F).var()) / 60.0, 1.0)
    score = conf * size * (0.25 + frontal) * (0.3 + eyes_open) * (0.5 + 0.5 * sharp)
    return float(score), {"conf": round(conf, 3), "face_w": round(float(w), 1), "frontal": round(float(frontal), 3),
                          "eyes_open": round(eyes_open, 3), "sharp": round(sharp, 3)}


# ---------------------------------------------------------------- cut-out --
def _largest(mask: np.ndarray) -> np.ndarray:
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if n <= 1:
        return mask.astype(bool)
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return lab == k


def _fill_holes(m: np.ndarray) -> np.ndarray:
    h, w = m.shape
    pad = np.zeros((h + 2, w + 2), np.uint8)
    pad[1:-1, 1:-1] = m.astype(np.uint8)
    ff = pad.copy()
    cv2.floodFill(ff, np.zeros((h + 4, w + 4), np.uint8), (0, 0), 1)
    holes = ff[1:-1, 1:-1] == 0
    return m | holes


def fix(bgr: np.ndarray, alpha: np.ndarray, head_y: int | None = None) -> np.ndarray:
    """Soft alpha -> cleaned BGRA cut-out (SKILL.md 'Thumbnail cut-out fixes')."""
    h, w = alpha.shape
    a = alpha.copy()
    core = _largest(a > 0.5)
    # soft edge only around the kept component
    near = cv2.dilate(core.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    a[~near] = 0
    # seal the waist line: the bottom rows between the outermost silhouette columns
    sealed = core.copy()
    bot = core[-6:].any(0)
    if bot.any():
        xs = np.where(bot)[0]
        sealed[-3:, xs.min():xs.max() + 1] = True
    k = max(3, int(round(min(h, w) * 0.03)) | 1)
    closed = cv2.morphologyEx(sealed.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))) > 0
    inside = _fill_holes(closed)
    inside_core = cv2.erode(inside.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    V = hsv[..., 2].astype(np.float32) / 255
    dark = V < 0.42
    # holes / semi-transparent patches in the dark jacket -> opaque (colours stay the ORIGINAL frame's)
    a[inside_core & (dark | (a > 0.15))] = 1.0
    a[inside_core & ~closed] = np.maximum(a[inside_core & ~closed], 1.0)
    # teal/green hair cast: dark (V < .55) green-teal hue (OpenCV H 35-105 ~ 70-210 deg; measured median 72)
    # -> desaturate. Only above head_y (hair + beard) so a blue-lit jacket keeps its colour.
    out = bgr.copy()
    teal = (V < 0.55) & (hsv[..., 0] >= 35) & (hsv[..., 0] <= 105) & (hsv[..., 1] > 40) & (a > 0.05)
    if head_y is not None:  # hair only: the jacket under blue light must keep its colour
        teal[int(max(head_y, 0)):] = False
    if teal.any():
        hs = hsv.copy()
        hs[..., 1][teal] = (hs[..., 1][teal] * 0.12).astype(np.uint8)
        out = np.where(teal[..., None], cv2.cvtColor(hs, cv2.COLOR_HSV2BGR), out)
    # bright backdrop pixels just above the hair: first rows of the silhouette in each column
    ys = np.argmax(core, axis=0)
    has = core.any(0)
    band = max(4, int(h * 0.012))
    for x in np.where(has)[0]:
        y0 = ys[x]
        seg = slice(max(y0 - 2, 0), y0 + band)
        bright = V[seg, x] > 0.75
        col = a[seg, x]
        col[bright] = 0
        a[seg, x] = col
    # pull the edge in ~2 px: the bright backdrop bleeds into the outermost pixels (light fringe)
    a = np.minimum(a, cv2.erode(a, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))))
    a = cv2.GaussianBlur(a, (0, 0), 0.8)
    return np.dstack([out, np.clip(a * 255, 0, 255).astype(np.uint8)])


def bust_box(face, fw: int, fh: int) -> tuple[int, int, int, int]:
    """Waist-up box around a YuNet face row -> (x0, y0, x1, y1) in frame pixels."""
    x, y, w, h = [float(v) for v in face[:4]]
    cx = x + w / 2
    half = w * 3.5
    y0 = y - h * 0.9
    y1 = y + h * 4.6
    return (int(max(cx - half, 0)), int(max(y0, 0)), int(min(cx + half, fw)), int(min(y1, fh)))


def podium_top(frame: np.ndarray, face, y1: int) -> int:
    """A laptop / pulpit in front of him is part of the 'person' to U²-Net: cut the bust above the first
    row (from the chest down) where the band under his face is mostly near-black and flat."""
    x, y, w, h = [float(v) for v in face[:4]]
    a, b = int(max(x - w * 0.6, 0)), int(min(x + w * 1.6, frame.shape[1]))
    V = cv2.cvtColor(frame[:, a:b], cv2.COLOR_BGR2HSV)[..., 2]
    start = int(y + h * 2.2)
    for yy in range(start, min(int(y1), frame.shape[0])):
        row = V[yy]
        if (row < 45).mean() > 0.6 and (V[min(yy + 6, frame.shape[0] - 1)] < 45).mean() > 0.6:
            return max(yy - 2, start)
    return int(y1)


def bust(frame: np.ndarray, target_h: int = 1100) -> tuple[np.ndarray, dict]:
    """Full source frame (BGR) -> (BGRA waist-up cut-out cropped to its silhouette, info)."""
    fh, fw = frame.shape[:2]
    f = main_face(frame)
    if f is None:
        x0, y0, x1, y1 = int(fw * 0.3), 0, int(fw * 0.7), fh
        info = {"face": None}
    else:
        x0, y0, x1, y1 = bust_box(f, fw, fh)
        y1 = podium_top(frame, f, y1)
        info = {"face": [round(float(v), 1) for v in f[:4]], "face_conf": round(float(f[14]), 3)}
    crop = frame[y0:y1, x0:x1]
    # upscale small crops first so the model + fixes see enough pixels
    sc = max(1.0, min(target_h / max(crop.shape[0], 1), 4.0))
    if sc > 1.01:
        crop = cv2.resize(crop, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
        blur = cv2.GaussianBlur(crop, (0, 0), 1.2)
        crop = cv2.addWeighted(crop, 1.5, blur, -0.5, 0)  # light unsharp after the upscale
    head_y = None if f is None else int((float(f[1]) + float(f[3]) * 1.1 - y0) * sc)
    rgba = fix(crop, segment(crop), head_y)
    ys, xs = np.where(rgba[..., 3] > 8)
    if len(ys):
        rgba = rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    info.update({"box": [x0, y0, x1, y1], "scale": round(sc, 3), "size": [int(rgba.shape[1]), int(rgba.shape[0])],
                 "touches_bottom": bool(len(ys) and ys.max() >= crop.shape[0] - 3), "model": MODEL})
    # face position inside the returned cut-out (for layouts that must keep the face clear)
    if f is not None:
        fx = (float(f[0]) - x0) * sc - (xs.min() if len(xs) else 0)
        fy = (float(f[1]) - y0) * sc - (ys.min() if len(ys) else 0)
        info["face_in_cut"] = [round(fx, 1), round(fy, 1), round(float(f[2]) * sc, 1), round(float(f[3]) * sc, 1)]
    return rgba, info
