"""Viku engine HTTP API (FastAPI). Contract: ARCHITECTURE.md. Run: `uv run viku-engine` -> http://127.0.0.1:8765"""
from __future__ import annotations

import asyncio
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from . import __version__, asr, automate, bible, config, library, music, projects
from .brain import captions as capfix
from .brain import embed, feedback
from .jobs import CREATE_NO_WINDOW, MANAGER, Job, JobError
from .media import analyze, assets_setup, audio, enhance, reel

app = FastAPI(title="Viku engine", version=__version__)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(projects.NotFound)
async def _nf(_: Request, e: projects.NotFound):
    return JSONResponse({"error": f"not found: {e}"}, status_code=404)


@app.exception_handler(projects.Invalid)
async def _inv(_: Request, e: projects.Invalid):
    return JSONResponse({"error": str(e)}, status_code=400)


@app.exception_handler(JobError)
async def _je(_: Request, e: JobError):
    return JSONResponse({"error": str(e), "code": e.code, **e.info}, status_code=400)


def job_ref(j: Job) -> dict:
    return {"job": j.id, "kind": j.kind, "state": j.state}


# ------------------------------------------------------------------ health --
_gpu: str | None = None


def gpu_name() -> str:
    global _gpu
    if _gpu is None:
        try:
            _gpu = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True,
                                  text=True, timeout=5, creationflags=CREATE_NO_WINDOW).stdout.strip().splitlines()[0]
        except Exception:
            _gpu = ""
    return _gpu


@app.get("/health")
def health():
    from . import llm, models
    from .asr import indic, whisper
    a = asr.available()
    items = models.list_items()
    missing = [x["id"] for x in items if x["required"] and not x["installed"]]
    if not indic.runtime_ok() and not indic.python():
        missing.append("asr-runtime")
    return {"ok": True, "version": __version__, "gpu": gpu_name() or None, "data_dir": str(config.data_dir()),
            "setup_needed": bool(missing), "setup_missing": missing,
            "offline_ready": {"asr": a["indic"] or a["whisper"], "denoise": enhance.mode() != "ffmpeg-afftdn",
                              "embed": embed.available(), "bible": bible.ready(), "library": library.count() > 0,
                              "ffmpeg": models.ffmpeg_source() is not None},
            "models": {x["id"]: {"installed": x["installed"], "source": x["source"], "required": x["required"]}
                       for x in items},
            "llm": llm.status(),
            "details": {"asr_indic": a["indic"], "asr_whisper_en": a["whisper"], "asr_en_engine": whisper.engine() or None,
                        "asr_runtime": indic.runtime_ok(), "denoise_engine": enhance.mode(),
                        "ffmpeg": models.ffmpeg(), "ffmpeg_source": models.ffmpeg_source(),
                        "bible": bible.status(), "library_images": library.count(), "music_tracks": len(music.list_tracks()),
                        "starter_images": library.starter_status().get("imported", 0),
                        "fonts": assets_setup.fonts_ready(), "sfx": assets_setup.sfx_ready()}}


# ------------------------------------------------------------------ models --
@app.get("/models")
def models_list():
    from . import models
    return models.list_items()


class ModelsReq(BaseModel):
    ids: list[str] | None = None   # None = every required item that is missing
    source_dir: str | None = None  # install from a local folder (offline) instead of downloading
    hf_token: str | None = None    # stored DPAPI-encrypted in settings, sent as Authorization: Bearer to huggingface.co
    mirror_url: str | None = None  # base URL replacing https://huggingface.co/ (saved as models_mirror_url on success)


@app.post("/models/install")
def models_install(b: ModelsReq | None = None):
    from . import models
    b = b or ModelsReq()
    if b.hf_token and b.hf_token.strip():
        config.save_settings({"hf_token": b.hf_token})
    return job_ref(MANAGER.submit("models_install",
                                  lambda job: models.install(job, b.ids, b.source_dir, mirror_url=b.mirror_url),
                                  {"ids": b.ids}))


@app.get("/licences")
def licences_list():
    """Every third-party component (Python packages of the shipped env, runtime, tools, models, fonts, Bible texts)
    with its licence; the same data as THIRD_PARTY_NOTICES.md."""
    from . import licences
    return licences.summary()


@app.post("/models/remove")
def models_remove(b: ModelsReq):
    from . import models
    return models.remove(b.ids or [])


# ---------------------------------------------------------------- settings --
@app.get("/settings")
def get_settings():
    return config.public_settings()


@app.post("/settings")
def post_settings(patch: dict[str, Any]):
    config.save_settings(patch)
    return config.public_settings()


# ---------------------------------------------------------------- projects --
class NewProject(BaseModel):
    name: str = ""
    video_path: str
    language: str = "or"


@app.post("/projects")
def create_project(b: NewProject):
    return projects.new_project(b.name, b.video_path, b.language)


@app.get("/projects")
def list_projects():
    return projects.list_projects()


@app.get("/projects/{pid}")
def get_project(pid: str):
    return projects.load(pid)


@app.put("/projects/{pid}")
def put_project(pid: str, body: dict[str, Any]):
    if body.get("id") != pid:
        raise projects.Invalid("id in body must match the URL")
    with projects.lock(pid):
        old = {r["id"]: r for r in projects.load(pid).get("reels", [])}
        for r in body.get("reels", []):  # an edited title / sub is the editor's: autobuild stops rewriting it
            o = old.get(r.get("id"))
            if o and r.get("title") != o.get("title") and r.get("title_auto") == o.get("title_auto"):
                r["title_auto"] = False
            if o and r.get("sub") != o.get("sub") and r.get("sub_auto") == o.get("sub_auto"):
                r["sub_auto"] = False
        return projects.save(body)


class AnalyzeReq(BaseModel):
    range: list[float] | None = None
    steps: dict[str, bool] | None = None


@app.post("/projects/{pid}/analyze")
def analyze_project(pid: str, b: AnalyzeReq | None = None):
    projects.load(pid)
    b = b or AnalyzeReq()
    j = MANAGER.submit("analyze", lambda job: analyze.run(pid, job, b.range, b.steps), {"project": pid})
    return job_ref(j)


@app.get("/projects/{pid}/waveform")
def waveform(pid: str, start: float = 0.0, end: float | None = None, px: int = 1000):
    p = projects.load(pid)
    if not p.get("peaks") or not Path(p["peaks"]).exists():
        raise HTTPException(409, "not analysed yet")
    pk = np.load(p["peaks"], mmap_mode="r")
    end = p["duration"] if end is None else end
    return {"start": start, "end": end, "px": px, "per_sec": analyze.PEAKS_PER_SEC,
            "peaks": audio.resample_peaks(pk, analyze.PEAKS_PER_SEC, start, end, min(max(px, 1), 20000))}


class SuggestReq(BaseModel):
    count: int = 8
    range: list[float] | None = None


@app.post("/projects/{pid}/suggest")
def suggest(pid: str, b: SuggestReq | None = None):
    projects.load(pid)
    b = b or SuggestReq()
    j = MANAGER.submit("suggest", lambda job: automate.suggest_job(pid, job, b.count, b.range), {"project": pid})
    return job_ref(j)


class NewReel(BaseModel):
    segments: list[list[float]]
    title: str = ""
    sub: str = ""


@app.post("/projects/{pid}/reels")
def create_reel(pid: str, b: NewReel):
    return reel.create(pid, b.segments, b.title, b.sub)


@app.get("/reels/{rid}")
def get_reel(rid: str):
    return projects.find_reel(rid)[1]


class BuildReq(BaseModel):
    steps: dict[str, bool] | None = None


@app.post("/reels/{rid}/autobuild")
def autobuild(rid: str, b: BuildReq | None = None):
    projects.find_reel(rid)
    steps = (b or BuildReq()).steps
    return job_ref(MANAGER.submit("autobuild", lambda job: reel.autobuild(rid, job, steps), {"reel": rid}))


@app.post("/reels/{rid}/render")
def render(rid: str):
    projects.find_reel(rid)
    return job_ref(MANAGER.submit("render", lambda job: reel.render(rid, job), {"reel": rid}))


class ThumbReq(BaseModel):
    style: str | None = None      # thumbs.STYLES key; None = auto (not the previous reel's style)
    pose_t: float | None = None   # reel seconds; None = auto (eyes open, frontal, big face)
    title: str | None = None      # None = reel title (Hinglish transliteration for Hindi reels)
    sub: str | None = None
    verse: str | None = None
    renderer: str | None = None   # "browser" | "pillow" (fallback); None = browser if Chrome/Edge is found


@app.post("/reels/{rid}/thumbnail")
def thumbnail(rid: str, b: ThumbReq | None = None):
    projects.find_reel(rid)
    b = b or ThumbReq()
    from .media import thumbs

    def run(job: Job):
        return thumbs.make(rid, job, style=b.style, pose_t=b.pose_t, title=b.title, sub=b.sub, verse=b.verse,
                           renderer=b.renderer)
    return job_ref(MANAGER.submit("thumbnail", run, {"reel": rid}))


@app.get("/thumbnails/styles")
def thumbnail_styles():
    from .media import thumbs
    return [{"id": k, "label": v.get("label", k)} for k, v in thumbs.STYLES.items()]


class DescribeReq(BaseModel):
    use_llm: bool = False   # True: draft with a local Ollama model when one is running (optional, never required)


@app.post("/reels/{rid}/describe")
def reel_describe(rid: str, b: DescribeReq | None = None):
    from . import llm
    projects.find_reel(rid)
    return llm.describe(rid, (b or DescribeReq()).use_llm)


@app.get("/reels/{rid}/needs")
def reel_needs(rid: str):
    return reel.needs(rid)


class AttachReq(BaseModel):
    path: str
    tags: list[str] = []


@app.post("/reels/{rid}/cutaways/{i}/image")
def reel_attach(rid: str, i: int, b: AttachReq):
    return reel.attach_image(rid, i, b.path, b.tags)


class AutomateReq(BaseModel):
    video_path: str = ""
    language: str = "or"
    count: int = 3
    range: list[float] | None = None
    project_id: str | None = None
    render: bool = True


@app.post("/automate")
def automate_ep(b: AutomateReq):
    j = MANAGER.submit("automate", lambda job: automate.run(job, b.video_path, b.language, b.count, b.range,
                                                            b.project_id, render=b.render))
    return job_ref(j)


# ------------------------------------------------------------------ brain --
class FixReq(BaseModel):
    text: str
    lang: str = "or"
    alt: str | None = None


@app.post("/captions/fix")
def captions_fix(b: FixReq):
    return capfix.fix(b.text, b.lang, b.alt)


class FeedbackReq(BaseModel):
    reel_id: str
    kind: str
    before: Any = None
    after: Any = None
    lang: str | None = None


@app.post("/feedback")
def post_feedback(b: FeedbackReq):
    rec = feedback.add(b.reel_id, b.kind, b.before, b.after, b.lang)
    return {"ok": True, "stored": {k: rec[k] for k in ("t", "reel_id", "kind")}, "learned": rec.get("learned")}


@app.post("/learn")
def learn():
    return job_ref(MANAGER.submit("learn", lambda job: feedback.learn(job)))


# ------------------------------------------------------------------ bible --
@app.get("/bible/verse")
def bible_verse(ref: str, lang: str = "or"):
    return bible.verse(ref, lang)


@app.get("/bible/similar")
def bible_similar(text: str, lang: str = "or", k: int = 10):
    """Verses closest to `text`: e5 meaning (every verse embedded in <data>/bible/<code>.emb.npy) + shared rare words."""
    from .brain import scripture
    return scripture.rank_verses(text, lang, k)


@app.get("/bible/search")
def bible_search(q: str, lang: str = "or", limit: int = 30):
    return bible.search(q, lang, limit)


class BibleDl(BaseModel):
    langs: list[str] | None = None


@app.post("/bible/download")
def bible_download(b: BibleDl | None = None):
    langs = (b or BibleDl()).langs
    return job_ref(MANAGER.submit("bible_download", lambda job: bible.download(job, langs)))


# ---------------------------------------------------------------- library --
@app.get("/library/search")
def library_search(q: str = "", limit: int = 40):
    return library.search(q, limit)


class ImportReq(BaseModel):
    paths: list[str] = []
    tags: list[str] = []
    desc: str = ""      # optional English scene text (e.g. the generation prompt's SCENE) used for matching
    set: str = ""       # optional set name (default: the source folder name)
    seed: bool = False


@app.post("/library/import")
def library_import(b: ImportReq):
    def run(job: Job):
        res = library.seed() if b.seed else {"added": 0, "skipped": 0, "items": []}
        if b.paths:
            r2 = library.import_paths(b.paths, b.tags, desc=b.desc, setname=b.set)
            res = {"added": res["added"] + r2["added"], "skipped": res["skipped"] + r2["skipped"],
                   "items": res["items"] + r2["items"]}
        return res
    return job_ref(MANAGER.submit("library_import", run))


# ------------------------------------------------------------------ music --
@app.get("/music")
def music_list():
    return music.list_tracks()


@app.post("/music/seed")
def music_seed():
    return {"added": music.seed()}


@app.get("/music/moods")
def music_moods():
    from . import music_gen
    return [{"id": k, **v} for k, v in music_gen.MOODS.items()]


class MusicGenReq(BaseModel):
    mood: str = "hopeful"
    seed: int | None = None       # None = a new random seed
    duration: float = 90.0        # seconds (20-240); the bed loops seamlessly
    preview: bool = False         # True: render into <data>/music_previews; POST /music/keep adds it


@app.post("/music/generate")
def music_generate(b: MusicGenReq):
    """Job: an offline, royalty-free underscore bed (viku.music_gen) -> the music library, tagged "viku generated"."""
    return job_ref(MANAGER.submit("music_generate",
                                  lambda job: music.generate(job, b.mood, b.seed, b.duration, b.preview),
                                  {"mood": b.mood}))


class MusicKeepReq(BaseModel):
    path: str


@app.post("/music/keep")
def music_keep(b: MusicKeepReq):
    try:
        return music.keep(b.path)
    except JobError as e:
        raise HTTPException(400, str(e))


@app.delete("/music/{name}")
def music_delete(name: str):
    if not music.remove(name):
        raise HTTPException(404, "no such track")
    return {"ok": True}


@app.get("/starter")
def starter():
    """Bundled starter content: illustration pack status + generated default music."""
    tracks = music.list_tracks()
    return {"illustrations": library.starter_status(),
            "music": {"generated": sum(1 for t in tracks if t.get("source") == "viku"), "tracks": len(tracks),
                      "defaults_job": _DEFAULTS_JOB.get("id")}}


class HeygenReq(BaseModel):
    intent: str


@app.post("/music/heygen")
def music_heygen(b: HeygenReq):
    return job_ref(MANAGER.submit("music_heygen", lambda job: music.heygen(b.intent, job)))


# ------------------------------------------------------------------- auth --
@app.get("/auth/status")
def auth_status():
    return {"gemini_web": None,  # owned by the Electron sign-in window, not the engine
            "heygen": (Path.home() / ".hyperframes" / "credentials").exists(),
            "ebible": "downloaded" if bible.ready() else "missing"}


@app.post("/auth/heygen/login")
def heygen_login():
    def run(job: Job):
        import re
        npx = config.path("npx") or "npx"
        exe = npx + (".cmd" if not npx.lower().endswith((".cmd", ".exe")) else "")
        p = job.popen([exe, "hyperframes", "auth", "login", "--device"], stdout=subprocess.PIPE,
                      stderr=subprocess.STDOUT)
        info: dict[str, Any] = {}
        try:
            for line in iter(p.stdout.readline, b""):
                s = line.decode("utf-8", "replace").strip()
                if m := re.search(r"https?://\S+", s):
                    info["url"] = m.group(0)
                if m := re.search(r"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b", s):
                    info["code"] = m.group(1)
                if s:
                    job.update(0.5, s[:300])
                    job.result = info
            p.wait()
        finally:
            job.release(p)
        if p.returncode != 0:
            raise JobError("HeyGen login failed or was cancelled")
        return info | {"ok": True}
    return job_ref(MANAGER.submit("heygen_login", run))


# ------------------------------------------------------------------- jobs --
@app.get("/jobs")
def jobs_list():
    return [j.as_dict() for j in sorted(MANAGER.jobs.values(), key=lambda j: -j.created)][:200]


@app.get("/jobs/{jid}")
def job_get(jid: str):
    j = MANAGER.jobs.get(jid)
    if not j:
        raise HTTPException(404, "no such job")
    return j.as_dict()


@app.post("/jobs/{jid}/cancel")
def job_cancel(jid: str):
    j = MANAGER.jobs.get(jid)
    if not j:
        raise HTTPException(404, "no such job")
    j.cancel()
    return {"ok": True}


@app.get("/events")
async def events(request: Request):
    q = MANAGER.subscribe()

    async def gen():
        try:
            yield "retry: 2000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            MANAGER.unsubscribe(q)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ media --
@app.get("/media")
def media(path: str = Query(...)):
    f = Path(path)
    if not f.is_file():
        raise HTTPException(404, "file not found")
    return FileResponse(str(f))  # Starlette FileResponse answers Range requests (206)


# ---------------------------------------------------------------- startup --
_DEFAULTS_JOB: dict = {}


def _first_run():
    """Fresh install: the bundled starter illustrations into an empty library, the 5 default music beds into an
    empty music library (a visible `music_defaults` job), SFX, fonts. The user-folder seeds run only with VIKU_DEV=1."""
    try:
        if library.count() == 0:
            r = library.import_starter()
            print(f"starter illustrations: {r['added']} imported", flush=True)
    except Exception as e:  # noqa: BLE001
        print("starter illustrations failed:", e, flush=True)
    try:
        music.seed()          # dev machine only (VIKU_DEV=1)
        if not music.list_tracks():
            _DEFAULTS_JOB["id"] = MANAGER.submit("music_defaults", music.ensure_defaults).id
    except Exception as e:  # noqa: BLE001
        print("default music failed:", e, flush=True)
    try:
        assets_setup.ensure_sfx()
    except Exception as e:  # noqa: BLE001
        print("first-run sfx:", e, flush=True)
    try:
        assets_setup.ensure_fonts()
    except Exception as e:  # noqa: BLE001
        print("fonts download failed (offline?) - will retry at render:", e, flush=True)


@app.on_event("startup")
def _startup():
    threading.Thread(target=_first_run, daemon=True).start()


def main():
    import uvicorn
    host = os.environ.get("VIKU_HOST", "127.0.0.1")
    port = int(os.environ.get("VIKU_PORT", "8765"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
