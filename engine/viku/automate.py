"""POST /automate: video -> project -> analyze -> suggest top N -> build -> render, one job."""
from __future__ import annotations

from pathlib import Path

from . import projects
from .brain import clipfinder
from .jobs import Job, JobError
from .media import analyze, reel


def suggest_job(pid: str, job: Job, count: int = 8, rng: list | None = None) -> list[dict]:
    p = projects.load(pid)
    if not p.get("transcript"):
        raise JobError("no transcript yet - run /analyze first")
    job.update(0.05, "building windows")
    sug = clipfinder.suggest(p, count=count, rng=rng, job=job)

    def upd(pp):
        pp["suggestions"] = sug
    projects.update(pid, upd)
    return sug


def run(job: Job, video_path: str = "", language: str = "or", count: int = 3, rng: list | None = None,
        project_id: str | None = None, name: str = "", render: bool = True) -> dict:
    if project_id:
        p = projects.load(project_id)
    else:
        if not video_path or not Path(video_path).exists():
            raise JobError(f"video not found: {video_path}")
        p = projects.new_project(name or Path(video_path).stem, video_path, language)
    pid = p["id"]
    with job.scope(0.0, 0.45):
        analyze.run(pid, job, rng)
    with job.scope(0.45, 0.5):
        sug = suggest_job(pid, job, count=count, rng=rng)
    out = []
    n = max(len(sug), 1)
    for i, s in enumerate(sug):
        a, b = 0.5 + 0.5 * i / n, 0.5 + 0.5 * (i + 1) / n
        r = reel.create(pid, s["segments"], s["title"], "", {"suggestion": s["id"], "score": s["score"]})
        with job.scope(a, a + (b - a) * 0.4):
            reel.autobuild(r["id"], job)
        res = {"reel": r["id"], "title": s["title"], "score": s["score"]}
        if render:
            with job.scope(a + (b - a) * 0.4, b):
                res |= reel.render(r["id"], job)
        out.append(res)
    return {"project": pid, "reels": out}
