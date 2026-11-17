"""POST /automate: video -> project -> analyze -> suggest top N -> build -> render, one job."""
from __future__ import annotations

from pathlib import Path

from . import projects
from .brain import clipfinder
from .jobs import Job, JobError
from .media import analyze, reel


def suggest_job(pid: str, job: Job, count: int = 8, rng: list | None = None, max_seconds: float = 60.0,
                max_overlap: float = 0.25) -> list[dict]:
    p = projects.load(pid)
    if not p.get("transcript"):
        raise JobError("no transcript yet - run /analyze first")
    job.update(0.05, "building windows")
    sug = clipfinder.suggest(p, count=count, rng=rng, job=job, max_seconds=max_seconds, max_overlap=max_overlap)

    def upd(pp):
        pp["suggestions"] = sug
    projects.update(pid, upd)
    return sug


def build_reel(pid: str, s: dict, job: Job, render: bool = True, framing: str = "follow") -> dict:
    """One suggestion -> reel -> autobuild (-> render). Progress: build 0-0.4, render 0.4-1 of the current scope.
    framing: "follow" = auto framing (the crop pans with the speaker), "fixed" = one still crop per shot."""
    r = reel.create(pid, s["segments"], s["title"], "", {"suggestion": s["id"], "score": s["score"],
                                                      "title_auto": True, "sub_auto": True,
                                                      "framing": framing if framing in ("follow", "fixed") else "follow"})
    with job.scope(0.0, 0.4 if render else 1.0):
        reel.autobuild(r["id"], job)
    res = {"reel": r["id"], "score": s["score"], "suggested_title": s["title"]}
    if render:
        with job.scope(0.4, 1.0):
            res |= reel.render(r["id"], job)
    # the title the reel actually carries: autobuild's hook writer + ASR-quality gate replace the suggestion's
    stored = projects.find_reel(r["id"])[1]
    res |= {"title": stored.get("title") or s["title"], "sub": stored.get("sub", ""),
            "title_flag": stored.get("title_flag"), "mood": stored.get("mood")}
    return res


def run(job: Job, video_path: str = "", language: str = "or", count: int = 3, rng: list | None = None,
        project_id: str | None = None, name: str = "", render: bool = True, max_seconds: float = 60.0,
        pick: int = 0, framing: str = "follow") -> dict:
    """pick > 0: stop after analyze + suggest and return the top `pick` suggestions for the editor to choose from
    ({"project", "stage": "pick", "suggestions"}); POST /automate/build then makes the chosen one."""
    if project_id:
        p = projects.load(project_id)
    else:
        if not video_path or not Path(video_path).exists():
            raise JobError(f"video not found: {video_path}")
        p = projects.new_project(name or Path(video_path).stem, video_path, language)
    pid = p["id"]
    with job.scope(0.0, 0.9 if pick else 0.45):
        analyze.run(pid, job, rng)
    if pick:
        with job.scope(0.9, 1.0):
            # alternatives for ONE reel: they may share up to half their span (separate reels: a quarter)
            sug = suggest_job(pid, job, count=pick, rng=rng, max_seconds=max_seconds, max_overlap=0.5)
        return {"project": pid, "stage": "pick", "suggestions": sug}
    with job.scope(0.45, 0.5):
        sug = suggest_job(pid, job, count=count, rng=rng, max_seconds=max_seconds)
    out = []
    n = max(len(sug), 1)
    for i, s in enumerate(sug):
        with job.scope(0.5 + 0.5 * i / n, 0.5 + 0.5 * (i + 1) / n):
            out.append(build_reel(pid, s, job, render, framing))
    return {"project": pid, "reels": out}


def find_suggestion(pid: str, suggestion_id: str = "", suggestion: dict | None = None) -> dict:
    """The suggestion the editor picked: the one the app sends (it survives a later /suggest replacing the stored
    list), else the project's stored one by id."""
    if suggestion and suggestion.get("segments"):
        segs = [[float(a), float(b)] for a, b in suggestion["segments"]]
        if not all(b > a >= 0 for a, b in segs):
            raise JobError("suggestion segments must be [start, end] pairs with end > start")
        return {"id": str(suggestion.get("id") or suggestion_id or "picked"), "segments": segs,
                "title": str(suggestion.get("title") or ""), "score": float(suggestion.get("score") or 0.0)}
    s = next((x for x in projects.load(pid).get("suggestions", []) if x.get("id") == suggestion_id), None)
    if s is None:
        raise JobError(f"suggestion {suggestion_id} not found - run Automate again to refresh the suggestions")
    return s


def build_suggestion(job: Job, pid: str, s: dict, render: bool = True, framing: str = "follow") -> dict:
    """POST /automate/build: make the suggestion the editor picked. Same result shape as /automate."""
    return {"project": pid, "reels": [build_reel(pid, s, job, render, framing)]}
