"""ASR adapters. Heavy models run as subprocesses in their own environments.

transcribe(wav16_path, chunks, lang, job) -> [{"start","end","text","lang","conf","alt"}]
  chunks are [s, e] seconds inside the wav; returned times are in the same timeline.
  lang: "or" | "hi" -> IndicConformer; "en" -> ffmpeg whisper filter; "auto" -> IndicConformer
  language id over or/hi per chunk, smoothed over neighbours (see indic.smooth_languages).
"""
from __future__ import annotations

from ..jobs import Job
from . import indic, whisper


def available() -> dict:
    return {"indic": indic.available(), "whisper": whisper.available()}


def transcribe(wav: str, chunks: list, lang: str, job: Job, ctc: bool = True) -> list[dict]:
    if not chunks:
        return []
    if lang == "en":
        return whisper.transcribe(wav, chunks, job)
    return indic.transcribe(wav, chunks, lang, job, ctc=ctc)
