"""Model & tool manager: everything heavy downloads ONCE into the data dir, then works offline.

    GET  /models                 -> [item]  {id, name, purpose, size_mb, licence, licence_url, required, installed,
                                             source ("managed"|"system"|"legacy"|"bundled"|null), path, gated}
    POST /models/install {ids, source_dir?, hf_token?, mirror_url?}  -> job (byte progress; resumable HTTP Range
                                             downloads; SHA-256 verify; verified files are moved into place with
                                             os.replace). Failed jobs carry `error_code`: "hf_auth_required" (HTTP
                                             401/403 from huggingface.co; error_info.accept_url = the model page whose
                                             terms the user must accept), "network", "checksum".
    POST /models/remove  {ids}   -> deletes the managed copy

Layout under <data>: tools/ffmpeg/{ffmpeg,ffprobe}.exe, tools/deep-filter/deep-filter.exe,
models/indic-conformer-600m/assets/*, models/embed/multilingual-e5-small/*, models/whisper/<name>/*,
models/cutout/u2net_human_seg.onnx, fonts/*. Partial downloads live in <data>/downloads/<id>/ (*.part) and resume.

Every file is pinned (URL with a fixed revision / release tag, size, sha256). `source_dir` installs from a local folder
instead (offline install from a USB stick / another PC), still SHA-verified. Gated Hugging Face repos (IndicConformer)
need a read token: stored DPAPI-encrypted in settings (`hf_token_dpapi`, see config.hf_token) or env HF_TOKEN /
HUGGING_FACE_HUB_TOKEN; it is sent only to huggingface.co as `Authorization: Bearer` and never logged. Mirrors:
settings `models_mirror_url` (one base URL that replaces https://huggingface.co/ for every HF item, i.e.
<mirror>/<repo>/resolve/<revision>/<path>) and `model_mirrors: {id: "https://host/path/"}` (file URL = mirror + path).

Tool resolution (`ffmpeg()`, `ffprobe()`, `deep_filter()`): explicit settings.paths.* -> managed copy -> system PATH
(ffmpeg only, when settings.allow_system_tools and the build is new enough: >= 6 with libass + libx264) -> legacy
dev-machine paths (settings.legacy_tools).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlparse

from . import config
from .jobs import CREATE_NO_WINDOW, Job, JobError

MANIFESTS = Path(__file__).resolve().parent / "manifests"
HF_ROOT = "https://huggingface.co/"
HF = HF_ROOT + "{repo}/resolve/{rev}/"
NOTO = "https://raw.githubusercontent.com/notofonts/notofonts.github.io/983116fbb1e1c231cf33f1f4ec0f9456055fe1e1/fonts/"
UA = {"User-Agent": "viku-engine/0.1 (model manager)"}
CHUNK = 1 << 20


def _hf_manifest(name: str) -> tuple[str, list[dict]]:
    m = json.loads((MANIFESTS / f"{name}.json").read_text(encoding="utf-8"))
    return HF.format(repo=m["repo"], rev=m["revision"]), m["files"]


def _items(mirror_url: str | None = None) -> dict[str, dict]:
    """Item specs. files: [{path (relative to dest), url, size, sha256}] or archive: {url, size, sha256, members}.
    `mirror_url` (else settings.models_mirror_url) replaces https://huggingface.co/ in every HF item's URLs."""
    d = config.data_dir()
    items: dict[str, dict] = {}

    items["ffmpeg"] = {
        "name": "FFmpeg 9.0.2 (gyan.dev essentials build)", "required": True,
        "purpose": "Decoding, proxies, audio, captions (libass) and the final H.264/AAC render.",
        "licence": "GPL-3.0-or-later (built with --enable-gpl --enable-version3)",
        "licence_url": "https://ffmpeg.org/legal.html",
        "dest": d / "tools" / "ffmpeg",
        "archive": {"url": "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
                    "size": 114768076,
                    "sha256": "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
                    "members": {"bin/ffmpeg.exe": "ffmpeg.exe", "bin/ffprobe.exe": "ffprobe.exe",
                                "LICENSE": "LICENSE.txt", "README.txt": "README.txt"}},
        "check": ["ffmpeg.exe", "ffprobe.exe"],
    }
    items["deep-filter"] = {
        "name": "DeepFilterNet 3 (deep-filter CLI 0.5.6)", "required": True,
        "purpose": "Speech enhancement (noise / room removal) on every reel. Standalone Rust binary, no Python.",
        "licence": "MIT OR Apache-2.0", "licence_url": "https://github.com/Rikorose/DeepFilterNet#license",
        "dest": d / "tools" / "deep-filter",
        "files": [{"path": "deep-filter.exe", "size": 26912256,
                   "sha256": "75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915",
                   "url": "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/"
                          "deep-filter-0.5.6-x86_64-pc-windows-msvc.exe"}],
        "notice": "DeepFilterNet (c) Hendrik Schroter - MIT OR Apache-2.0 - https://github.com/Rikorose/DeepFilterNet\n",
    }
    base, files = _hf_manifest("indic-conformer-600m")
    items["indic-conformer"] = {
        "name": "IndicConformer 600M multilingual (AI4Bharat)", "required": True,
        "purpose": "Odia and Hindi speech recognition (captions, transcript, language id).",
        "licence": "MIT", "licence_url": "https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual",
        "dest": d / "models" / "indic-conformer-600m", "gated": True,
        "accept_url": "https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual",
        "files": [dict(f, url=base + f["path"]) for f in files],
        "notice": "ai4bharat/indic-conformer-600m-multilingual @ 2a77d305 - MIT License - (c) AI4Bharat\n",
    }
    base, files = _hf_manifest("multilingual-e5-small")
    items["e5-small"] = {
        "name": "multilingual-e5-small (ONNX)", "required": True,
        "purpose": "Meaning of captions: clip ranking, verse matching, illustration matching.",
        "licence": "MIT", "licence_url": "https://huggingface.co/intfloat/multilingual-e5-small",
        "dest": d / "models" / "embed" / "multilingual-e5-small",
        "files": [dict(f, url=base + f["path"], path=f["path"].split("/")[-1]) for f in files],
        "notice": "intfloat/multilingual-e5-small - MIT License - https://huggingface.co/intfloat/multilingual-e5-small\n",
        "local_sources": [Path(__file__).resolve().parents[2] / "models" / "embed" / "multilingual-e5-small" / "onnx"],
    }
    fonts = {"NotoSansOriya-Bold.ttf": ("NotoSansOriya/hinted/ttf/", 130104,
                                        "1c575e8aba40d6baf200e8abac534e9517f431d38cc8131715643037eec149da"),
             "NotoSansOriya-Regular.ttf": ("NotoSansOriya/hinted/ttf/", 131216,
                                           "a16645d056017927406546aa78e4ce15e782fd8783467267b75450453d007415"),
             "NotoSansDevanagari-Bold.ttf": ("NotoSansDevanagari/hinted/ttf/", 250176,
                                             "6a09c8d797cfc803d32cdc731e809424d74cbaff59f503de34ade421a08e5bc2"),
             "NotoSansDevanagari-Regular.ttf": ("NotoSansDevanagari/hinted/ttf/", 243520,
                                                "4e3c66638958c3e2ab5d37f47a8deb89fffeb7be9985c665a519bbc7ba762313"),
             "NotoSans-Bold.ttf": ("NotoSans/hinted/ttf/", 631484,
                                   "1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913"),
             "NotoSans-Regular.ttf": ("NotoSans/hinted/ttf/", 621572,
                                      "478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823")}
    items["fonts"] = {
        "name": "Noto Sans Oriya / Devanagari / Latin", "required": True,
        "purpose": "Caption, verse card and thumbnail fonts (redistributable).",
        "licence": "SIL Open Font License 1.1", "licence_url": "https://openfontlicense.org",
        "dest": config.sub("fonts"),
        "files": [{"path": k, "url": NOTO + v[0] + k, "size": v[1], "sha256": v[2]} for k, v in fonts.items()]
        + [{"path": "LICENSE-OFL.txt", "url": NOTO + "LICENSE", "size": 4374,
            "sha256": "f2095b08bed08b23a6fe26112fcd679a2bee3f002eef077eb05d215ed1051bd8"}],
    }
    items["yunet"] = {
        "name": "YuNet face detector (OpenCV Zoo)", "required": True, "bundled": True,
        "purpose": "Finds the speaker's face to choose the fixed crop and keep verse cards off faces.",
        "licence": "MIT", "licence_url": "https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet",
        "dest": config.ASSETS, "check": ["yunet.onnx"], "size": 232589,
    }
    base, files = _hf_manifest("faster-whisper-base.en")
    items["whisper-base-en"] = {
        "name": "Whisper base.en (faster-whisper / CTranslate2)", "required": False,
        "purpose": "English speech recognition (sermons preached in English).",
        "licence": "MIT", "licence_url": "https://huggingface.co/Systran/faster-whisper-base.en",
        "dest": d / "models" / "whisper" / "base.en",
        "files": [dict(f, url=base + f["path"]) for f in files],
        "notice": "OpenAI Whisper base.en converted by Systran (faster-whisper) - MIT License\n",
    }
    base, files = _hf_manifest("faster-whisper-small")
    items["whisper-small"] = {
        "name": "Whisper small multilingual (faster-whisper)", "required": False,
        "purpose": "Multilingual Whisper (2x slower than base.en); used for English only when base.en is not installed.",
        "licence": "MIT", "licence_url": "https://huggingface.co/Systran/faster-whisper-small",
        "dest": d / "models" / "whisper" / "small",
        "files": [dict(f, url=base + f["path"]) for f in files],
        "notice": "OpenAI Whisper small converted by Systran (faster-whisper) - MIT License\n",
    }
    items["u2net-human-seg"] = {
        "name": "U-2-Net human segmentation", "required": False,
        "purpose": "Cuts the pastor out of a frame for thumbnails (thumbnails still render without it, less polished).",
        "licence": "Apache-2.0 (U-2-Net) / MIT (rembg export)", "licence_url": "https://github.com/xuebinqin/U-2-Net",
        "dest": d / "models" / "cutout",
        "files": [{"path": "u2net_human_seg.onnx", "size": 175997641,
                   "sha256": "01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c",
                   "url": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx"}],
        "notice": "U-2-Net human segmentation (Qin et al. 2020) - Apache License 2.0 - https://github.com/xuebinqin/U-2-Net\n"
                  "ONNX export: rembg by Daniel Gatis - MIT License - https://github.com/danielgatis/rembg\n",
    }
    hf_mirror = (mirror_url if mirror_url is not None else config.settings().get("models_mirror_url") or "").strip()
    for k, it in items.items():
        it["id"] = k
        it["hf"] = any(f["url"].startswith(HF_ROOT) for f in it.get("files", []))
        if hf_mirror and it["hf"]:
            for f in it["files"]:
                f["url"] = hf_mirror.rstrip("/") + "/" + f["url"][len(HF_ROOT):]
            it["mirrored"] = True
        mirror = (config.settings().get("model_mirrors") or {}).get(k)
        if mirror:
            it["mirrored"] = True
            for f in it.get("files", []):
                f["url"] = mirror.rstrip("/") + "/" + f["path"]
            if "archive" in it:
                it["archive"]["url"] = mirror.rstrip("/") + "/" + it["archive"]["url"].rsplit("/", 1)[-1]
        if "size" not in it:
            it["size"] = it["archive"]["size"] if "archive" in it else sum(f["size"] for f in it.get("files", []))
    return items


ORDER = ["ffmpeg", "deep-filter", "indic-conformer", "e5-small", "fonts", "yunet", "whisper-base-en", "whisper-small",
         "u2net-human-seg"]


# ------------------------------------------------------------- state ------
def _files_ok(it: dict) -> bool:
    dest = Path(it["dest"])
    if "files" in it:
        return all((dest / f["path"]).is_file() and (dest / f["path"]).stat().st_size == f["size"] for f in it["files"])
    return all((dest / c).is_file() for c in it.get("check", []))


def managed_installed(item_id: str) -> bool:
    return _files_ok(_items()[item_id])


_sys_cache: dict[str, tuple[float, str]] = {}


def _system_ffmpeg() -> str:
    """A system ffmpeg on PATH that is new enough (>= 6, libass + libx264), else ""."""
    hit = _sys_cache.get("ffmpeg")
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    found = ""
    exe = shutil.which("ffmpeg")
    if exe:
        try:
            out = subprocess.run([exe, "-hide_banner", "-version"], capture_output=True, timeout=15,
                                 creationflags=CREATE_NO_WINDOW).stdout.decode("utf-8", "replace")
            m = re.search(r"ffmpeg version n?(\d+)", out)
            new = (m and int(m.group(1)) >= 6) or re.search(r"ffmpeg version (N-|git)", out)
            if new and "--enable-libass" in out and "--enable-libx264" in out and shutil.which("ffprobe"):
                found = exe
        except Exception:  # noqa: BLE001
            pass
    _sys_cache["ffmpeg"] = (time.time(), found)
    return found


def _explicit(key: str) -> str:
    v = config.path(key)
    return v if v and os.path.isabs(v) and Path(v).is_file() else ""


def ffmpeg() -> str:
    return _resolve_ff("ffmpeg")


def ffprobe() -> str:
    return _resolve_ff("ffprobe")


def _resolve_ff(name: str) -> str:
    if e := _explicit(name):
        return e
    managed = config.data_dir() / "tools" / "ffmpeg" / f"{name}.exe"
    if managed.is_file():
        return str(managed)
    s = config.settings()
    if s.get("allow_system_tools", True):
        sys_ff = _system_ffmpeg()
        if sys_ff:
            return sys_ff if name == "ffmpeg" else (shutil.which("ffprobe") or name)
    return name  # will fail with a clear "not found" -> /health says first-run setup is needed


def ffmpeg_source() -> str | None:
    if _explicit("ffmpeg"):
        return "settings"
    if (config.data_dir() / "tools" / "ffmpeg" / "ffmpeg.exe").is_file():
        return "managed"
    if config.settings().get("allow_system_tools", True) and _system_ffmpeg():
        return "system"
    return None


def deep_filter() -> str:
    if e := _explicit("deep_filter"):
        return e
    p = config.data_dir() / "tools" / "deep-filter" / "deep-filter.exe"
    return str(p) if p.is_file() else ""


def whisper_model_dir() -> str:
    """Installed faster-whisper model: base.en first (English-only; on a test clip `small` forced to English dropped the
    first sentence), small when it is the only one; settings.paths.faster_whisper_model overrides."""
    if e := config.path("faster_whisper_model"):
        if Path(e, "model.bin").is_file():
            return e
    for k in ("whisper-base-en", "whisper-small"):
        it = _items()[k]
        if _files_ok(it):
            return str(it["dest"])
    return ""


def indic_model_dir() -> str:
    """Folder that holds assets/ of IndicConformer: settings.paths.indic_dir (legacy layout <dir>/models/indic-conformer-600m
    or the model folder itself) -> managed copy -> legacy dev path."""
    for base in [config.path("indic_dir")]:
        if base:
            for cand in (Path(base), Path(base) / "models" / "indic-conformer-600m"):
                if (cand / "assets" / "encoder.onnx").is_file():
                    return str(cand)
    it = _items()["indic-conformer"]
    if _files_ok(it):
        return str(it["dest"])
    leg = config.legacy("indic_dir")
    if leg and (Path(leg) / "models" / "indic-conformer-600m" / "assets" / "encoder.onnx").is_file():
        return str(Path(leg) / "models" / "indic-conformer-600m")
    return ""


def item_state(it: dict) -> tuple[bool, str | None, str]:
    k = it["id"]
    if k == "ffmpeg":
        src = ffmpeg_source()
        return bool(src), src, ffmpeg() if src else ""
    if it.get("bundled"):
        return _files_ok(it), "bundled", str(it["dest"])
    ok = _files_ok(it)
    if ok:
        return True, "managed", str(it["dest"])
    if k == "indic-conformer":
        p = indic_model_dir()
        if p:
            return True, ("settings" if config.path("indic_dir") else "legacy"), p
    if k == "deep-filter" and _explicit("deep_filter"):
        return True, "settings", _explicit("deep_filter")
    return False, None, ""


def list_items() -> list[dict]:
    """`needs_token`: downloading this item from huggingface.co needs an HF read token whose account accepted the
    terms at `accept_url` (false once it is installed or a mirror serves it). `token_set`: a token is stored."""
    out = []
    token = bool(config.hf_token())
    for k, it in _items().items():
        inst, src, p = item_state(it)
        gated = bool(it.get("gated"))
        out.append({"id": k, "name": it["name"], "purpose": it["purpose"], "size_mb": round(it["size"] / 1e6, 1),
                    "licence": it["licence"], "licence_url": it["licence_url"], "required": it["required"],
                    "installed": inst, "source": src, "path": p, "gated": gated,
                    "needs_token": gated and not inst and not it.get("mirrored"),
                    "accept_url": it.get("accept_url"), "token_set": token if gated else None,
                    "partial_mb": round(_partial_bytes(k) / 1e6, 1)})
    out.sort(key=lambda x: ORDER.index(x["id"]) if x["id"] in ORDER else 99)
    return out


def setup_needed() -> list[str]:
    """Required items that are not usable yet (first-run setup)."""
    return [x["id"] for x in list_items() if x["required"] and not x["installed"]]


# ---------------------------------------------------------- download ------
def staging(item_id: str) -> Path:
    return config.sub("downloads") / item_id


def _partial_bytes(item_id: str) -> int:
    d = config.data_dir() / "downloads" / item_id
    if not d.exists():
        return 0
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())


def hf_token() -> str:
    return config.hf_token()


def _is_hf(url: str) -> bool:
    return urlparse(url).hostname == "huggingface.co"


class _NoAuthRedirect(urllib.request.HTTPRedirectHandler):
    """Follow redirects (HF -> CDN, GitHub -> objects) but never forward the Authorization header to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urlparse(newurl).hostname != urlparse(req.full_url).hostname:
            for h in ("Authorization", "authorization"):
                new.headers.pop(h, None)
                new.unredirected_hdrs.pop(h, None)
        return new


_opener = urllib.request.build_opener(_NoAuthRedirect)


def _sha256_file(p: Path, h=None) -> "hashlib._Hash":
    h = h or hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda: f.read(CHUNK), b""):
            h.update(b)
    return h


class _Progress:
    def __init__(self, job: Job, total: int):
        self.job, self.total, self.done, self.t = job, max(total, 1), 0, 0.0
        self.label = ""

    def add(self, n: int):
        self.done += n
        now = time.time()
        if now - self.t > 0.25:
            self.t = now
            self.job.update(self.done / self.total, f"{self.label} {self.done / 1e6:,.0f} / {self.total / 1e6:,.0f} MB")
            self.job.result = {"bytes_done": self.done, "bytes_total": self.total}


def _download(url: str, part: Path, size: int, sha: str, prog: _Progress, job: Job,
              accept_url: str | None = None) -> None:
    """Resumable download into `part` (HTTP Range), then SHA-256 verify. Raises JobError with code
    hf_auth_required / network / checksum."""
    part.parent.mkdir(parents=True, exist_ok=True)
    have = part.stat().st_size if part.exists() else 0
    if have > size:
        part.unlink()
        have = 0
    h = hashlib.sha256()
    if have:
        _sha256_file(part, h)
        prog.add(have)
    tries = 0
    while have < size:
        job.check()
        hdr = dict(UA)
        if have:
            hdr["Range"] = f"bytes={have}-"
        token = hf_token() if _is_hf(url) else ""
        if token:  # only ever to huggingface.co; _NoAuthRedirect drops it on the CDN redirect
            hdr["Authorization"] = "Bearer " + token
        try:
            with _opener.open(urllib.request.Request(url, headers=hdr), timeout=60) as r:
                if have and r.status != 206:  # server ignored Range: start over
                    part.unlink()
                    prog.add(-have)
                    have, h = 0, hashlib.sha256()
                with part.open("ab") as f:
                    while True:
                        job.check()
                        b = r.read(CHUNK)
                        if not b:
                            break
                        f.write(b)
                        h.update(b)
                        have += len(b)
                        prog.add(len(b))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and _is_hf(url):
                page = accept_url or url.split("/resolve/")[0]
                why = ("the stored token was refused - check it is a valid read token and that this account accepted "
                       "the model's terms" if token else "no Hugging Face token is stored")
                raise JobError(f"Hugging Face refused the download (HTTP {e.code}): {why}. This model is gated: sign in "
                               f"at huggingface.co, accept the terms on {page}, create a read token and enter it in "
                               "Setup - or install from a folder (source_dir) or a mirror (mirror_url).",
                               code="hf_auth_required",
                               info={"accept_url": page, "http_status": e.code, "token_sent": bool(token)}) from None
            if e.code == 416 and have >= size:
                break
            tries += 1
            if tries > 4 or e.code in (401, 403, 404, 410):
                raise JobError(f"download failed (HTTP {e.code}) from {urlparse(url).hostname}: "
                               f"{url.rsplit('/', 1)[-1]}", code="network",
                               info={"http_status": e.code, "host": urlparse(url).hostname}) from None
            time.sleep(2 * tries)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            tries += 1
            if tries > 4:
                reason = getattr(e, "reason", e)
                raise JobError(f"download failed ({reason}) from {urlparse(url).hostname} - check the internet "
                               "connection and retry; the partial file is kept and resumes", code="network",
                               info={"host": urlparse(url).hostname}) from None
            time.sleep(2 * tries)
    if have != size or h.hexdigest() != sha:
        part.unlink(missing_ok=True)
        raise JobError(f"checksum mismatch for {url.rsplit('/', 1)[-1]} - the download was corrupted or the mirror "
                       "serves a different file; retry", code="checksum",
                       info={"file": url.rsplit("/", 1)[-1], "expected_sha256": sha, "got_bytes": have})


def _from_local(src_dirs: list[Path], rel: str, part: Path, size: int, sha: str, prog: _Progress, job: Job) -> bool:
    for d in src_dirs:
        for cand in (d / rel, d / Path(rel).name, d / "assets" / Path(rel).name):
            if cand.is_file() and cand.stat().st_size == size:
                part.parent.mkdir(parents=True, exist_ok=True)
                h = hashlib.sha256()
                with cand.open("rb") as i, part.open("wb") as o:
                    for b in iter(lambda: i.read(CHUNK), b""):
                        job.check()
                        o.write(b)
                        h.update(b)
                        prog.add(len(b))
                if h.hexdigest() == sha:
                    return True
                part.unlink(missing_ok=True)
                prog.add(-size)
    return False


def _install_one(it: dict, prog: _Progress, job: Job, src_dirs: list[Path]) -> None:
    dest = Path(it["dest"])
    st = staging(it["id"])
    prog.label = it["name"].split(" (")[0]
    if "archive" in it:
        a = it["archive"]
        zpath = st / a["url"].rsplit("/", 1)[-1]
        part = zpath.with_name(zpath.name + ".part")
        if not (zpath.is_file() and zpath.stat().st_size == a["size"]):
            if not _from_local(src_dirs, zpath.name, part, a["size"], a["sha256"], prog, job):
                _download(a["url"], part, a["size"], a["sha256"], prog, job, it.get("accept_url"))
            os.replace(part, zpath)
        else:
            prog.add(a["size"])
        job.update(None, f"unpacking {zpath.name}")
        dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zpath) as z:
            for info in z.infolist():
                for suffix, out in a["members"].items():
                    if info.filename.replace("\\", "/").endswith("/" + suffix):
                        tmp = dest / (out + ".part")
                        with z.open(info) as i, tmp.open("wb") as o:
                            shutil.copyfileobj(i, o, CHUNK)
                        os.replace(tmp, dest / out)
        missing = [c for c in it.get("check", []) if not (dest / c).is_file()]
        if missing:
            raise JobError(f"{zpath.name} did not contain {missing}")
        shutil.rmtree(st, ignore_errors=True)
    else:
        todo = []
        for f in it["files"]:
            p = dest / f["path"]
            if p.is_file() and p.stat().st_size == f["size"]:
                prog.add(f["size"])
                continue
            todo.append(f)
        for f in todo:
            part = st / (f["path"] + ".part")
            if not _from_local(src_dirs + [Path(s) for s in it.get("local_sources", [])], f["path"], part, f["size"],
                               f["sha256"], prog, job):
                _download(f["url"], part, f["size"], f["sha256"], prog, job, it.get("accept_url"))
        # every file verified -> move into place (same volume: os.replace is atomic per file)
        for f in todo:
            p = dest / f["path"]
            p.parent.mkdir(parents=True, exist_ok=True)
            os.replace(st / (f["path"] + ".part"), p)
        shutil.rmtree(st, ignore_errors=True)
    if it.get("notice"):
        (dest / "LICENSE-VIKU.txt").write_text(it["notice"], encoding="utf-8")
    (dest / ".viku-installed.json").write_text(json.dumps({"id": it["id"], "t": time.time(), "size": it["size"]}),
                                               encoding="utf-8")


_install_lock = threading.Lock()


def install(job: Job, ids: list[str] | None, source_dir: str | None = None, mirror_url: str | None = None) -> dict:
    mirror_url = (mirror_url or "").strip() or None
    if mirror_url and not re.match(r"https?://", mirror_url):
        raise JobError(f"mirror_url must start with http:// or https:// (got {mirror_url!r})", code="bad_request")
    if source_dir and not Path(source_dir).is_dir():
        raise JobError(f"source_dir is not a folder: {source_dir}", code="bad_request")
    items = _items(mirror_url)
    ids = ids or [k for k in ORDER if items[k]["required"]]
    bad = [k for k in ids if k not in items]
    if bad:
        raise JobError(f"unknown model id(s): {bad}")
    src_dirs = [Path(source_dir)] if source_dir else []
    todo = [items[k] for k in ids if not items[k].get("bundled") and not _files_ok(items[k])]
    # ffmpeg: a suitable system ffmpeg is fine unless the caller asked for the managed copy explicitly
    total = sum(it["size"] for it in todo)
    prog = _Progress(job, total)
    done = []
    with _install_lock:
        for it in todo:
            _install_one(it, prog, job, src_dirs)
            done.append(it["id"])
    _sys_cache.clear()
    if mirror_url and any(items[k].get("hf") for k in done):  # the mirror worked: remember it for later installs
        config.save_settings({"models_mirror_url": mirror_url})
    return {"installed": done, "already": [k for k in ids if k not in done], "bytes": total,
            "items": [x for x in list_items() if x["id"] in ids]}


def remove(ids: list[str]) -> dict:
    items = _items()
    removed = []
    for k in ids:
        it = items.get(k)
        if not it or it.get("bundled"):
            continue
        dest = Path(it["dest"])
        if "archive" in it:
            for out in it["archive"]["members"].values():
                (dest / out).unlink(missing_ok=True)
        else:
            for f in it["files"]:
                (dest / f["path"]).unlink(missing_ok=True)
        for extra in ("LICENSE-VIKU.txt", ".viku-installed.json"):
            (dest / extra).unlink(missing_ok=True)
        shutil.rmtree(staging(k), ignore_errors=True)
        removed.append(k)
    _sys_cache.clear()
    return {"removed": removed, "items": list_items()}


def ensure(item_id: str, job: Job | None = None) -> Path:
    """Install one item synchronously if missing (used lazily by e5 / fonts / cut-out)."""
    it = _items()[item_id]
    if not _files_ok(it):
        from .jobs import MANAGER
        j = job or Job(MANAGER, "models_install")
        _install_one(it, _Progress(j, it["size"]), j, [])
    return Path(it["dest"])
