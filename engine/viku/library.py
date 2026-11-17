"""Illustration library: images copied into <data>/library/images, indexed in <data>/library/library.sqlite.

Tags come from the folder name + file slug ("hi-6-akele-nahi/06-fallen-angel.png" -> akele, nahi, fallen,
angel) plus user tags. Each image also has a `set` (its source folder, e.g. one reel's illustrations) and an
optional `desc` (English scene text, e.g. the generation prompt's SCENE). The embedding text is `desc` or, when
empty, the slug words ("06-fallen-angel" -> "fallen angel") + user tags; it is embedded with the e5 "passage: "
prefix (cached by text hash) and blended into /library/search, and the cutaway planner matches caption text to it.
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
    cols = {r[1] for r in c.execute("PRAGMA table_info(images)")}
    if "desc" not in cols:
        c.execute("ALTER TABLE images ADD COLUMN desc TEXT")
    if "setname" not in cols:
        c.execute("ALTER TABLE images ADD COLUMN setname TEXT")
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


def import_paths(paths: list[str], tags: list[str] | None = None, desc: str = "", setname: str = "") -> dict:
    files: list[Path] = []
    for p in paths:
        P = Path(p)
        if P.is_dir():
            files += [f for f in sorted(P.rglob("*")) if f.suffix.lower() in IMG_EXTS]
        elif P.suffix.lower() in IMG_EXTS and P.exists():
            files.append(P)
    added, skipped, added_ids = [], 0, []
    import cv2
    import numpy as np
    with _lock:
        c = db()
        for f in files:
            h = hashlib.sha1(f.read_bytes()).hexdigest()[:16]
            if c.execute("SELECT 1 FROM images WHERE id=?", (h,)).fetchone():
                skipped += 1
                if desc:
                    c.execute("UPDATE images SET desc=? WHERE id=?", (desc, h))
                added_ids.append(h)
                continue
            dst = ldir() / "images" / f"{h}{f.suffix.lower()}"
            shutil.copy2(f, dst)
            im = cv2.imdecode(np.fromfile(str(dst), np.uint8), cv2.IMREAD_REDUCED_COLOR_4)
            hh, ww = (im.shape[0] * 4, im.shape[1] * 4) if im is not None else (0, 0)
            tg = tags_for(f, tags)
            c.execute("INSERT INTO images(id, path, orig, title, tags, user_tags, width, height, added, emb, desc, setname)"
                      " VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?)",
                      (h, str(dst), str(f), f.stem, " ".join(tg), " ".join(words(" ".join(tags or []))), ww, hh,
                       time.time(), desc or None, setname or f.parent.name))
            added.append({"id": h, "path": str(dst), "tags": tg})
            added_ids.append(h)
        c.commit()
        c.close()
    return {"added": len(added), "skipped": skipped, "items": added, "ids": added_ids}


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


def describe(orig: str, title: str, user_tags: str = "", desc: str | None = None) -> str:
    """Text the image is embedded with: explicit desc, else slug words (+ user tags)."""
    if desc:
        return desc
    stem = re.sub(r"^\d+[-_ ]*", "", Path(orig or title or "").stem)
    w = words(stem) + [t for t in (user_tags or "").split() if t]
    return " ".join(dict.fromkeys(w)) or (title or "")


def items() -> list[dict]:
    c = db()
    rows = c.execute("SELECT id, path, orig, title, tags, user_tags, width, height, desc, setname FROM images").fetchall()
    c.close()
    out = []
    for rid, path, orig, title, tags, utags, w, h, desc, setname in rows:
        out.append({"id": rid, "path": path, "title": title, "tags": sorted(set((tags or "").split()) | set((utags or "").split())),
                    "width": w, "height": h, "set": setname or (Path(orig).parent.name if orig else ""),
                    "desc": describe(orig, title, utags, desc)})
    return out


def embeddings(its: list[dict]):
    from .brain import embed
    return embed.embed_texts([it["desc"] for it in its], "passage: ")


def search(q: str, limit: int = 40, exclude: set[str] | None = None) -> list[dict]:
    """Keyword score over tags (+1 exact, +0.5 prefix) plus, when the embedding model is present,
    the e5 cosine of "query: q" to each image's description (scaled so a strong match ~ one tag hit)."""
    qw = words(q or "")
    its = [it for it in items() if not (exclude and it["id"] in exclude)]
    sem = None
    if q and q.strip() and its:
        try:
            from .brain import embed
            if embed.available():
                V = embeddings(its)
                sem = V @ embed.embed_texts([q], "query: ")[0]
                sem = (sem - sem.mean()) / max(sem.std(), 1e-6)
        except Exception:  # noqa: BLE001 - search must work without the model
            sem = None
    out = []
    for k, it in enumerate(its):
        tg = set(it["tags"])
        score = 0.0
        for w_ in qw:
            if w_ in tg:
                score += 1.0
            elif any(t.startswith(w_) or w_.startswith(t) for t in tg if len(t) >= 4 and len(w_) >= 4):
                score += 0.5
        if sem is not None:
            score += max(0.0, float(sem[k]) - 1.0) * 0.5
        if qw and score <= 0:
            continue
        out.append(it | {"score": round(score, 3)})
    out.sort(key=lambda d: (-d["score"], d["title"]))
    return out[:limit]
