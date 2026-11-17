"""Speech enhancement (DeepFilterNet 3), in order of preference:

1. `deep-filter` CLI - the standalone Rust binary from the DeepFilterNet releases (MIT/Apache-2.0), installed by the
   model manager into <data>/tools/deep-filter (or settings paths.deep_filter). Same DeepFilterNet3 model as the Python
   package, no torch. Input resampled to 48 kHz mono; `-D` compensates the STFT/lookahead delay (keeps A/V sync, same
   as the Python `enhance(pad=True)` default).
2. DeepFilterNet Python venv (settings paths.dfnet_python, or the legacy dev venv) via viku/runners/dfn_runner.py.
3. ffmpeg highpass + afftdn (last resort).
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from .. import config, models
from ..jobs import Job, JobError
from . import ff

RUNNER = Path(__file__).resolve().parent.parent / "runners" / "dfn_runner.py"
FALLBACK_AF = "highpass=f=80,afftdn=nf=-25:tn=1,lowpass=f=12000"


def dfn_python() -> str:
    py = config.path("dfnet_python") or config.legacy("dfnet_python")
    return py if py and Path(py).exists() else ""


def dfn_available() -> bool:
    return bool(models.deep_filter() or dfn_python())


def mode() -> str:
    if models.deep_filter():
        return "deep-filter-cli"
    if dfn_python():
        return "deepfilternet-venv"
    return "ffmpeg-afftdn"


def _cli(exe: str, src_wav: str, out_wav: str, job: Job) -> bool:
    tmp = Path(tempfile.mkdtemp(prefix="viku_df_"))
    try:
        inp = tmp / "voice48.wav"
        ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", src_wav, "-ac", "1", "-ar", "48000",
                "-c:a", "pcm_s16le", str(inp)], job=job)
        job.run([exe, "-D", "-o", str(tmp / "out"), str(inp)], timeout=1800, cwd=str(tmp))
        res = tmp / "out" / inp.name
        if not res.exists():
            return False
        # -D drops the model's ~30 ms lookahead at the end: pad back to the input length so A/V lengths match
        import numpy as np
        import soundfile as sf
        n_in = sf.info(str(inp)).frames
        y, sr = sf.read(str(res), dtype="float32", always_2d=False)
        if y.ndim > 1:
            y = y.mean(1)
        y = np.pad(y, (0, max(0, n_in - len(y))))[:n_in]
        sf.write(out_wav, y, sr, subtype="PCM_16")
        return True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def enhance(src_wav: str, out_wav: str, job: Job) -> str:
    """-> engine used ("deep-filter-cli" | "deepfilternet-venv" | "ffmpeg-afftdn"). out_wav is 48 kHz mono."""
    exe = models.deep_filter()
    if exe:
        try:
            if _cli(exe, src_wav, out_wav, job):
                return "deep-filter-cli"
        except JobError as e:
            print("deep-filter CLI failed, trying the next engine:", str(e)[-300:])
    py = dfn_python()
    if py:
        try:
            job.run([py, "-X", "utf8", str(RUNNER), src_wav, out_wav], timeout=1800, cwd=str(Path(out_wav).parent))
            if Path(out_wav).exists():
                return "deepfilternet-venv"
        except JobError as e:
            print("DeepFilterNet venv failed, using ffmpeg fallback:", str(e)[-300:])
    job.check()
    ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", src_wav, "-af", FALLBACK_AF, "-ac", "1",
            "-ar", "48000", out_wav], job=job)
    return "ffmpeg-afftdn"
