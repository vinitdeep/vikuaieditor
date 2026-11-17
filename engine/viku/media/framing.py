"""Speaker framing for the 9:16 reel: scale + crop only, never a synthetic zoom inside a shot.

YuNet (OpenCV face detector, assets/yunet.onnx) samples the speaker's face x at SAMPLE/s (port of track.py +
static_tracks.py). Two modes, per reel (`reel["framing"]`):
  - "follow" (auto framing, the default): a tight 9:16 crop that pans with the speaker so he stays centred. The
    path is a camera operator's: sway inside a small dead zone never moves the frame, a walk is followed, and the
    moves are eased (zero-phase, so the camera starts moving with him, not after him). Paths reset at every camera
    cut and jump cut. They are stored by SOURCE time in `reel["follow"]` ([{"s","e","x"}], x at FOLLOW_RATE/s in
    1280-px coords), so trims / splits / moves in the editor keep working without a rebuild.
  - "fixed": one crop per shot that never moves:
      speaker stays put (2-98 % spread of his x <= 250 px): tight 9:16 crop (405 px of 1280) on his median
      speaker walks: a wider crop covering his path + margin, scaled to full width over a blurred fill
Each crop carries `ax`, the follow anchor it was made from; in follow mode the frame is at path + (cx - ax), so
dragging a crop in the editor offsets the whole follow. Jump-cut segments alternate a static punch-in z = 1.0 / 1.12.
`compose()` turns a 1280x720 RGB frame into the 1080x1920 output with a given crop.
"""
from __future__ import annotations

import subprocess

import cv2

try:  # errors only: YuNet spams a 'Targets are not supported' warning per detector
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
except AttributeError:
    pass
import numpy as np

from ..config import ASSETS
from ..jobs import Job
from . import ff

W, H, CW = 1280, 720, 405
OW, OH = 1080, 1920
SAMPLE = 6
SW, SH = 640, 360
STILL, MARGIN, PUNCH = 250, 320, 1.12
FOLLOW_RATE = 10     # follow path samples per second (source time)
DEAD = 20.0          # px of 1280 (~5 % of the output width): sway inside this never moves the frame
EASE = 0.40          # s, sigma of the zero-phase gaussian that eases every move


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


def _clean(cx_s: np.ndarray) -> np.ndarray:
    """Face x per sample with gaps filled (linear, held at the ends) and single-sample glitches removed."""
    n = len(cx_s)
    if n == 0:
        return np.array([W / 2])
    xs = cx_s.astype(float).copy()
    hit = ~np.isnan(xs)
    idx = np.arange(n)
    xs = np.interp(idx, idx[hit], xs[hit]) if hit.any() else np.full(n, W / 2)
    k = 1
    pad = np.pad(xs, k, mode="edge")
    return np.array([np.median(pad[j:j + 2 * k + 1]) for j in range(n)])


def shot_edges(n: int, cam_cuts: list[int], jumps: list[float], dur: float) -> tuple[list[float], list[float]]:
    """-> (edges in reel seconds [0, cuts..., dur], punch-in z per shot)."""
    cam_t = {round(c / SAMPLE, 3) for c in cam_cuts if 0 < c < n}
    cam_t = {t for t in cam_t if all(abs(t - j) > 0.3 for j in jumps)}  # a join is itself a cut
    cut_t = sorted(cam_t | {round(t, 3) for t in jumps if 0 < t < dur})
    edges_t = [0.0] + [t for t in cut_t if t < dur - 1e-3] + [round(dur, 3)]
    seg_z = []
    for t in edges_t[:-1]:
        k = sum(1 for j in jumps if j <= t + 1e-6)
        seg_z.append(PUNCH if (jumps and k % 2) else 1.0)
    return edges_t, seg_z


def _shot_samples(xs: np.ndarray, t0: float, t1: float) -> np.ndarray:
    n = len(xs)
    a, b = int(t0 * SAMPLE), max(int(np.ceil(t1 * SAMPLE)), int(t0 * SAMPLE) + 1)
    seg = xs[min(a, n - 1):min(b, n)] if n else np.array([W / 2])
    return seg if len(seg) else np.array([xs[-1] if n else W / 2])


def static_crops(cx_s: np.ndarray, cam_cuts: list[int], jumps: list[float], dur: float) -> list[dict]:
    """Per-shot fixed crops in reel seconds: [{"t0","t1","cx","cw","z"}]."""
    n = len(cx_s)
    xs = cx_s.copy()
    hit = ~np.isnan(xs)
    idx = np.arange(n)
    xs = np.interp(idx, idx[hit], xs[hit]) if hit.any() else np.full(n, W / 2)
    edges_t, seg_z = shot_edges(n, cam_cuts, jumps, dur)
    crops = []
    for (t0, t1), z in zip(zip(edges_t[:-1], edges_t[1:]), seg_z):
        if t1 - t0 < 1e-3:
            continue
        seg = _shot_samples(xs, t0, t1)
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


def _gauss(x: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0 or len(x) < 3:
        return x
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    return np.convolve(np.pad(x, r, mode="edge"), k, mode="valid")


def _backlash(x: np.ndarray, dead: float, p0: float) -> np.ndarray:
    out, p = np.empty_like(x), p0
    for i, v in enumerate(x):
        if v > p + dead:
            p = v - dead
        elif v < p - dead:
            p = v + dead
        out[i] = p
    return out


def follow_path(x: np.ndarray, half: float = CW / 2, dead: float = DEAD, ease: float = EASE,
                rate: float = FOLLOW_RATE) -> np.ndarray:
    """Face x (one shot, `rate`/s) -> camera centre x: dead zone (forward + backward pass averaged, so the camera
    neither lags nor leads), zero-phase eased, kept inside the frame. A path that would move less than 6 px is
    held still."""
    x = np.clip(np.asarray(x, float), half, W - half)
    if len(x) == 0:
        return x
    m = min(len(x), int(rate))
    fwd = _backlash(x, dead, float(np.median(x[:m])))
    bwd = _backlash(x[::-1], dead, float(np.median(x[-m:])))[::-1]
    p = _gauss((fwd + bwd) / 2, ease * rate)
    p = np.clip(p, half, W - half)
    if p.max() - p.min() < 6:
        p = np.full_like(p, float(np.median(p)))
    return p


def follow_tracks(cx_s: np.ndarray, cam_cuts: list[int], jumps: list[float], dur: float,
                  segs: list) -> tuple[list[dict], list[dict]]:
    """-> (tight follow crops in reel seconds [{"t0","t1","cx","cw","z","ax"}],
           tracks in source seconds [{"s","e","x"}] with x at FOLLOW_RATE/s)."""
    xs = _clean(cx_s)
    n = len(cx_s)
    edges_t, seg_z = shot_edges(n, cam_cuts, jumps, dur)
    offs, o = [], 0.0
    for s, e in segs:
        offs.append(o)
        o += e - s
    crops, tracks = [], []
    for (t0, t1), z in zip(zip(edges_t[:-1], edges_t[1:]), seg_z):
        if t1 - t0 < 1e-3:
            continue
        # face x at FOLLOW_RATE over the shot (sample i of xs sits at i / SAMPLE reel seconds)
        m = max(int(np.ceil((t1 - t0) * FOLLOW_RATE)) + 1, 2)
        tt = np.minimum(t0 + np.arange(m) / FOLLOW_RATE, t1)
        sh = _shot_samples(xs, t0, t1)
        a = min(int(t0 * SAMPLE), max(len(xs) - 1, 0))
        raw = np.interp(tt * SAMPLE, a + np.arange(len(sh)), sh)
        path = follow_path(raw)
        anchor = round(float(np.median(path)), 1)
        crops.append({"t0": round(t0, 3), "t1": round(t1, 3), "cx": anchor, "cw": float(CW), "z": round(z, 3),
                      "ax": anchor})
        if segs:
            k = max([i for i, of in enumerate(offs) if of <= t0 + 1e-3] or [0])
            s0 = float(segs[k][0]) + (t0 - offs[k])
            tracks.append({"s": round(s0, 3), "e": round(s0 + (t1 - t0), 3),
                           "x": [round(float(v), 1) for v in path]})
    return crops, tracks


def follow_at(tracks: list[dict], src_t: float) -> float | None:
    """Camera centre x of the follow path at a source second (None outside every track)."""
    best = None
    for tr in tracks or []:
        if tr["s"] - 1e-3 <= src_t < tr["e"] + 1e-3:
            if best is None or tr["s"] > best["s"]:  # touching tracks: the later shot owns its first frame
                best = tr
    if best is None or not best.get("x"):
        return None
    x = best["x"]
    u = min(max((src_t - best["s"]) * FOLLOW_RATE, 0.0), len(x) - 1)
    i = int(u)
    j = min(i + 1, len(x) - 1)
    return float(x[i] + (x[j] - x[i]) * (u - i))


def x_at(crop: dict, t: float, mode: str, tracks: list[dict], segs: list, offs: list[float]) -> float:
    """Crop centre x (1280-px) at reel second t: the crop's fixed cx, or in follow mode path + (cx - ax)."""
    cx = float(crop["cx"])
    if mode != "follow" or not tracks or not segs:
        return cx
    k = 0
    for i, of in enumerate(offs):
        if of <= t + 1e-6:
            k = i
    s, e = segs[k]
    src_t = min(float(s) + (t - offs[k]), float(e))
    f = follow_at(tracks, src_t)
    return cx if f is None else f + (cx - float(crop.get("ax", cx)))


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
    t0, t1 = _bars(f)  # the source's own black letterbox rows would show as a line above / below the speaker
    crop = crop[t0:t1]
    fh = int(round(crop.shape[0] * OW / cw))
    fg = cv2.resize(crop, (OW, fh), interpolation=cv2.INTER_LANCZOS4)
    bg = blurred_fill(f, x)
    y = (OH - fh) // 2
    bg[y:y + fh] = fg
    return bg


FILL_GAIN, FILL_SAT, FILL_FLOOR = 0.55, 1.15, 70.0


def _bars(f: np.ndarray, dark: float = 18.0, max_frac: float = 0.12) -> tuple[int, int]:
    """Rows [t0, t1) without near-black letterbox bars at the top / bottom of the source (at most 12 % each side)."""
    h = f.shape[0]
    m = f[: int(h * max_frac)].mean(axis=(1, 2))
    t0 = int(np.argmax(m >= dark)) if (m < dark).any() and (m >= dark).any() else (len(m) if (m < dark).all() else 0)
    mb = f[h - int(h * max_frac):].mean(axis=(1, 2))[::-1]
    b = int(np.argmax(mb >= dark)) if (mb < dark).any() and (mb >= dark).any() else (len(mb) if (mb < dark).all() else 0)
    # + 2 rows: the encoder's soft edge between the bar and the picture is still dark
    return t0 + (2 if t0 else 0), h - b - (2 if b else 0)


def blurred_fill(f: np.ndarray, x: float | None = None) -> np.ndarray:
    """1080x1920 background for a wide (letterboxed) crop, built from the FULL source frame: heavy blur over the whole
    frame first (so the dark ceiling / stage edge mixes with the lit wall), cover-scaled to 9:16 around the speaker,
    ~0.55 brightness, slightly more saturation. Rows darker than the frame's own mean colour are lifted toward it
    (luma floor), so the bands above / below the speaker are never near-black."""
    fh_, fw_ = f.shape[:2]
    small = cv2.resize(f, (max(fw_ // 8, 16), max(fh_ // 8, 9)), interpolation=cv2.INTER_AREA).astype(np.float32)
    small = cv2.GaussianBlur(small, (0, 0), 5)
    sh, sw = small.shape[:2]
    cw = sh * OW / OH  # cover: full height, 9:16 column (of the blurred full frame)
    cx = (sw / 2) if x is None else x * sw / fw_
    a = min(max(cx - cw / 2, 0.0), sw - cw)
    col = cv2.getRectSubPix(small, (max(int(round(cw)), 2), sh), (a + cw / 2, sh / 2))
    bg = cv2.resize(col, (OW // 8, OH // 8), interpolation=cv2.INTER_LINEAR)
    bg = cv2.GaussianBlur(bg, (0, 0), 6)
    # luma floor: blend dark areas toward the whole frame's mean colour (the lit part dominates a church stage)
    mean = small.reshape(-1, 3).mean(0)
    mean = mean * max(1.0, FILL_FLOOR / max(float(mean @ [0.299, 0.587, 0.114]), 1.0))
    luma = bg @ np.array([0.299, 0.587, 0.114], np.float32)
    w = np.clip((FILL_FLOOR - luma) / FILL_FLOOR, 0.0, 1.0)[..., None]
    bg = bg * (1 - w) + mean[None, None, :] * w
    # saturation boost around the pixel's luma, then the dim
    luma = (bg @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
    bg = (luma + (bg - luma) * FILL_SAT) * FILL_GAIN
    bg = cv2.resize(bg, (OW, OH), interpolation=cv2.INTER_LINEAR)
    return np.clip(bg, 0, 255).astype(np.uint8)


def plan_crops(src: str, dur: float, jumps: list[float], job: Job, prog=(0.0, 1.0), segs: list | None = None,
               mode: str = "follow") -> tuple[list[dict], list[dict]]:
    """-> (crops, follow tracks). Tracks are made in both modes so the editor can switch without a rebuild."""
    cx, cuts = track_faces(src, dur, job, prog)
    if len(cx) == 0:
        return [{"t0": 0.0, "t1": round(dur, 3), "cx": W / 2, "cw": CW, "z": 1.0}], []
    fcrops, tracks = follow_tracks(cx, cuts, jumps, dur, segs or [[0.0, dur]])
    if mode == "follow":
        return fcrops, tracks
    crops = static_crops(cx, cuts, jumps, dur)
    for c, f in zip(crops, fcrops):
        c["ax"] = f["ax"]
    return crops, tracks
