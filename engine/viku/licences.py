"""Third-party components and their licences: `GET /licences` and the repo's THIRD_PARTY_NOTICES.md.

One source of truth, `components()`:
  - Python packages: every package the installer puts in the engine env (`uv sync --frozen --no-dev --group asr`),
    i.e. the closure of the project's main + `asr` dependencies in uv.lock, with the licence from the installed
    package metadata (License-Expression > License > classifiers) and its project URL;
  - runtime: CPython (uv-managed, python-build-standalone) and uv;
  - tools / models / fonts from the model manager (models.py), with the notices written next to them;
  - data: the Bible texts with the exact attribution strings printed on verse cards.

`notices_markdown()` renders the same data; `python -m viku.licences [out.md]` (default ../THIRD_PARTY_NOTICES.md)
regenerates the file.
"""
from __future__ import annotations

import importlib.metadata as md
import sys
import tomllib
from datetime import date
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
LOCK = ENGINE / "uv.lock"
SHIPPED_GROUPS = ("asr",)  # dependency groups the installer installs besides the main dependencies

# Packages whose metadata carries no usable licence string (checked by hand against the project's LICENSE file).
LICENCE_OVERRIDES = {
    "tokenizers": "Apache-2.0",
    "jinja2": "BSD-3-Clause",
    "colorama": "BSD-3-Clause",
    "mpmath": "BSD-3-Clause",
    "sympy": "BSD-3-Clause",
    "protobuf": "BSD-3-Clause",
    "soundfile": "BSD-3-Clause",
    "flatbuffers": "Apache-2.0",
    "opencv-python-headless": "Apache-2.0 (OpenCV; the wheel bundles FFmpeg libraries under LGPL-2.1)",
    "certifi": "MPL-2.0",
    "ctranslate2": "MIT",
    "faster-whisper": "MIT",
    "h11": "MIT",
    "httpx": "BSD-3-Clause",
    "huggingface-hub": "Apache-2.0",
    "pyyaml": "MIT",
    "onnxruntime": "MIT",
}
CLASSIFIER_SPDX = {
    "MIT License": "MIT", "BSD License": "BSD", "Apache Software License": "Apache-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0", "Python Software Foundation License": "PSF-2.0",
    "ISC License (ISCL)": "ISC",
}


# ------------------------------------------------------------ python env --
def _lock() -> dict:
    return tomllib.loads(LOCK.read_text(encoding="utf-8"))


def shipped_packages(lock: dict | None = None) -> list[tuple[str, str]]:
    """(name, version) of every package in the shipped env: closure of main + SHIPPED_GROUPS deps (all markers)."""
    lock = lock or _lock()
    pk: dict[str, list[dict]] = {}
    for p in lock["package"]:
        pk.setdefault(p["name"], []).append(p)
    root = next(p for p in lock["package"] if p.get("source", {}).get("editable") == "." or p["name"] == "viku-engine")
    todo = [d["name"] for d in root.get("dependencies", [])]
    for g in SHIPPED_GROUPS:
        todo += [d["name"] for d in root.get("dev-dependencies", {}).get(g, [])]
    seen: set[str] = set()
    while todo:
        n = todo.pop()
        if n in seen or n not in pk:
            continue
        seen.add(n)
        for p in pk[n]:
            todo += [d["name"] for d in p.get("dependencies", [])]
    out = []
    for n in sorted(seen):
        try:
            v = md.version(n)
        except md.PackageNotFoundError:
            v = pk[n][-1].get("version", "")
        out.append((n, v))
    return out


def _pkg_licence(name: str) -> tuple[str, str]:
    """(licence, url) from installed metadata."""
    try:
        m = md.metadata(name)
    except md.PackageNotFoundError:
        return LICENCE_OVERRIDES.get(name, "see project"), f"https://pypi.org/project/{name}/"
    lic = LICENCE_OVERRIDES.get(name) or m.get("License-Expression") or ""
    raw = (m.get("License") or "").strip()
    if not lic and raw and "\n" not in raw and len(raw) <= 60:
        lic = raw
    if not lic:
        cls = [c.split("::")[-1].strip() for c in (m.get_all("Classifier") or []) if c.startswith("License ::")]
        lic = " / ".join(CLASSIFIER_SPDX.get(c, c) for c in cls) or LICENCE_OVERRIDES.get(name, "see project")
    url = m.get("Home-page") or ""
    if not url:
        pairs = [(u.split(",", 1)[0].strip().lower(), u.split(",", 1)[-1].strip())
                 for u in (m.get_all("Project-URL") or []) if "," in u]
        pref = ("source", "source code", "repository", "code", "github", "homepage", "home")
        best = sorted((pref.index(lbl) if lbl in pref else 99, i, u) for i, (lbl, u) in enumerate(pairs))
        url = best[0][2] if best and best[0][0] < 99 else f"https://pypi.org/project/{name}/"
    return lic, url


def python_components() -> list[dict]:
    out = []
    for n, v in shipped_packages():
        lic, url = _pkg_licence(n)
        out.append({"id": f"py:{n}", "kind": "python", "name": n, "version": v, "licence": lic, "url": url,
                    "delivered": "installer (uv sync from uv.lock)"})
    return out


# ------------------------------------------------------------ the rest ---
def _model_components() -> list[dict]:
    from . import models
    out = []
    for it in models._items().values():
        kind = "font" if it["id"] == "fonts" else ("tool" if it["id"] in ("ffmpeg", "deep-filter") else "model")
        url = it.get("archive", {}).get("url") or (it["files"][0]["url"] if it.get("files") else "")
        out.append({"id": it["id"], "kind": kind, "name": it["name"], "version": "", "licence": it["licence"],
                    "url": it["licence_url"], "download": url, "required": it["required"],
                    "delivered": "bundled with the engine" if it.get("bundled") else "downloaded on first run",
                    "notice": (it.get("notice") or "").strip()})
    extra = {
        "ffmpeg": {"version": "9.0.2", "source": "https://github.com/GyanD/codexffmpeg (build scripts) - FFmpeg source: "
                   "https://ffmpeg.org/download.html#releases",
                   "notice": "FFmpeg (c) the FFmpeg developers, https://ffmpeg.org. This Windows build by Gyan Doshi "
                             "(gyan.dev, 'essentials') is configured with --enable-gpl --enable-version3 and therefore "
                             "licensed GPL-3.0-or-later as a whole (libx264 GPL-2.0+, libass ISC, HarfBuzz MIT, FreeType "
                             "FTL, FriBidi LGPL-2.1+). Viku runs it as a separate program and does not link it. The "
                             "build's LICENSE file is installed next to ffmpeg.exe."},
        "deep-filter": {"version": "0.5.6", "source": "https://github.com/Rikorose/DeepFilterNet"},
        "indic-conformer": {"version": "rev 2a77d305", "notice": "IndicConformer 600M multilingual (c) AI4Bharat, IIT "
                            "Madras - MIT License. Inference code vendored in viku/runners/indic_model.py (MIT). Gated "
                            "download: the user accepts AI4Bharat's terms on Hugging Face."},
        "e5-small": {"version": "", "notice": "multilingual-e5-small (c) Microsoft / Liang Wang et al. (intfloat) - "
                     "MIT License."},
        "fonts": {"version": "notofonts.github.io @983116f", "notice": "Noto Sans, Noto Sans Oriya, Noto Sans Devanagari "
                  "(c) The Noto Project Authors (https://github.com/notofonts) - SIL Open Font License 1.1. "
                  "The OFL text is installed as fonts/LICENSE-OFL.txt."},
        "yunet": {"version": "2023mar", "notice": "YuNet face detector (c) Shiqi Yu, Wei Wu et al. - from OpenCV Zoo, "
                  "MIT License."},
        "whisper-base-en": {"notice": "Whisper (c) OpenAI - MIT License; CTranslate2 conversion by SYSTRAN "
                            "(faster-whisper) - MIT License."},
        "whisper-small": {"notice": "Whisper (c) OpenAI - MIT License; CTranslate2 conversion by SYSTRAN "
                          "(faster-whisper) - MIT License."},
    }
    for c in out:
        for k, v in extra.get(c["id"], {}).items():
            if v:
                c[k] = v
    return out


def _runtime_components() -> list[dict]:
    return [
        {"id": "cpython", "kind": "runtime", "name": "CPython", "version": sys.version.split()[0],
         "licence": "PSF-2.0", "url": "https://docs.python.org/3/license.html",
         "delivered": "installer (uv-managed python-build-standalone)",
         "notice": "Python (c) Python Software Foundation - PSF License Agreement. Build: "
                   "https://github.com/astral-sh/python-build-standalone (its bundled libraries carry their own "
                   "permissive licences, listed in the distribution)."},
        {"id": "uv", "kind": "runtime", "name": "uv (Astral)", "version": "", "licence": "MIT OR Apache-2.0",
         "url": "https://github.com/astral-sh/uv", "delivered": "installer (bundled uv.exe)"},
        {"id": "faster-whisper+ctranslate2", "kind": "runtime", "name": "faster-whisper / CTranslate2",
         "version": "", "licence": "MIT", "url": "https://github.com/SYSTRAN/faster-whisper",
         "delivered": "installer (Python packages faster-whisper, ctranslate2)",
         "notice": "faster-whisper (c) SYSTRAN - MIT; CTranslate2 (c) OpenNMT / SYSTRAN - MIT."},
    ]


def _bible_components() -> list[dict]:
    from . import bible
    names = {"or": "Indian Revised Version (IRV) Odia", "hi": "Indian Revised Version (IRV) Hindi",
             "en": "World English Bible (WEB)"}
    lic = {"or": ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/"),
           "hi": ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/"),
           "en": ("Public domain", "https://worldenglish.bible/")}
    out = []
    for lang, t in bible.TRANSLATIONS.items():
        out.append({"id": f"bible:{t['code']}", "kind": "data", "name": names[lang], "version": t["code"],
                    "licence": lic[lang][0], "url": lic[lang][1], "download": t["url"],
                    "delivered": "downloaded on first run (eBible.org USFM)",
                    "attribution": t["attribution"],
                    "notice": "Reels quoting this text must carry the attribution above (the verse card / description); "
                              "adapted verse text is shared under CC BY-SA 4.0."
                    if lang != "en" else "The name \"World English Bible\" is a trademark; the text is public domain."})
    return out


STARTER_LICENCE = ("AI-generated (Google Gemini / AI Studio) by the Viku project, free to use in Viku videos")


def _content_components() -> list[dict]:
    """Viku's own bundled / generated content (not third-party, listed so editors know what they may publish)."""
    from . import library
    st = library.starter_status()
    n = st.get("count") or 119
    return [
        {"id": "viku:starter-illustrations", "kind": "content", "name": "Viku starter illustrations", "version": "",
         "licence": STARTER_LICENCE, "url": "",
         "delivered": f"bundled with the installer ({n} images, 1080x1920 JPEG), imported into an empty library on "
                      "first run",
         "notice": "Created for Viku's sermon reels with Google Gemini / AI Studio image generation. Free to use in "
                   "videos made with Viku; Google's Generative AI terms apply to the generation."},
        {"id": "viku:generated-music", "kind": "content", "name": "Viku generated music", "version": "",
         "licence": "Royalty-free - generated on your PC by Viku's music generator; free to use in any video",
         "url": "",
         "delivered": "made on first run (5 default moods) and on demand (Library > Music > Generate music); "
                      "no recordings, samples or licensed tracks are shipped",
         "notice": "Procedural synthesis (viku/music_gen.py). Tracks from HeyGen or your own files keep their own "
                   "licences."},
    ]


def components() -> list[dict]:
    order = {"runtime": 0, "tool": 1, "model": 2, "font": 3, "data": 4, "content": 5, "python": 6}
    items = (_runtime_components() + _model_components() + _bible_components() + _content_components()
             + python_components())
    return sorted(items, key=lambda c: (order.get(c["kind"], 9), c["name"].lower()))


def summary() -> dict:
    cs = components()
    return {"generated": date.today().isoformat(), "count": len(cs), "components": cs}


# ------------------------------------------------------------ markdown ---
TITLES = {"runtime": "Runtime", "tool": "Tools (downloaded on first run)", "model": "Models",
          "font": "Fonts", "data": "Bible texts", "content": "Viku content (bundled / generated)",
          "python": "Python packages (engine environment)"}


def notices_markdown() -> str:
    cs = components()
    out = ["# Third-party notices - Viku (Sermon Reel Studio)", "",
           "Generated from the engine (`GET /licences`, `uv run python -m viku.licences`); do not edit by hand.",
           "Viku's own code is not covered here. Each component below keeps its own licence; full licence texts",
           "are installed next to downloaded tools and models (LICENSE*.txt) or available at the linked URL.", ""]
    for kind in TITLES:
        group = [c for c in cs if c["kind"] == kind]
        if not group:
            continue
        out += [f"## {TITLES[kind]}", ""]
        if kind == "python":
            out += ["| Package | Version | Licence | Project |", "|---|---|---|---|"]
            out += [f"| {c['name']} | {c['version']} | {c['licence']} | {c['url']} |" for c in group]
            out.append("")
            continue
        for c in group:
            ver = f" {c['version']}" if c.get("version") and c["version"] not in c["name"] else ""
            out.append(f"### {c['name']}{ver}")
            out.append(f"- Licence: {c['licence']}" + (f" - {c['url']}" if c.get("url") else ""))
            if c.get("attribution"):
                out.append(f"- Attribution (exact): \"{c['attribution']}\"")
            if c.get("download"):
                out.append(f"- Source: {c['download']}")
            if c.get("source"):
                out.append(f"- Corresponding source: {c['source']}")
            out.append(f"- Delivered: {c.get('delivered', '')}")
            if c.get("notice"):
                out.append(f"- Notice: {' '.join(c['notice'].split())}")
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def write_notices(path: Path | None = None) -> Path:
    path = path or ENGINE.parent / "THIRD_PARTY_NOTICES.md"
    path.write_text(notices_markdown(), encoding="utf-8", newline="\n")
    return path


if __name__ == "__main__":
    print(write_notices(Path(sys.argv[1]) if len(sys.argv) > 1 else None))
