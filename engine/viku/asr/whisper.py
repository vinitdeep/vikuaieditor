"""English ASR through ffmpeg's built-in `whisper` filter (whisper.cpp) + a ggml model
(settings paths.whisper_model, default ~/.cache/whisper/ggml-base.en.bin).

Every chunk is cut from the wav and transcribed on its own, so cue times are the chunk times
(same as the IndicConformer path).
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
from pathlib import Path

from .. import config
from ..jobs import CREATE_NO_WINDOW, Job, JobError
from ..media import ff

_has_filter: bool | None = None


def has_filter() -> bool:
    global _has_filter
    if _has_filter is None:
        try:
            out = subprocess.run([ff.ffmpeg(), "-hide_banner", "-filters"], capture_output=True,
                                 creationflags=CREATE_NO_WINDOW).stdout.decode("utf-8", "replace")
            _has_filter = any(l.split()[1:2] == ["whisper"] for l in out.splitlines() if len(l.split()) > 1)
        except Exception:
            _has_filter = False
    return _has_filter


def available() -> bool:
    m = config.path("whisper_model")
    return bool(m) and Path(m).exists() and has_filter()


def _parse(path: Path) -> str:
    if not path.exists():
        return ""
    txt = path.read_text(encoding="utf-8", errors="replace").strip()
    parts = []
    for line in txt.splitlines():
        line = line.strip().rstrip(",")
        if not line:
            continue
        try:
            d = json.loads(line)
            parts.append(str(d.get("text", "")).strip())
        except json.JSONDecodeError:
            parts.append(line)
    return " ".join(p for p in parts if p).strip()


def transcribe(wav: str, chunks: list, job: Job) -> list[dict]:
    if not has_filter():
        raise JobError("this ffmpeg has no 'whisper' filter - English ASR unavailable (install an ffmpeg 8+ full build)")
    model = config.path("whisper_model")
    if not model or not Path(model).exists():
        raise JobError("whisper model not found - put ggml-base.en.bin in ~/.cache/whisper or set paths.whisper_model")
    tmp = Path(tempfile.mkdtemp(prefix="viku_whisper_"))
    out = []
    for i, (s, e) in enumerate(chunks):
        job.check()
        dest = tmp / f"c{i}.json"
        af = (f"whisper=model='{ff.filter_path(model)}':language=en:queue=30:use_gpu=false:"
              f"destination=c{i}.json:format=json")
        ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{s:.3f}", "-to", f"{e:.3f}", "-i", wav,
                "-af", af, "-f", "null", "-"], job=job, cwd=str(tmp))
        text = _parse(dest)
        if text and not re.fullmatch(r"\s*[\[(].*[\])]\s*", text):  # "[BLANK_AUDIO]", "(speaking in foreign language)"
            out.append({"start": round(s, 3), "end": round(e, 3), "text": text, "lang": "en", "conf": 1.0, "alt": None})
        job.update((i + 1) / len(chunks), f"transcribing {i + 1}/{len(chunks)}")
    return out
