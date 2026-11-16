"""Illustration library: images copied into <data>/library/images, indexed in <data>/library/library.sqlite.

Tags come from the folder name + file slug ("hi-6-akele-nahi/06-fallen-angel.png" -> akele, nahi, fallen,
angel) plus user tags. Search is keyword scoring over tags/title now; `brain.embed` is the hook for
semantic search (Phase 3): when an embedder is available, image text embeddings are stored in the
`emb` column and blended into the score.
"""
from __future__ import annotations

import hashlib
import re
import shutil
import sqlite3
import threading
import time
from pathlib import Path

from . import config

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
STOP = {"the", "a", "an", "of", "and", "in", "on", "to", "for", "with", "part", "part1", "part2", "hi", "or", "en",
        "img", "image", "final", "v1", "v2", "v3", "copy"}
SEED_GLOBS = [
    (Path.home() / "Downloads" / "Before the Foundation reels" / "illustrations", "*/*.png"),
    (Path.home() / "Downloads" / "Salvation reels" / "illustrations", "*/*.png"),
]
_lock = threading.Lock()


def ldir() -> Path:
    d = config.sub("library")
    (d / "images").mkdir(exist_ok=True)
    return d


def db() -> sqlite3.Connection:
    c = sqlite3.connect(ldir() / "library.sqlite", check_same_thread=False)
    c.execute("""CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, path TEXT, orig TEXT, title TEXT,
                 tags TEXT, user_tags TEXT, width INT, height INT, added REAL, emb BLOB)""")
    return c


def words(s: str) -> list[str]:
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    out = []
    for w in re.split(r"[^\w]+", s.lower(), flags=re.UNICODE):
        w = w.strip("_")
        if not w or w.isdigit() or w in STOP or len(w) < 2:
            continue
        out.append(w)
    return out


def tags_for(path: Path, extra: list[str] | None = None) -> list[str]:
    t = words(path.parent.name) + words(path.stem) + [w for x in (extra or []) for w in words(x)]
    seen, out = set(), []
    for w in t:
        if w not in seen:
            seen.add(w)
            out.append(w)
    return out


def import_paths(paths: list[str], tags: list[str] | None = None) -> dict:
    files: list[Path] = []
    for p in paths:
        P = Path(p)
        if P.is_dir():
            files += [f for f in sorted(P.rglob("*")) if f.suffix.lower() in IMG_EXTS]
        elif P.suffix.lower() in IMG_EXTS and P.exists():
            files.append(P)
    added, skipped = [], 0
    import cv2
    import numpy as np
    with _lock:
        c = db()
        for f in files:
            h = hashlib.sha1(f.read_bytes()).hexdigest()[:16]
            if c.execute("SELECT 1 FROM images WHERE id=?", (h,)).fetchone():
                skipped += 1
                continue
            dst = ldir() / "images" / f"{h}{f.suffix.lower()}"
            shutil.copy2(f, dst)
            im = cv2.imdecode(np.fromfile(str(dst), np.uint8), cv2.IMREAD_REDUCED_COLOR_4)
            hh, ww = (im.shape[0] * 4, im.shape[1] * 4) if im is not None else (0, 0)
            tg = tags_for(f, tags)
            c.execute("INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?,NULL)",
                      (h, str(dst), str(f), f.stem, " ".join(tg), " ".join(words(" ".join(tags or []))), ww, hh,
                       time.time()))
            added.append({"id": h, "path": str(dst), "tags": tg})
        c.commit()
        c.close()
    return {"added": len(added), "skipped": skipped, "items": added}


def seed() -> dict:
    paths = []
    for root, pat in SEED_GLOBS:
        if root.exists():
            paths += [str(f) for f in sorted(root.glob(pat))]
    return import_paths(paths)


def count() -> int:
    c = db()
    n = c.execute("SELECT COUNT(*) FROM images").fetchone()[0]
    c.close()
    return n


def search(q: str, limit: int = 40, exclude: set[str] | None = None) -> list[dict]:
    qw = words(q or "")
    c = db()
    rows = c.execute("SELECT id, path, title, tags, user_tags, width, height FROM images").fetchall()
    c.close()
    out = []
    for rid, path, title, tags, utags, w, h in rows:
        if exclude and rid in exclude:
            continue
        tg = set((tags or "").split()) | set((utags or "").split())
        if not qw:
            score = 0.0
        else:
            score = 0.0
            for w_ in qw:
                if w_ in tg:
                    score += 1.0
                elif any(t.startswith(w_) or w_.startswith(t) for t in tg if len(t) >= 4 and len(w_) >= 4):
                    score += 0.5
            if score == 0:
                continue
        out.append({"id": rid, "path": path, "title": title, "tags": sorted(tg), "width": w, "height": h,
                    "score": round(score, 3)})
    out.sort(key=lambda d: (-d["score"], d["title"]))
    return out[:limit]
