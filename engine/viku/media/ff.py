"""ffmpeg / ffprobe helpers."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

from ..jobs import CREATE_NO_WINDOW, Job

SR16 = 16000


def ffmpeg() -> str:
    """Resolved by the model manager: settings.paths.ffmpeg -> <data>/tools/ffmpeg -> suitable PATH ffmpeg."""
    from .. import models
    return models.ffmpeg()


def ffprobe() -> str:
    from .. import models
    return models.ffprobe()


def probe(path: str) -> dict:
    out = subprocess.run([ffprobe(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                         capture_output=True, check=True, creationflags=CREATE_NO_WINDOW).stdout
    d = json.loads(out)
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), {})
    a = next((s for s in d.get("streams", []) if s.get("codec_type") == "audio"), {})
    fps = 30.0
    if v.get("avg_frame_rate", "0/0") not in ("0/0", ""):
        n, m = v["avg_frame_rate"].split("/")
        fps = float(n) / float(m) if float(m) else 30.0
    return {"duration": float(d.get("format", {}).get("duration", 0) or 0), "width": v.get("width"),
            "height": v.get("height"), "fps": round(fps, 3), "has_audio": bool(a),
            "sample_rate": int(a.get("sample_rate", 0) or 0)}


def duration(path: str) -> float:
    return probe(path)["duration"]


def run(args, job: Job | None = None, **kw):
    args = [ffmpeg() if args[0] == "ffmpeg" else args[0], *args[1:]]
    if job is not None:
        return job.run(args, **kw)
    kw.pop("capture", None)
    return subprocess.run([str(a) for a in args], check=kw.pop("check", True), capture_output=True,
                          creationflags=CREATE_NO_WINDOW, **kw)


def read_wav16(path: str, start: float = 0.0, end: float | None = None) -> np.ndarray:
    """Read (part of) a 16 kHz mono wav as float32."""
    import soundfile as sf
    info = sf.info(str(path))
    a = int(round(start * info.samplerate))
    b = -1 if end is None else int(round(end * info.samplerate))
    x, sr = sf.read(str(path), start=a, stop=None if b < 0 else b, dtype="float32", always_2d=False)
    if x.ndim > 1:
        x = x.mean(1)
    return x


def filter_path(p: str | Path) -> str:
    """Escape a path for use inside an ffmpeg filtergraph option value."""
    s = str(p).replace("\\", "/")
    s = s.replace(":", "\\:").replace("'", "\\'")
    return s


def run_progress(args, job: Job, total: float, prog=(0.0, 1.0), label: str = "encoding"):
    """Run ffmpeg reporting progress from `-progress pipe:1` (out_time) against `total` seconds."""
    args = [ffmpeg(), "-progress", "pipe:1", "-nostats", *args[1:]] if args[0] == "ffmpeg" else list(args)
    p = job.popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    import threading
    err: list[bytes] = []
    t = threading.Thread(target=lambda: err.append(p.stderr.read()), daemon=True)
    t.start()
    try:
        for line in iter(p.stdout.readline, b""):
            if line.startswith(b"out_time_us=") or line.startswith(b"out_time_ms="):
                try:
                    us = int(line.split(b"=")[1])
                except ValueError:
                    continue
                f = min(us / 1e6 / max(total, 1e-3), 1.0)
                job.update(prog[0] + (prog[1] - prog[0]) * f, label)
        p.wait()
        t.join(5)
    finally:
        job.release(p)
    job.check()
    if p.returncode != 0:
        from ..jobs import JobError
        raise JobError(f"ffmpeg failed: {(b''.join(err))[-1200:].decode('utf-8', 'replace')}")
