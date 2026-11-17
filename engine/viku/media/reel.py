"""Reel build + render.

create()     POST /projects/{id}/reels  - segments (absolute source s, play order) -> draft reel
autobuild()  POST /reels/{id}/autobuild - jump-cut join, framing (auto follow or fixed crops), speech enhancement, caption re-ASR,
             verse detection, cutaway plan + library picks, music pick, SFX
render()     POST /reels/{id}/render    - final 1080x1920 mp4 (+ thumbnail) into exports/

Ports jumpcut.py, static_tracks.py, enhance_audio.py, reel_illus.py and mix_reel.py.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

from .. import asr, config, projects
from ..jobs import Job, JobError
from . import ass, assets_setup, audio, enhance, ff, framing

FPS = 30
TRANS = 0.70   # cross-zoom dissolve (s)
ZOOM = 0.07
BLUR = 14.0


def snap(t: float) -> float:
    return round(round(t * FPS) / FPS, 4)


# ------------------------------------------------------------------ create --
def reel_language(p: dict, segs: list) -> str:
    if p["language"] != "auto":
        return p["language"]
    votes: dict[str, float] = {}
    for t in p.get("transcript", []):
        for s, e in segs:
            ov = min(e, t["end"]) - max(s, t["start"])
            if ov > 0:
                votes[t.get("lang", "or")] = votes.get(t.get("lang", "or"), 0) + ov
    return max(votes, key=votes.get) if votes else (config.settings().get("default_language") or "or")


def create(pid: str, segments: list, title: str = "", sub: str = "", extra: dict | None = None) -> dict:
    segs = [[snap(float(s)), snap(float(e))] for s, e in segments]
    segs = [s for s in segs if s[1] - s[0] >= 0.2]
    if not segs:
        raise projects.Invalid("segments are empty")
    out = {}

    def add(p):
        for s, e in segs:
            if s < 0 or e > p["duration"] + 0.05:
                raise projects.Invalid(f"segment {s}-{e} outside the video")
        n = max([int(r["id"].split("~")[1]) for r in p["reels"]] + [0]) + 1
        dur = round(sum(e - s for s, e in segs), 3)
        r = {"id": f"{p['id']}~{n}", "title": title, "sub": sub, "language": reel_language(p, segs),
             "segments": segs, "duration": dur, "jumps": [], "crops": [], "captions": [], "verses": [],
             "cutaways": [], "music": None, "sfx": [], "style": {"caption_size": 74},
             "thumbnail": {"style": "frame", "pose_t": None, "title": title, "sub": sub, "verse": None},
             "status": "draft", "exports": [],
             "framing": "follow" if config.settings().get("auto_framing", True) else "fixed", "follow": []}
        r.update(extra or {})
        if r.get("framing") not in ("follow", "fixed"):
            r["framing"] = "follow"
        p["reels"].append(r)
        out["r"] = r
    projects.update(pid, add)
    return out["r"]


def _save_reel(rid: str, fn):
    pid = rid.split("~", 1)[0]

    def upd(p):
        for r in p["reels"]:
            if r["id"] == rid:
                fn(r)
                return
        raise projects.NotFound(rid)
    projects.update(pid, upd)


# --------------------------------------------------------- cutaway needs --
def needs(rid: str) -> list[dict]:
    """Unfilled generation requests of a reel (for the app's AI Studio window)."""
    _, r = projects.find_reel(rid)
    out = []
    for i, c in enumerate(r.get("cutaways", [])):
        if c.get("need") and not (c.get("img") and Path(c["img"]).exists()):
            out.append({"index": i, "t0": c["t0"], "t1": c["t1"], **c["need"],
                        "suggested_name": f"{c['need']['slug']}.png"})
    return out


def attach_image(rid: str, i: int, path: str, tags: list[str] | None = None) -> dict:
    """Attach a captured / chosen picture to cutaway i: copy it into the library (tags = need slug + scene words,
    desc = the need's scene, set = this reel) and point the cutaway at the library copy."""
    from .. import library
    src = Path(path)
    if not src.is_file():
        raise projects.Invalid(f"image not found: {path}")
    p, r = projects.find_reel(rid)
    cs = r.get("cutaways", [])
    if not 0 <= i < len(cs):
        raise projects.Invalid(f"cutaway index {i} out of range (0..{len(cs) - 1})")
    need = cs[i].get("need") or {}
    words = (need.get("tags") or []) + [w for w in re.split(r"[^a-z]+", need.get("slug", "").lower()) if len(w) > 2]
    setname = f"{p['name']} reel {rid.split('~')[1]}"
    res = library.import_paths([str(src)], list(dict.fromkeys(words + (tags or []))),
                               desc=need.get("scene", "")[:400] if need.get("tags") else "", setname=setname)
    lid = res["ids"][0] if res.get("ids") else None
    item = next((it for it in library.items() if it["id"] == lid), None)
    if not item:
        raise projects.Invalid("library import failed")

    def upd(rr):
        c = rr["cutaways"][i]
        c["img"], c["lib_id"] = item["path"], item["id"]
        if c.get("need"):
            c["need_done"] = c.pop("need")
        if rr.get("status") == "rendered":
            rr["status"] = "built"
    _save_reel(rid, upd)
    return projects.find_reel(rid)[1]["cutaways"][i]


# --------------------------------------------------------------- jump cut --
def segment_offsets(segs: list) -> list[float]:
    """Reel start second of every kept segment ([0, len0, len0+len1, ...]); offsets[1:] are the jump-cut joins."""
    offs, o = [], 0.0
    for s, e in segs:
        offs.append(round(o, 4))
        o += e - s
    return offs


def src_to_reel(t: float, segs: list) -> float | None:
    """Source second -> reel second (None when t falls in a part the jump cut removed)."""
    for (s, e), o in zip(segs, segment_offsets(segs)):
        if s - 1e-6 <= t <= e + 1e-6:
            return round(o + min(max(t - s, 0.0), e - s), 4)
    return None


def reel_to_src(t: float, segs: list) -> float:
    """Reel second -> source second (clamped to the reel)."""
    offs = segment_offsets(segs)
    for (s, e), o in zip(reversed(segs), reversed(offs)):
        if t >= o - 1e-6:
            return round(s + min(max(t - o, 0.0), e - s), 4)
    return float(segs[0][0]) if segs else 0.0


def tp_guard_gain(true_peak: float | None, tp_max: float, margin: float = 0.2) -> float | None:
    """Loudness guard: dB to pull the audio down when the encoded true peak exceeds the limit (AAC overshoot),
    else None."""
    if true_peak is None or true_peak <= tp_max:
        return None
    return round(tp_max - true_peak - margin, 2)


def join_segments(src: str, segs: list, out: Path, job: Job, prog=(0.0, 1.0)) -> list[float]:
    """Kept segments back to back -> 1280x720 30 fps H.264 (crf 12) + pcm audio, 12 ms fades at each join."""
    sig = out.with_suffix(".segs.json")
    offs = segment_offsets(segs)
    o = sum(e - s for s, e in segs)
    if out.exists() and sig.exists() and json.loads(sig.read_text()) == [src, segs]:
        return offs[1:]
    args, fc = [], []
    for i, (s, e) in enumerate(segs):
        args += ["-ss", f"{s:.4f}", "-to", f"{e:.4f}", "-i", src]
        d = e - s
        fc.append(f"[{i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,"
                  f"setsar=1,fps={FPS},trim=duration={d:.4f},setpts=PTS-STARTPTS[v{i}]")
        fc.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration={d:.4f},asetpts=PTS-STARTPTS,"
                  f"afade=in:d=0.012,afade=out:st={max(d - 0.012, 0):.4f}:d=0.012[a{i}]")
    fc.append("".join(f"[v{i}][a{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=1[v][a]")
    tmp = out.with_suffix(".tmp.mkv")
    ff.run_progress(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", *args, "-filter_complex", ";".join(fc),
                     "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "12", "-preset", "fast",
                     "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", str(tmp)], job, o, prog, "joining segments")
    tmp.replace(out)
    sig.write_text(json.dumps([src, segs]))
    return offs[1:]


# ---------------------------------------------------------------- captions --
def caption_chunks(wav16: np.ndarray, bounds: list[float], max_cue=3.5) -> list[list[float]]:
    """Speech chunks per jump-cut segment so no cue crosses a join."""
    out = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        x = wav16[int(a * 16000):int(b * 16000)]
        for s, e in audio.segment(x, max_cue=max_cue, min_len=0.3,
                                  thresh=audio.threshold(audio.frame_db(wav16))):
            out.append([round(a + s, 3), round(min(a + e, b), 3)])
    return out


# ------------------------------------------------------------------ build --
def autobuild(rid: str, job: Job, steps: dict | None = None) -> dict:
    # ai_images: cutaways are all requests for new AI pictures (none taken from the library)
    steps = {"captions": True, "cutaways": True, "music": True, "ai_images": False, **(steps or {})}
    p, r = projects.find_reel(rid)
    d = projects.reel_dir(rid)
    segs = r["segments"]

    job.span(0.0, 0.25)
    src = d / "src.mkv"
    jumps = join_segments(p["video_path"], segs, src, job)
    dur = round(sum(e - s for s, e in segs), 3)

    job.span(0.25, 0.55)
    crops, follow = framing.plan_crops(str(src), dur, jumps, job, segs=segs, mode=r.get("framing", "follow"))

    job.span(0.55, 0.70)
    job.update(0.0, "speech enhancement")
    raw48 = d / "voice.raw.wav"
    ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "48000",
            str(raw48)], job=job)
    enh = d / "voice.enh.wav"
    enh_mode = enhance.enhance(str(raw48), str(enh), job)

    def upd1(rr):
        rr.update({"src": str(src), "duration": dur, "jumps": jumps, "crops": crops, "follow": follow,
                   "voice": str(enh),
                   "enhance": enh_mode})
    _save_reel(rid, upd1)

    captions = r.get("captions", [])
    if steps["captions"]:
        job.span(0.70, 0.92)
        job.update(0.0, "captions: re-transcribing the joined clip")
        w16 = d / "voice16k.wav"
        ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                "-c:a", "pcm_s16le", str(w16)], job=job)
        x = ff.read_wav16(str(w16))
        chunks = caption_chunks(x, [0.0] + jumps + [dur])
        lang = r["language"] if r["language"] in ("or", "hi", "en") else "or"
        items = asr.transcribe(str(w16), chunks, lang, job)
        from ..brain import captions as capfix
        captions = []
        for it in items:
            fx = capfix.fix(it["text"], lang, alt=it.get("alt"))
            captions.append({"t0": it["start"], "t1": it["end"], "text": fx["text"], "flags": fx["flags"],
                             "alt": it.get("alt"), "conf": it.get("conf")})
        deoverlap(captions)

    deoverlap(captions)   # also for captions kept from an earlier build (libass would stack overlapping cues)
    job.span(0.92, 1.0)
    cutaways, verses, music, sfx = r.get("cutaways", []), r.get("verses", []), r.get("music"), r.get("sfx", [])
    if steps["cutaways"]:
        from ..brain import cutaways as cutplan
        from ..brain import scripture
        job.update(0.1, "planning cutaways")
        w16 = d / "voice16k.wav"
        if not w16.exists():
            ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", str(w16)], job=job)
        xv = ff.read_wav16(str(w16))
        ref = [t["text"] for t in p.get("transcript", []) if t.get("text")]
        cutaways = cutplan.plan(captions, dur, r["language"], jumps, xv, ref, library=not steps["ai_images"])
        job.update(0.6, "matching verses")
        verses = scripture.place_verses(captions, cutaways, r["language"])
    sfx = plan_sfx([c for c in cutaways if c.get("img") and Path(c["img"]).exists()])
    # hook title + sub (verse ref / English gist) unless the editor wrote their own
    from ..brain import hooks
    n = rid.rsplit("~", 1)[-1]
    hk = (hooks.hook(captions, r["language"], verses, sermon=[t.get("text", "") for t in p.get("transcript", [])],
                     fallback_name=f"{T_short(p.get('name') or 'Sermon')} · Reel {n}")
          if captions else {"title": "", "sub": "", "title_flag": None})
    from ..music_gen import mood_for_theme
    mood = mood_for_theme(hk.get("theme"))
    if steps["music"]:   # bed by the reel's theme: victory -> victorious, prayer -> prayerful, depression -> reflective...
        music = pick_music(rid, mood)
    title_auto = not r.get("title") or bool(r.get("title_auto"))
    sub_auto = not r.get("sub") or bool(r.get("sub_auto"))
    title = hk["title"] if title_auto and hk["title"] else r.get("title", "")
    sub = hk["sub"] if sub_auto and hk["sub"] else r.get("sub", "")

    def upd2(rr):
        rr.update({"captions": captions, "cutaways": cutaways, "verses": verses, "music": music, "sfx": sfx,
                   "mood": mood, "theme": hk.get("theme"), "title": title, "sub": sub, "title_auto": title_auto,
                   "sub_auto": sub_auto, "status": "built"})
        if title_auto:  # "review": no caption line passed the ASR-quality gate - the app highlights the title
            rr["title_flag"] = hk.get("title_flag")
        th = rr.get("thumbnail") or {}
        if title_auto:
            th["title"] = title
        if sub_auto:
            th["sub"] = sub
        rr["thumbnail"] = th
    _save_reel(rid, upd2)
    return projects.find_reel(rid)[1]


def track_framing(rid: str, job: Job) -> dict:
    """POST /reels/{id}/framing - (re)track the speaker for auto framing only: crops + follow paths, framing on.
    Captions, cutaways, music and every other edit are left alone (an older reel gets auto framing this way)."""
    p, r = projects.find_reel(rid)
    d = projects.reel_dir(rid)
    segs = r["segments"]
    job.span(0.0, 0.3)
    src = d / "src.mkv"
    jumps = join_segments(p["video_path"], segs, src, job)
    dur = round(sum(e - s for s, e in segs), 3)
    job.span(0.3, 1.0)
    crops, follow = framing.plan_crops(str(src), dur, jumps, job, segs=segs, mode="follow")

    def upd(rr):
        rr.update({"crops": crops, "follow": follow, "framing": "follow", "jumps": jumps})
        if not rr.get("src"):
            rr["src"] = str(src)
    _save_reel(rid, upd)
    return {"reel": rid, "shots": len(crops)}


def T_short(name: str, n: int = 32) -> str:
    from ..brain import text as T
    return T.short_title(name.split(" _ ")[0].strip() or name, n)


def deoverlap(caps: list[dict]):
    """ASR chunks carry 0.15 s padding, so neighbours overlap; libass would stack both - meet in the middle."""
    caps.sort(key=lambda c: c["t0"])
    for a, b in zip(caps, caps[1:]):
        if a["t1"] > b["t0"]:
            m = round((a["t1"] + b["t0"]) / 2, 3)
            a["t1"], b["t0"] = m, m


def pick_music(rid: str, mood: str | None = None) -> dict | None:
    from .. import music
    t = music.pick(mood, rid)
    if not t:
        return None
    return {"path": t["path"], "gain_db": config.settings().get("music_gain_db", -19.0), "start": 0.0,
            "mood": t.get("mood") or mood}


def plan_sfx(cutaways: list) -> list[dict]:
    """Impact under the title; swell rising into each pastor->picture cut, -6 dB into picture->picture.
    NEVER bell / chime / shimmer."""
    ev = [{"name": "impact", "t": 0.10, "gain_db": 0.0}]
    prev_end = None
    for c in sorted(cutaways, key=lambda c: c["t0"]):
        g = -6.0 if prev_end is not None and abs(c["t0"] - prev_end) < 1e-3 else 0.0
        ev.append({"name": "swell", "t": round(max(c["t0"] - 0.95, 0), 3), "gain_db": g})
        prev_end = c["t1"]
    return ev


# ----------------------------------------------------------------- render --
def ease(u):
    return 0.5 - 0.5 * np.cos(np.pi * min(max(u, 0.0), 1.0))


def zoom_blur(f, z, sigma):
    if z > 1.0005:
        M = np.float32([[z, 0, 540 * (1 - z)], [0, z, 960 * (1 - z)]])
        f = cv2.warpAffine(f, M, (1080, 1920), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    if sigma > 0.3:
        small = cv2.resize(f, (270, 480), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (0, 0), sigma / 4)
        f = cv2.resize(small, (1080, 1920), interpolation=cv2.INTER_LINEAR)
    return f


class Cutaway:
    """Full-bleed still with a Ken Burns move across its visible span (dissolves included)."""

    def __init__(self, it):
        self.it = it
        self.src = cv2.imdecode(np.fromfile(it["img"], np.uint8), cv2.IMREAD_COLOR)
        if self.src is None:
            raise JobError(f"cannot read cutaway image {it['img']}")
        h, w = self.src.shape[:2]
        self.w, self.h = w, h
        self.base = max(1080 / w, 1920 / h)
        self.a, self.b = it["t0"] - TRANS / 2, it["t1"] + TRANS / 2

    def frame(self, t):
        it = self.it
        u = ease((t - self.a) / (self.b - self.a))
        z0, z1 = it.get("z0", 1.12), it.get("z1", 1.22)
        k = self.base * (z0 + (z1 - z0) * u)
        px, py = (it.get("pan") or [0, 0])[:2]
        cx, cy = self.w / 2 + px * (u - 0.5), self.h / 2 + py * (u - 0.5)
        M = np.float32([[k, 0, 540 - k * cx], [0, k, 960 - k * cy]])
        return cv2.warpAffine(self.src, M, (1080, 1920), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)


def shade_png(path: Path):
    a = np.zeros(1920, np.float32)
    y = np.arange(1920)
    a = np.maximum(a, np.clip(1 - y / 300, 0, 1) ** 2 * 0.45)
    a = np.maximum(a, np.clip((y - 1040) / 440, 0, 1) ** 1.2 * 0.80)
    a = np.maximum(a, (0.80 + 0.18 * np.clip((y - 1480) / 200, 0, 1)) * (y >= 1480))
    img = np.zeros((1920, 1080, 4), np.uint8)
    img[..., 3] = (a * 255).astype(np.uint8)[:, None]
    cv2.imwrite(str(path), img)


def render_base(src: str, crops: list, dur: float, out: Path, job: Job, prog=(0.0, 1.0), mode: str = "fixed",
                follow: list | None = None, segs: list | None = None) -> int:
    """Pass 1: framed speaker (fixed crops, or the auto-framing follow path) -> graded 1080x1920 intermediate."""
    offs = segment_offsets(segs or [])
    enc = job.popen([ff.ffmpeg(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                     "-s", "1080x1920", "-r", str(FPS), "-i", "-",
                     "-vf", "unsharp=5:5:0.8:5:5:0,eq=contrast=1.05:saturation=1.08,vignette=angle=PI/4.5",
                     "-c:v", "libx264", "-crf", "10", "-preset", "fast", "-pix_fmt", "yuv420p", str(out)],
                    stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    dec = job.popen([ff.ffmpeg(), "-nostdin", "-loglevel", "error", "-i", src, "-vf", "scale=1280:720", "-r", str(FPS),
                     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    n, i, total = 1280 * 720 * 3, 0, max(int(dur * FPS), 1)
    try:
        while True:
            b = dec.stdout.read(n)
            if len(b) < n:
                break
            f = np.frombuffer(b, np.uint8).reshape(720, 1280, 3)
            t = i / FPS
            c = framing.crop_at(crops, t)
            x = framing.x_at(c, t, mode, follow or [], segs or [], offs)
            enc.stdin.write(np.ascontiguousarray(framing.compose(f, x, c["cw"], c.get("z", 1.0))).tobytes())
            i += 1
            if i % FPS == 0:
                job.check()
                job.update(prog[0] + (prog[1] - prog[0]) * min(i / total, 1), "rendering speaker")
        enc.stdin.close()
        enc.wait()
        dec.wait()
    finally:
        job.release(enc)
        job.release(dec)
    job.check()
    if enc.returncode != 0:
        raise JobError("base render failed")
    return i


def build_shots(cuts, dur):
    shots, t = [], 0.0
    for c in cuts:
        if c.it["t0"] - t > 1e-3:
            shots.append((t, c.it["t0"], None))
        shots.append((c.it["t0"], c.it["t1"], c))
        t = c.it["t1"]
    if dur - t > 1e-3:
        shots.append((t, dur, None))
    return shots


def _loudnorm_measure(path: str, filt_pre: str, job: Job, I=-14.0, TP=-1.5) -> dict:
    cp = ff.run(["ffmpeg", "-nostdin", "-hide_banner", "-y", "-i", path, "-af",
                 f"{filt_pre}loudnorm=I={I}:TP={TP}:LRA=11:print_format=json", "-f", "null", "-"], job=job)
    err = cp.stderr.decode("utf-8", "replace")
    j = err[err.rfind("{"):err.rfind("}") + 1]
    return json.loads(j)


def mix_audio(r: dict, dur: float, out: Path, job: Job) -> dict:
    """Voice (enhanced) + music bed (-19 dB, side-chain ducked, crossfade-looped) + impact/swell SFX,
    mastered with two-pass loudnorm to -14 LUFS / -1.5 dBTP. -> 48 kHz stereo wav."""
    st = config.settings()
    preset = st["export_presets"]["reel"]
    I, TP = preset.get("lufs", -14.0), preset.get("true_peak", -1.5) - 0.5  # AAC adds ~0.3 dB overshoot
    d = out.parent
    voice = r.get("voice") or ""
    if not voice or not Path(voice).exists():
        voice = str(d / "voice.raw.wav")
        ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", r["src"], "-vn", "-ac", "1", "-ar", "48000",
                voice], job=job)
    inputs = ["-i", voice]
    fc = [f"[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:{dur:.3f},"
          f"afade=in:d=0.3,afade=out:st={max(dur - 0.6, 0):.2f}:d=0.6,loudnorm=I={I}:TP={TP},"
          f"aresample=48000,asplit=2[voice][key]"]
    mixins = ["[voice]"]
    k = 1
    m = r.get("music")
    if m and m.get("path") and Path(m["path"]).exists():
        music = m["path"]
        mstart = float(m.get("start", 0) or 0)
        mdur = ff.duration(music)
        need, XF = dur + mstart + 1.0, 2.5
        if mdur < need:
            n = 1
            while n * mdur - (n - 1) * XF < need:
                n += 1
            looped = d / "music.loop.wav"
            fl, last = [], "[0:a]"
            for i in range(1, n):
                fl.append(f"{last}[{i}:a]acrossfade=d={XF}:c1=qsin:c2=qsin[x{i}]")
                last = f"[x{i}]"
            ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", *sum([["-i", music] for _ in range(n)], []),
                    "-filter_complex", ";".join(fl), "-map", last, "-ar", "48000", str(looped)], job=job)
            music = str(looped)
        inputs += ["-ss", f"{mstart:.2f}", "-i", music]
        g = float(m.get("gain_db", -19.0))
        fc.append(f"[{k}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{dur:.3f},loudnorm=I=-14:TP=-2,"
                  f"volume={g}dB,afade=in:d=1.5,afade=out:st={max(dur - 2.5, 0):.2f}:d=2.5[mus]")
        fc.append("[mus][key]sidechaincompress=threshold=0.03:ratio=6:attack=25:release=450:makeup=1[bed]")
        mixins.append("[bed]")
        k += 1
    else:
        fc.append("[key]anullsink")
    sfx_db = st.get("sfx_gain_db", -15.0)
    sdir = assets_setup.ensure_sfx()
    for j, ev in enumerate(r.get("sfx", [])):
        name = ev["name"]
        if name not in ("impact", "swell"):   # house rule: never bell / chime / shimmer
            continue
        ms = int(round(ev["t"] * 1000))
        inputs += ["-i", str(sdir / f"{name}.wav")]
        fc.append(f"[{k}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={sfx_db + ev.get('gain_db', 0)}dB,"
                  f"adelay={ms}|{ms}[s{j}]")
        mixins.append(f"[s{j}]")
        k += 1
    fc.append(f"{''.join(mixins)}amix=inputs={len(mixins)}:normalize=0:duration=first,atrim=0:{dur:.3f}[a]"
              if len(mixins) > 1 else f"{mixins[0]}anull[a]")
    pre = d / "mix.pre.wav"
    ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(fc),
            "-map", "[a]", "-ar", "48000", "-c:a", "pcm_s24le", str(pre)], job=job)
    meas = _loudnorm_measure(str(pre), "", job, I, TP)
    ln = (f"loudnorm=I={I}:TP={TP}:LRA=11:measured_I={meas['input_i']}:measured_TP={meas['input_tp']}:"
          f"measured_LRA={meas['input_lra']}:measured_thresh={meas['input_thresh']}:offset={meas['target_offset']}:"
          f"linear=true")
    ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(pre), "-af", ln + ",aresample=48000",
            "-ar", "48000", "-c:a", "pcm_s24le", str(out)], job=job)
    return {"measured_in": meas}


def render(rid: str, job: Job) -> dict:
    p, r = projects.find_reel(rid)
    if r.get("status") == "draft" or not r.get("src") or not Path(r["src"]).exists():
        with job.scope(0.0, 0.4):
            autobuild(rid, job)
        p, r = projects.find_reel(rid)
        with job.scope(0.4, 1.0):
            return _render(p, r, job)
    return _render(p, r, job)


def _render(p: dict, r: dict, job: Job) -> dict:
    rid = r["id"]
    sub = job.span
    d = projects.reel_dir(rid)
    dur = float(r["duration"])
    st = config.settings()
    preset = st["export_presets"]["reel"]
    fontsd = assets_setup.ensure_fonts()
    assets_setup.ensure_sfx()

    sub(0.0, 0.08)
    job.update(0.0, "mixing audio")
    mix = d / "mix.wav"
    mix_info = mix_audio(r, dur, mix, job)

    sub(0.08, 0.50)
    base = d / "base.mp4"
    render_base(r["src"], r["crops"] or [{"t0": 0, "t1": dur, "cx": 640, "cw": 405, "z": 1.0}], dur, base, job,
                mode=r.get("framing", "fixed"), follow=r.get("follow") or [], segs=r["segments"])

    sub(0.50, 1.0)
    (d / "caps.ass").write_text(ass.build(r, dur, st.get("credit_line", "")), encoding="utf-8-sig")
    shade = d / "shade.png"
    shade_png(shade)
    # unfilled generation requests (img None, `need`) stay on the speaker until the app attaches a picture
    cuts = [Cutaway(it) for it in sorted(r.get("cutaways", []), key=lambda c: c["t0"])
            if it.get("img") and Path(it["img"]).exists()]
    shots = build_shots(cuts, dur)
    cutpts = [sh[1] for sh in shots[:-1]]
    exp = projects.exports_dir(p["id"])
    name = f"{rid.split('~')[1]}-{projects.slug(r.get('title') or 'reel')}"
    out = exp / f"{name}.mp4"
    fdir = Path(fontsd).resolve()
    try:
        fdir_arg = Path(fdir).relative_to(d.resolve())
        fdir_s = str(fdir_arg).replace("\\", "/")
    except ValueError:
        import os
        fdir_s = os.path.relpath(fdir, d).replace("\\", "/") if fdir.drive.lower() == d.resolve().drive.lower() \
            else ff.filter_path(fdir)
    vf = (f"[0:v][2:v]overlay=0:0:shortest=1[sh];[sh]ass=caps.ass:fontsdir='{fdir_s}',"
          f"fade=in:st=0:d=0.4,fade=out:st={max(dur - 0.5, 0):.2f}:d=0.5[v]")
    tmp_out = d / "final.tmp.mp4"
    enc = job.popen([ff.ffmpeg(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                     "-s", f"{preset['width']}x{preset['height']}", "-r", str(FPS), "-i", "-",
                     "-i", str(mix), "-loop", "1", "-i", str(shade), "-filter_complex", vf,
                     "-map", "[v]", "-map", "1:a", "-t", f"{dur:.3f}",
                     "-c:v", "libx264", "-crf", str(preset.get("crf", 18)), "-preset", "medium", "-pix_fmt", "yuv420p",
                     "-c:a", "aac", "-b:a", f"{preset.get('audio_kbps', 192)}k", "-ar", "48000",
                     "-movflags", "+faststart", str(tmp_out)],
                    stdin=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(d))
    dec = job.popen([ff.ffmpeg(), "-nostdin", "-loglevel", "error", "-i", str(base), "-f", "rawvideo",
                     "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    import threading
    errbuf: list[bytes] = []
    th = threading.Thread(target=lambda: errbuf.append(enc.stderr.read()), daemon=True)
    th.start()

    def shot_at(t):
        for s0, s1, srcc in shots:
            if s0 <= t < s1:
                return srcc
        return shots[-1][2]

    n, i, total = 1080 * 1920 * 3, 0, max(int(dur * FPS), 1)
    try:
        while True:
            b = dec.stdout.read(n)
            if len(b) < n:
                break
            t = i / FPS
            spk = np.frombuffer(b, np.uint8).reshape(1920, 1080, 3)
            c = next((c for c in cutpts if abs(t - c) < TRANS / 2), None)
            if c is None:
                s = shot_at(t)
                f = spk if s is None else s.frame(t)
            else:
                u = ease((t - (c - TRANS / 2)) / TRANS)
                sa, sb = shot_at(c - 1e-3), shot_at(c + 1e-3)
                A = spk if sa is None else sa.frame(t)
                B = spk if sb is None else sb.frame(t)
                A = zoom_blur(A, 1 + ZOOM * u, BLUR * u)
                B = zoom_blur(B, 1 + ZOOM * (1 - u), BLUR * (1 - u))
                f = cv2.addWeighted(A, 1 - u, B, u, 0)
            try:
                enc.stdin.write(np.ascontiguousarray(f).tobytes())
            except (BrokenPipeError, OSError):
                break
            i += 1
            if i % FPS == 0:
                job.check()
                job.update(min(i / total, 1), "rendering final")
        try:
            enc.stdin.close()
        except OSError:
            pass
        enc.wait()
        dec.wait()
        th.join(5)
    finally:
        job.release(enc)
        job.release(dec)
    job.check()
    if enc.returncode != 0:
        raise JobError("final render failed: " + b"".join(errbuf).decode("utf-8", "replace")[-1500:])
    qc = measure(str(tmp_out), job)
    tp_max = preset.get("true_peak", -1.5)
    g = tp_guard_gain(qc.get("true_peak"), tp_max)
    if g is not None:
        # AAC overshoot pushed the true peak over the limit: pull the audio down and re-encode it (video copied)
        job.update(0.99, f"true peak {qc['true_peak']} dBTP > {tp_max}: audio {g:+.1f} dB")
        fixed = d / "final.tpfix.mp4"
        ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(tmp_out), "-i", str(mix),
                "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", f"volume={g:.2f}dB", "-c:a", "aac",
                "-b:a", f"{preset.get('audio_kbps', 192)}k", "-ar", "48000", "-t", f"{dur:.3f}",
                "-movflags", "+faststart", str(fixed)], job=job)
        fixed.replace(tmp_out)
        qc = measure(str(tmp_out), job) | {"tp_fix_db": round(g, 2)}
    shutil.move(str(tmp_out), str(out))
    thumb = exp / f"{name}.jpg"
    try:
        from . import thumbs
        tinfo = thumbs.make(rid, job, out=thumb)
    except Exception as e:  # noqa: BLE001 - a thumbnail must never fail the render
        make_thumbnail(str(out), r, thumb, job)
        tinfo = {"renderer": "frame", "error": str(e)[:300]}
    from ..brain import cutaways as cutplan
    qc["cutaway_coverage"] = cutplan.coverage(r.get("cutaways", []), dur, filled_only=True)
    qc["cutaway_needs"] = sum(1 for c in r.get("cutaways", []) if c.get("need") and not c.get("img"))

    def upd(rr):
        rr["status"] = "rendered"
        ex = [e for e in rr.get("exports", []) if e.get("path") != str(out)]
        rr["exports"] = ex + [{"path": str(out), "thumbnail": str(thumb), **qc}]
    _save_reel(rid, upd)
    return {"path": str(out), "thumbnail": str(thumb), "frames": i, **qc, "mix": mix_info,
            "thumbnail_info": {k: v for k, v in tinfo.items() if k in ("style", "pose_t", "renderer", "error")}}


def make_thumbnail(video: str, r: dict, out: Path, job: Job):
    """Fallback thumbnail (when the designer in thumbs.py fails): a frame at pose_t of the rendered reel."""
    t = (r.get("thumbnail") or {}).get("pose_t")
    if t is None:
        t = min(max(4.5, float(r["duration"]) / 3), float(r["duration"]) - 0.1)
    ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
            "-q:v", "3", str(out)], job=job)


def measure(video: str, job: Job) -> dict:
    """QC: size, duration, integrated loudness + true peak (ebur128)."""
    info = ff.probe(video)
    cp = ff.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", video, "-af", "ebur128=peak=true", "-f", "null", "-"],
                job=job)
    err = cp.stderr.decode("utf-8", "replace")
    tail = err[err.rfind("Summary:"):]
    import re
    I = re.search(r"I:\s+(-?[\d.]+) LUFS", tail)
    P = re.search(r"Peak:\s+(-?[\d.]+|-inf) dBFS", tail)
    return {"width": info["width"], "height": info["height"], "duration": round(info["duration"], 3),
            "lufs": float(I.group(1)) if I else None, "true_peak": float(P.group(1)) if P and P.group(1) != "-inf" else None}
