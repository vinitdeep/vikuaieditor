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
        # Hugging Face read token (IndicConformer is a gated repo): POST {"hf_token": "..."} stores it DPAPI-encrypted
        # as `hf_token_dpapi` (never plaintext on disk, never returned by GET /settings); {"hf_token": null} clears it.
        "hf_token_dpapi": "",
        "models_mirror_url": "",      # base URL replacing https://huggingface.co/ for every HF item (church mirror)
        "model_mirrors": {},          # {model id: base URL} replaces one item's download URL prefix
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


_mem_token = ""  # session-only token when DPAPI is unavailable (non-Windows)
SECRET_KEYS = ("hf_token", "hf_token_dpapi", "hf_token_set")


def _write(d: dict) -> None:
    (data_dir() / "settings.json").write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def _absorb_token(d: dict, token) -> None:
    """Move a plaintext token into the DPAPI field (None / "" -> handled by the caller)."""
    global _mem_token
    from . import vault
    try:
        d["hf_token_dpapi"] = vault.protect(token)
    except vault.VaultUnavailable:
        _mem_token = token
        d["hf_token_dpapi"] = ""


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
            plain = saved.pop("hf_token", None)
            _cache = _merge(d, saved)
            if plain:  # migrate an older plaintext token to DPAPI and rewrite the file without it
                _absorb_token(_cache, plain)
            if plain is not None:
                _write(_cache)
        return json.loads(json.dumps(_cache))


def save_settings(patch: dict) -> dict:
    """Merge `patch` into the settings. `hf_token`: non-empty string = store (DPAPI), null = clear, "" = unchanged
    (so the app can round-trip GET -> POST). `hf_token_dpapi` / `hf_token_set` from clients are ignored."""
    global _cache, _mem_token
    patch = dict(patch or {})
    token = patch.pop("hf_token", "")
    patch.pop("hf_token_dpapi", None)
    patch.pop("hf_token_set", None)
    cur = settings()
    new = _merge(cur, patch)
    if token is None:
        new["hf_token_dpapi"], _mem_token = "", ""
    elif isinstance(token, str) and token.strip():
        _absorb_token(new, token.strip())
    with _lock:
        _write(new)
        _cache = new
    return settings()


def hf_token() -> str:
    """The stored Hugging Face token (decrypted in memory only), else env HF_TOKEN / HUGGING_FACE_HUB_TOKEN."""
    from . import vault
    return (vault.unprotect(settings().get("hf_token_dpapi", "")) or _mem_token or os.environ.get("HF_TOKEN")
            or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "")


def public_settings() -> dict:
    """Settings for GET /settings: secrets removed, `hf_token_set` tells whether a token is stored."""
    s = settings()
    for k in SECRET_KEYS:
        s.pop(k, None)
    s["hf_token_set"] = bool(hf_token())
    return s


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
