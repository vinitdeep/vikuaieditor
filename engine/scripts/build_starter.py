"""Build the bundled starter illustration pack (dev machine only).

    uv run python scripts/build_starter.py [--src DIR ...] [--out ../data/starter/illustrations]

Reads the project's own AI-generated illustrations (default: the Before-the-Foundation + Salvation reel folders under
~/Downloads, `<set>/<NN-slug>.png`), centre-crops each to exactly 9:16, resizes to 1080x1920, writes a baseline JPEG
q85 with no metadata (no EXIF / ICC / PNG text) to `<out>/<set>/<NN-slug>.jpg`, and writes `<out>/index.json`:
{version, licence, count, bytes, items: [{id, file, title, tags, desc, set, width, height, bytes}]}.
`id` = sha1(jpeg bytes)[:16] (the library's own id scheme), tags / desc come from viku.library (folder + slug words),
so an imported starter image is indistinguishable from one imported from the original folder.
The installer ships `data/starter` as extraResources; the engine imports it on first run (viku.library.import_starter).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from viku import library  # noqa: E402

HOME = Path.home()
DEFAULT_SRC = [HOME / "Downloads" / "Before the Foundation reels" / "illustrations",
               HOME / "Downloads" / "Salvation reels" / "illustrations"]
LICENCE = ("Viku starter illustrations - AI-generated (Google Gemini / AI Studio) by the Viku project, "
           "free to use in Viku videos")
W, H = 1080, 1920


def convert(src: Path) -> bytes:
    with Image.open(src) as im:
        im = im.convert("RGB")
        w, h = im.size
        if w / h > W / H:      # too wide: crop the sides
            cw = round(h * W / H)
            box = ((w - cw) // 2, 0, (w - cw) // 2 + cw, h)
        else:                  # too tall: crop top/bottom
            ch = round(w * H / W)
            box = (0, (h - ch) // 2, w, (h - ch) // 2 + ch)
        im = im.crop(box).resize((W, H), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85, optimize=True, progressive=False)  # no exif / icc_profile passed
        return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", action="append", type=Path)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "data" / "starter" / "illustrations")
    a = ap.parse_args()
    srcs = a.src or DEFAULT_SRC
    out: Path = a.out
    out.mkdir(parents=True, exist_ok=True)
    items, total = [], 0
    for root in srcs:
        if not root.exists():
            print("missing source:", root)
            continue
        for f in sorted(root.glob("*/*.png")):
            data = convert(f)
            rel = Path(f.parent.name) / (f.stem + ".jpg")
            dst = out / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
            total += len(data)
            items.append({"id": hashlib.sha1(data).hexdigest()[:16], "file": rel.as_posix(), "title": f.stem,
                          "tags": library.tags_for(rel), "desc": library.describe(str(rel), f.stem),
                          "set": f.parent.name, "width": W, "height": H, "bytes": len(data)})
            print(f"{rel.as_posix():55s} {len(data) / 1024:6.0f} KB")
    idx = {"version": 1, "licence": LICENCE, "count": len(items), "bytes": total, "items": items}
    (out / "index.json").write_text(json.dumps(idx, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(items)} images, {total / 1e6:.1f} MB -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
