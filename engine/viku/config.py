"""Data directory + settings.

Data dir: env VIKU_DATA, else %APPDATA%\\Viku. Layout:
  settings.json
  projects/<id>/project.json (+ media: proxy.mp4, audio16k.wav, peaks.npy, reels/<rid>/...)
  fonts/  bible/  library/  music/  sfx/  models/brain/  feedback.jsonl
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

HOME = Path.home()
ASSETS = Path(__file__).parent / "assets"


def data_dir() -> Path:
    d = os.environ.get("VIKU_DATA") or str(Path(os.environ.get("APPDATA", HOME)) / "Viku")
    p = Path(d)
    p.mkdir(parents=True, exist_ok=True)
    return p


def sub(name: str) -> Path:
    p = data_dir() / name
    p.mkdir(parents=True, exist_ok=True)
    return p


def _first(*cands) -> str:
    for c in cands:
        if c and Path(c).exists():
            return str(c)
    return ""


def legacy_paths() -> dict:
    """Tools of the original dev machine (before the model manager). Used only as a last resort and only when
    settings.legacy_tools is true; on a clean PC none of these exist."""
    proj = HOME / "Documents" / "Claude" / "Projects"
    indic = proj / "IndicConformerASR"
    return {
        "indic_dir": _first(indic),
        "indic_python": _first(indic / ".venv" / "Scripts" / "python.exe"),
        "dfnet_python": _first(proj / "AI Video Editing" / ".dfnet" / "Scripts" / "python.exe"),
        "whisper_model": _first(HOME / ".cache" / "whisper" / "ggml-base.en.bin"),
    }


def default_settings() -> dict:
    return {
        "credit_line": "",
        "church_name": "",
        "default_language": "or",
        "projects_dir": str(data_dir() / "projects"),
        "exports_dir": "",  # empty = <project>/exports
        # Tool / model locations. Empty = the model manager's copy in <data>/tools or <data>/models (see models.py).
        "paths": {
            "ffmpeg": "", "ffprobe": "", "deep_filter": "", "faster_whisper_model": "",
            "indic_dir": "", "indic_python": "",   # python with torch + onnxruntime; empty = the engine's own env
            "dfnet_python": "", "whisper_model": "",  # optional fallbacks (DeepFilterNet venv, ffmpeg-whisper ggml)
            "npx": "npx",
        },
        "allow_system_tools": True,   # use an ffmpeg on PATH when it is new enough and no managed copy exists
        "legacy_tools": False,        # opt-in: fall back to the dev machine's old venvs (legacy_paths())
        "hf_token": "",               # Hugging Face read token (IndicConformer is a gated repo)
        "model_mirrors": {},          # {model id: base URL} replaces the download URL prefix
        "export_presets": {
            "reel": {"width": 1080, "height": 1920, "fps": 30, "crf": 18, "audio_kbps": 192,
                     "lufs": -14.0, "true_peak": -1.5},
        },
        "music_gain_db": -19.0,
        "sfx_gain_db": -15.0,
    }


_lock = threading.Lock()
_cache: dict | None = None


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = _merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


def settings() -> dict:
    global _cache
    with _lock:
        if _cache is None:
            f = data_dir() / "settings.json"
            saved = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
            d = default_settings()
            # keep auto-detected defaults when a saved path is blank
            for k, v in list(saved.get("paths", {}).items()):
                if not v:
                    saved["paths"].pop(k)
            _cache = _merge(d, saved)
        return json.loads(json.dumps(_cache))


def save_settings(patch: dict) -> dict:
    global _cache
    cur = settings()
    new = _merge(cur, patch or {})
    with _lock:
        (data_dir() / "settings.json").write_text(json.dumps(new, ensure_ascii=False, indent=1), encoding="utf-8")
        _cache = new
    return settings()


def path(key: str) -> str:
    return settings()["paths"].get(key, "")


def legacy(key: str) -> str:
    """Legacy dev-machine path for `key` when settings.legacy_tools is on, else ""."""
    if not settings().get("legacy_tools", False):
        return ""
    return legacy_paths().get(key, "")


def projects_dir() -> Path:
    p = Path(settings()["projects_dir"])
    p.mkdir(parents=True, exist_ok=True)
    return p
