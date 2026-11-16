"""Music library: audio files in <data>/music (+ music.json with optional mood tags).
Seed: copies AI Video Editing/.media/audio/bgm/bgm_00{1,2,3,4,5,7,8,9}.wav (bgm_006 is excluded on purpose).
HeyGen: `npx hyperframes media-use resolve --type bgm --intent <intent> --project <dir>` -> imported here.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import time
from pathlib import Path

from . import config
from .jobs import Job, JobError
from .media import ff

EXTS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}
SEED_DIR = Path.home() / "Documents" / "Claude" / "Projects" / "AI Video Editing" / ".media" / "audio" / "bgm"
SEED = [f"bgm_00{i}.wav" for i in (1, 2, 3, 4, 5, 7, 8, 9)]


def mdir() -> Path:
    return config.sub("music")


def _meta() -> dict:
    f = mdir() / "music.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def _save_meta(m: dict):
    (mdir() / "music.json").write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")


def list_tracks() -> list[dict]:
    meta = _meta()
    out = []
    for f in sorted(mdir().iterdir()):
        if f.suffix.lower() in EXTS:
            m = meta.get(f.name, {})
            if "duration" not in m:
                try:
                    m["duration"] = round(ff.duration(str(f)), 2)
                    meta[f.name] = m
                except Exception:
                    m["duration"] = None
            out.append({"name": f.name, "path": str(f), "duration": m.get("duration"), "tags": m.get("tags", []),
                        "source": m.get("source", "local")})
    _save_meta(meta)
    return out


def seed() -> list[str]:
    added = []
    for n in SEED:
        s = SEED_DIR / n
        if s.exists() and not (mdir() / n).exists():
            shutil.copy2(s, mdir() / n)
            added.append(n)
    return added


def heygen(intent: str, job: Job) -> dict:
    """Online: resolve a HeyGen catalog bgm track for `intent` and import it."""
    tmp = Path(tempfile.mkdtemp(prefix="viku_heygen_"))
    npx = config.path("npx") or "npx"
    job.update(0.1, "asking HeyGen for a music track")
    cp = job.run([npx + (".cmd" if not npx.lower().endswith((".cmd", ".exe")) else ""), "hyperframes", "media-use",
                  "resolve", "--type", "bgm", "--intent", intent, "--project", str(tmp), "--json"], check=False, timeout=600,
                 cwd=str(tmp))
    found = [f for f in tmp.rglob("*") if f.suffix.lower() in EXTS]
    try:  # --json: one JSON result on stdout; prefer the path it names
        res = json.loads((cp.stdout or b"").decode("utf-8", "replace").strip().splitlines()[-1])
        for k in ("path", "file", "output"):
            if isinstance(res.get(k), str) and Path(res[k]).suffix.lower() in EXTS:
                q = Path(res[k]) if Path(res[k]).is_absolute() else tmp / res[k]
                if q.exists():
                    found = [q]
                    break
    except (ValueError, IndexError, AttributeError):
        pass
    if not found:
        msg = (cp.stderr or b"").decode("utf-8", "replace")[-800:] + (cp.stdout or b"").decode("utf-8", "replace")[-800:]
        raise JobError(f"HeyGen returned no audio (are you signed in? `npx hyperframes auth login --device`): {msg}")
    src = max(found, key=lambda f: f.stat().st_size)
    name = f"heygen_{time.strftime('%Y%m%d_%H%M%S')}{src.suffix.lower()}"
    shutil.copy2(src, mdir() / name)
    meta = _meta()
    meta[name] = {"tags": [w for w in intent.lower().split() if len(w) > 2], "source": "heygen", "intent": intent}
    _save_meta(meta)
    return {"name": name, "path": str(mdir() / name)}
