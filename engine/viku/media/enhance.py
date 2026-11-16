"""Speech enhancement: DeepFilterNet 3 through its own venv (settings paths.dfnet_python),
fallback ffmpeg highpass + afftdn when that venv is missing or fails."""
from __future__ import annotations

from pathlib import Path

from .. import config
from ..jobs import Job, JobError
from . import ff

RUNNER = Path(__file__).resolve().parent.parent / "runners" / "dfn_runner.py"
FALLBACK_AF = "highpass=f=80,afftdn=nf=-25:tn=1,lowpass=f=12000"


def dfn_available() -> bool:
    py = config.path("dfnet_python")
    return bool(py) and Path(py).exists()


def mode() -> str:
    return "deepfilternet" if dfn_available() else "ffmpeg-afftdn"


def enhance(src_wav: str, out_wav: str, job: Job) -> str:
    """-> engine used ("deepfilternet" | "ffmpeg-afftdn"). out_wav is 48 kHz mono."""
    if dfn_available():
        try:
            job.run([config.path("dfnet_python"), "-X", "utf8", str(RUNNER), src_wav, out_wav], timeout=1800,
                    cwd=str(Path(out_wav).parent))
            if Path(out_wav).exists():
                return "deepfilternet"
        except JobError as e:
            print("DeepFilterNet failed, using ffmpeg fallback:", str(e)[-300:])
    job.check()
    ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", src_wav, "-af", FALLBACK_AF, "-ac", "1",
            "-ar", "48000", out_wav], job=job)
    return "ffmpeg-afftdn"
