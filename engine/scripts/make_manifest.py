"""Dev tool: pin a Hugging Face model snapshot into a Viku model-manager manifest (path, size, sha256 per file).

    uv run python scripts/make_manifest.py <repo> <revision> <out.json> [--prefix assets/] [--include a,b]
                                          [--local <dir with the same files>]

LFS files carry their sha256 in the HF tree API (masked for gated repos when anonymous: then `--local` is hashed,
after a size check). Small (non-LFS) files only carry a git blob sha1, so they are
hashed from `--local` (verified against that sha1 first) or downloaded (anonymous; needs HF_TOKEN for gated repos).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import urllib.request
from pathlib import Path


def get(url: str) -> bytes:
    h = {"User-Agent": "viku-manifest"}
    if os.environ.get("HF_TOKEN"):
        h["Authorization"] = "Bearer " + os.environ["HF_TOKEN"]
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=120) as r:
        return r.read()


def tree(repo: str, rev: str, path: str = "") -> list[dict]:
    out = []
    for x in json.loads(get(f"https://huggingface.co/api/models/{repo}/tree/{rev}/{path}".rstrip("/"))):
        if x["type"] == "directory":
            out += tree(repo, rev, x["path"])
        else:
            out.append(x)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("revision")
    ap.add_argument("out")
    ap.add_argument("--prefix", default="")
    ap.add_argument("--include", default="")
    ap.add_argument("--local", default="")
    a = ap.parse_args()
    inc = [s for s in a.include.split(",") if s]
    files = []
    for x in tree(a.repo, a.revision, a.prefix.rstrip("/")):
        p = x["path"]
        if inc and p not in inc:
            continue
        lfs = (x.get("lfs") or {}).get("oid", "")
        if re.fullmatch(r"[0-9a-f]{64}", lfs):
            sha = lfs
        elif lfs and a.local:  # gated repos mask LFS hashes for anonymous callers: hash the local copy (size checked)
            fp = Path(a.local) / p
            assert fp.stat().st_size == x["size"], f"{p}: size differs from {a.repo}@{a.revision}"
            h = hashlib.sha256()
            with fp.open("rb") as f:
                for b in iter(lambda: f.read(1 << 20), b""):
                    h.update(b)
            sha = h.hexdigest()
        else:
            if a.local:
                data = (Path(a.local) / p).read_bytes()
            else:
                data = get(f"https://huggingface.co/{a.repo}/resolve/{a.revision}/{p}")
            blob = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
            assert blob == x["oid"], f"{p}: local copy differs from {a.repo}@{a.revision}"
            sha = hashlib.sha256(data).hexdigest()
        files.append({"path": p, "size": x["size"], "sha256": sha})
    Path(a.out).write_text(json.dumps({"repo": a.repo, "revision": a.revision, "files": files}, indent=0),
                           encoding="utf-8")
    print(len(files), "files", round(sum(f["size"] for f in files) / 1e6, 1), "MB ->", a.out)


if __name__ == "__main__":
    main()
