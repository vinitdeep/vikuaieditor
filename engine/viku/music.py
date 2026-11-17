"""Music library: audio files in <data>/music (+ music.json with tags / mood / source).
Generated: `music_gen` beds (royalty-free, made on this PC) - `POST /music/generate`, and the 5 default moods on a
fresh install with an empty music library (`ensure_defaults`). Tagged "viku generated" + the mood.
HeyGen (online, the user's own account): `npx hyperframes media-use resolve --type bgm --intent <intent>` -> imported.
Dev seed (VIKU_DEV=1 only): copies AI Video Editing/.media/audio/bgm/bgm_00{1,2,3,4,5,7,8,9}.wav - those tracks are
licensed to the developer's HeyGen account and are never bundled.
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
                        "source": m.get("source", "local"), "mood": m.get("mood"), "seed": m.get("seed")})
    _save_meta(meta)
    return out


def seed() -> list[str]:
    """Dev machine only (VIKU_DEV=1): copy the developer's licensed HeyGen beds. Never runs on other PCs."""
    if not config.dev_mode():
        return []
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


# -------------------------------------------------------------- generated --
GEN_TAG = "viku generated"


def preview_dir() -> Path:
    return config.sub("music_previews")


def generate(job: Job, mood: str, seed: int | None = None, duration: float = 90.0, preview: bool = False) -> dict:
    """Render a music_gen bed to FLAC. preview=False -> straight into the library; True -> <data>/music_previews
    (not listed; `keep()` moves it in)."""
    from . import music_gen
    if mood not in music_gen.MOODS:
        raise JobError(f"unknown mood {mood!r} - one of: {', '.join(music_gen.MOODS)}", code="bad_request")
    if seed is None:
        seed = int(time.time() * 1000) % 100000
    x, info = music_gen.generate(mood, int(seed), float(duration),
                                 progress=lambda f, m: (job.check(), job.update(f * 0.95, m)))
    name = f"viku_{mood}_s{int(seed)}.flac"
    dst = (preview_dir() if preview else mdir()) / name
    job.update(0.96, "writing FLAC")
    music_gen.write(x, str(dst), int(seed))
    meta_entry = {"tags": [GEN_TAG, mood], "source": "viku", "mood": mood, "seed": int(seed),
                  "duration": info["duration"], "lufs": info["lufs"], "true_peak": info["true_peak"],
                  "label": music_gen.MOODS[mood]["label"]}
    if preview:
        (dst.with_suffix(".json")).write_text(json.dumps(meta_entry), encoding="utf-8")
    else:
        meta = _meta()
        meta[name] = meta_entry
        _save_meta(meta)
    return {"name": name, "path": str(dst), "preview": preview, **meta_entry, "info": info}


def keep(path: str) -> dict:
    """Move a preview bed into the library."""
    src = Path(path)
    if src.parent.resolve() != preview_dir().resolve() or not src.exists():
        raise JobError("not a generated preview", code="bad_request")
    side = src.with_suffix(".json")
    entry = json.loads(side.read_text(encoding="utf-8")) if side.exists() else {"tags": [GEN_TAG], "source": "viku"}
    dst = mdir() / src.name
    shutil.move(str(src), dst)
    side.unlink(missing_ok=True)
    meta = _meta()
    meta[dst.name] = entry
    _save_meta(meta)
    return {"name": dst.name, "path": str(dst), **entry}


def remove(name: str) -> bool:
    """Delete a track from the library (only files inside <data>/music)."""
    f = mdir() / Path(name).name
    if not f.exists() or f.suffix.lower() not in EXTS:
        return False
    f.unlink()
    meta = _meta()
    meta.pop(f.name, None)
    _save_meta(meta)
    return True


def ensure_defaults(job: Job) -> dict:
    """Fresh install: an empty music library gets the 5 default moods (seed 1 each, ~90 s, a few seconds each)."""
    from . import music_gen
    if list_tracks():
        return {"generated": [], "skipped": True}
    out = []
    moods = list(music_gen.MOODS)
    for i, mood in enumerate(moods):
        with job.scope(i / len(moods), (i + 1) / len(moods)):
            out.append(generate(job, mood, music_gen.DEFAULT_SEEDS[mood], 90.0)["name"])
    return {"generated": out, "skipped": False}


def pick(mood: str | None, key: str) -> dict | None:
    """A track for `mood`: generated beds of that mood first, then any track tagged with it, else any track
    (deterministic by `key`)."""
    import hashlib
    tracks = list_tracks()
    if not tracks:
        return None
    pool = [t for t in tracks if mood and t.get("mood") == mood] or            [t for t in tracks if mood and mood in (t.get("tags") or [])] or tracks
    h = int(hashlib.md5(key.encode()).hexdigest(), 16)
    return pool[h % len(pool)]
