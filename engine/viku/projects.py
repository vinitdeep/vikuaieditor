"""Project store: <projects dir>/<id>/project.json is the single source of truth (see ARCHITECTURE.md)."""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

from . import config

LANGS = {"or", "hi", "en", "auto"}
_locks: dict[str, threading.RLock] = {}
_glock = threading.Lock()


class NotFound(Exception):
    pass


class Invalid(Exception):
    pass


def lock(pid: str) -> threading.RLock:
    with _glock:
        return _locks.setdefault(pid, threading.RLock())


def pdir(pid: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", pid or ""):
        raise NotFound(pid)
    return config.projects_dir() / pid


def slug(s: str) -> str:
    import unicodedata
    keep = "".join(ch if unicodedata.category(ch)[0] in "LMN" else "-" for ch in unicodedata.normalize("NFC", s or "").lower())
    s = re.sub(r"-+", "-", keep).strip("-")
    return s[:40] or "reel"


def new_project(name: str, video_path: str, language: str) -> dict:
    if language not in LANGS:
        raise Invalid(f"language must be one of {sorted(LANGS)}")
    if not video_path or not Path(video_path).exists():
        raise Invalid(f"video not found: {video_path}")
    from .media import ff
    info = ff.probe(video_path)
    pid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    proj = {"id": pid, "name": name or Path(video_path).stem, "video_path": str(Path(video_path).resolve()),
            "duration": round(info["duration"], 3), "fps": info["fps"], "width": info["width"],
            "height": info["height"], "language": language, "proxy": None, "proxy_offset": 0.0, "wav16": None,
            "peaks": None, "shots": [], "pauses": [], "transcript": [], "analyzed": [], "suggestions": [],
            "reels": [], "created": time.time()}
    pdir(pid).mkdir(parents=True, exist_ok=True)
    save(proj)
    return proj


def load(pid: str) -> dict:
    f = pdir(pid) / "project.json"
    if not f.exists():
        raise NotFound(pid)
    return json.loads(f.read_text(encoding="utf-8"))


def save(proj: dict) -> dict:
    validate(proj)
    d = pdir(proj["id"])
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "project.json.tmp"
    tmp.write_text(json.dumps(proj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, d / "project.json")
    return proj


def update(pid: str, fn) -> dict:
    """Read-modify-write under the project lock."""
    with lock(pid):
        p = load(pid)
        r = fn(p)
        save(p)
        return p if r is None else r


def list_projects() -> list[dict]:
    out = []
    for f in sorted(config.projects_dir().glob("*/project.json")):
        try:
            p = json.loads(f.read_text(encoding="utf-8"))
            out.append({k: p.get(k) for k in ("id", "name", "video_path", "duration", "language", "created")}
                       | {"reels": len(p.get("reels", [])), "analyzed": p.get("analyzed", [])})
        except Exception:
            continue
    return out


def _pairs(x, what):
    if not isinstance(x, list):
        raise Invalid(f"{what} must be a list")
    for v in x:
        if not (isinstance(v, (list, tuple)) and len(v) == 2 and all(isinstance(t, (int, float)) for t in v) and v[1] >= v[0]):
            raise Invalid(f"{what}: bad pair {v!r}")


def validate(p: dict):
    for k in ("id", "name", "video_path", "language"):
        if k not in p:
            raise Invalid(f"missing {k}")
    if p["language"] not in LANGS:
        raise Invalid("bad language")
    _pairs(p.get("pauses", []), "pauses")
    for t in p.get("transcript", []):
        if not {"start", "end", "text"} <= set(t):
            raise Invalid("transcript items need start/end/text")
    for r in p.get("reels", []):
        if "id" not in r:
            raise Invalid("reel without id")
        _pairs(r.get("segments", []), f"reel {r['id']} segments")
        if r.get("status", "draft") not in ("draft", "built", "rendered"):
            raise Invalid(f"reel {r['id']}: bad status")


def find_reel(rid: str) -> tuple[dict, dict]:
    """-> (project, reel). Reel ids are '<project id>~<n>' so they resolve without a scan."""
    pid = rid.split("~", 1)[0]
    p = load(pid)
    for r in p.get("reels", []):
        if r["id"] == rid:
            return p, r
    raise NotFound(rid)


def reel_dir(rid: str) -> Path:
    pid, n = rid.split("~", 1)
    d = pdir(pid) / "reels" / n
    d.mkdir(parents=True, exist_ok=True)
    return d


def exports_dir(pid: str) -> Path:
    e = config.settings().get("exports_dir")
    d = Path(e) / pid if e else pdir(pid) / "exports"
    d.mkdir(parents=True, exist_ok=True)
    return d
