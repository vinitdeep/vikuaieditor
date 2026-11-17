"""English ASR.

1. faster-whisper (CTranslate2, MIT) in a subprocess of the engine's env (viku/runners/whisper_runner.py) with the model
   manager's Whisper model (`whisper-small` if installed, else `whisper-base-en`; settings paths.faster_whisper_model).
2. Fallback: ffmpeg's built-in `whisper` filter (whisper.cpp, ffmpeg 8+ full builds only) + a ggml model
   (settings paths.whisper_model, or the legacy ~/.cache/whisper/ggml-base.en.bin).

Every chunk is cut from the wav and transcribed on its own, so cue times are the chunk times
(same as the IndicConformer path).
"""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
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


RUNNER = Path(__file__).resolve().parent.parent / "runners" / "whisper_runner.py"


def fw_model() -> str:
    from .. import models
    return models.whisper_model_dir()


def fw_available() -> bool:
    return bool(fw_model()) and importlib.util.find_spec("faster_whisper") is not None


def ggml_model() -> str:
    m = config.path("whisper_model") or config.legacy("whisper_model")
    return m if m and Path(m).exists() else ""


def engine() -> str:
    if fw_available():
        return "faster-whisper:" + Path(fw_model()).name
    if ggml_model() and has_filter():
        return "ffmpeg-whisper"
    return ""


def available() -> bool:
    return bool(engine())


def _fw_transcribe(wav: str, chunks: list, job: Job) -> list[dict]:
    tmp = Path(tempfile.mkdtemp(prefix="viku_fw_"))
    req, res = tmp / "req.json", tmp / "res.json"
    req.write_text(json.dumps({"model_dir": fw_model(), "wav": str(wav), "chunks": chunks, "lang": "en"}),
                   encoding="utf-8")
    p = job.popen([sys.executable, "-X", "utf8", str(RUNNER), str(req), str(res)], stdout=subprocess.PIPE,
                  stderr=subprocess.STDOUT, cwd=str(tmp))
    tail = []
    try:
        for line in iter(p.stdout.readline, b""):
            s = line.decode("utf-8", "replace").strip()
            if s.startswith("PROGRESS"):
                _, d, n = s.split()
                job.update(int(d) / max(int(n), 1), f"transcribing {d}/{n}")
            elif s:
                tail = (tail + [s])[-20:]
        p.wait()
    finally:
        job.release(p)
    job.check()
    if p.returncode != 0 or not res.exists():
        raise JobError("faster-whisper runner failed: " + " | ".join(tail[-6:]))
    out = []
    for it in json.loads(res.read_text(encoding="utf-8"))["chunks"]:
        t = it["text"]
        if t and not re.fullmatch(r"\s*[\[(].*[\])]\s*", t):
            out.append({"start": round(it["start"], 3), "end": round(it["end"], 3), "text": t, "lang": "en",
                        "conf": it.get("conf", 1.0), "alt": None})
    return out


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
    if fw_available():
        return _fw_transcribe(wav, chunks, job)
    model = ggml_model()
    if not model or not has_filter():
        raise JobError("English speech recognition is not installed - install the Whisper model "
                       "(POST /models/install {\"ids\": [\"whisper-base-en\"]})")
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
