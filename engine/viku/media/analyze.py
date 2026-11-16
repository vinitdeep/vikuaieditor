"""POST /projects/{id}/analyze

Whole file (cheap, done once): 16 kHz mono wav, waveform peaks (100/s min/max), pause list.
Per range (default whole video; `range: [s, e]` to analyse a part): 540p proxy (H.264, keyframe
every 1 s for scrubbing), shot cuts (frame difference) and transcription. Re-analysing a range
replaces transcript items / shots inside it and keeps the rest.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np

from .. import asr, projects
from ..jobs import Job
from . import audio, ff

PEAKS_PER_SEC = 100


def ensure_wav16(p: dict, job: Job, prog=(0.0, 1.0)) -> Path:
    d = projects.pdir(p["id"])
    wav = d / "audio16k.wav"
    if not wav.exists():
        tmp = d / "audio16k.tmp.wav"
        ff.run_progress(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", p["video_path"], "-vn", "-ac", "1",
                         "-ar", "16000", "-c:a", "pcm_s16le", str(tmp)], job, p["duration"], prog, "extracting audio")
        tmp.replace(wav)
    return wav


def shot_cuts(video: str, start: float, end: float, job: Job, prog=(0.0, 1.0), sample: int = 6,
              thresh: float = 28.0, min_gap: float = 0.5) -> list[float]:
    """Camera cuts = big mean abs difference between consecutive 160x90 gray frames (track.py logic)."""
    W, H = 160, 90
    p = job.popen([ff.ffmpeg(), "-nostdin", "-loglevel", "error", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
                   "-i", video, "-vf", f"fps={sample},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    cuts, last, i, n = [], None, 0, W * H
    total = max(int((end - start) * sample), 1)
    try:
        while True:
            b = p.stdout.read(n)
            if len(b) < n:
                break
            f = np.frombuffer(b, np.uint8).astype(np.int16)
            if last is not None and np.abs(f - last).mean() > thresh:
                t = round(start + i / sample, 3)
                if not cuts or t - cuts[-1] >= min_gap:  # flashes / fast pans fire on several samples
                    cuts.append(t)
            last = f
            i += 1
            if i % (sample * 30) == 0:
                job.check()
                job.update(prog[0] + (prog[1] - prog[0]) * min(i / total, 1), "finding camera cuts")
        p.wait()
    finally:
        job.release(p)
    return cuts


def _merge_range(old: list, new: list, s: float, e: float, key=lambda x: x["start"]) -> list:
    kept = [x for x in old if not (s - 1e-3 <= key(x) < e)]
    return sorted(kept + new, key=key)


def run(pid: str, job: Job, rng: list | None = None, steps: dict | None = None) -> dict:
    steps = {"proxy": True, "shots": True, "asr": True, **(steps or {})}
    p = projects.load(pid)
    s, e = (0.0, p["duration"]) if not rng else (max(0.0, float(rng[0])), min(p["duration"], float(rng[1])))
    if e - s < 1:
        from ..jobs import JobError
        raise JobError("analyze range is empty")
    d = projects.pdir(pid)

    job.span(0.0, 0.10)
    wav = ensure_wav16(p, job)
    job.span(0.10, 0.15)
    pk_path = d / "peaks.npy"
    full = None
    if not pk_path.exists() or not p.get("pauses"):
        job.update(0.0, "waveform + pauses")
        full = ff.read_wav16(str(wav))
        np.save(pk_path, audio.peaks(full, PEAKS_PER_SEC))
        pauses = audio.pauses(audio.frame_db(full))
        del full

        def upd(pp):
            pp["wav16"], pp["peaks"], pp["pauses"] = str(wav), str(pk_path), pauses
        projects.update(pid, upd)

    if steps["proxy"]:
        job.span(0.15, 0.45)
        whole = not rng
        prox = d / ("proxy.mp4" if whole else f"proxy_{int(s)}_{int(e)}.mp4")
        if not prox.exists():
            tmp = prox.with_suffix(".tmp.mp4")
            ff.run_progress(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{s:.3f}", "-to", f"{e:.3f}",
                             "-i", p["video_path"], "-vf", "scale=-2:540", "-c:v", "libx264", "-preset", "veryfast",
                             "-crf", "26", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
                             "-force_key_frames", "expr:gte(t,n_forced*1)", "-c:a", "aac", "-b:a", "96k",
                             "-movflags", "+faststart", str(tmp)], job, e - s, (0, 1), "making 540p proxy")
            tmp.replace(prox)

        def upd(pp):
            pp["proxy"], pp["proxy_offset"] = str(prox), round(s, 3)
            pr = [x for x in pp.get("proxies", []) if x["path"] != str(prox)]
            pp["proxies"] = pr + [{"path": str(prox), "start": round(s, 3), "end": round(e, 3)}]
        projects.update(pid, upd)

    if steps["shots"]:
        job.span(0.45, 0.60)
        cuts = shot_cuts(p["video_path"], s, e, job)

        def upd(pp):
            pp["shots"] = sorted([t for t in pp.get("shots", []) if not (s <= t < e)] + cuts)
        projects.update(pid, upd)

    if steps["asr"]:
        job.span(0.60, 1.0)
        job.update(0.0, "finding speech")
        x = ff.read_wav16(str(wav), s, e)
        chunks = [[a, b] for a, b in audio.segment(x, max_cue=6.0)]
        tmpd = Path(tempfile.mkdtemp(prefix="viku_an_"))
        part = tmpd / "part.wav"
        import soundfile as sf
        sf.write(str(part), x, 16000, subtype="PCM_16")
        del x
        items = asr.transcribe(str(part), chunks, p["language"], job)
        for it in items:
            it["start"] = round(it["start"] + s, 3)
            it["end"] = round(it["end"] + s, 3)

        def upd(pp):
            pp["transcript"] = _merge_range(pp.get("transcript", []), items, s, e)
            an = [r for r in pp.get("analyzed", []) if not (r[0] >= s and r[1] <= e)]
            pp["analyzed"] = sorted(an + [[round(s, 3), round(e, 3)]])
        projects.update(pid, upd)
        try:
            part.unlink()
        except OSError:
            pass

    p = projects.load(pid)
    return {"project": pid, "range": [s, e], "transcript_items": sum(1 for t in p["transcript"] if s <= t["start"] < e),
            "shots": sum(1 for t in p["shots"] if s <= t < e), "pauses": len(p["pauses"]), "proxy": p.get("proxy")}
