"""New AI pictures for a reel's cutaways, made automatically while the reel is built.

Provider: a Cloudflare Worker running Workers AI (free tier), the same one any church can deploy from
`tools/cloudflare-worker/` (see its README):
  POST {url}/text  {messages, model}             -> {"response": "..."}   (sermon line -> English scene)
  POST {url}/      {prompt, model, steps, ...}    -> image bytes            (scene -> picture)
Settings: `ai_pictures` {url, image_model, text_model, every_reel}; the key is stored DPAPI-encrypted
(`ai_pictures_key_dpapi`, POST /settings {"ai_pictures_key": "..."}).

Per cutaway: the sermon line it covers (+ the lines around it) -> an English picture description (the image models only
read English; the line may be Odia / Hindi and machine-transcribed) -> a picture -> imported into the library (tags,
desc = the scene) -> the cutaway points at it (`ai` records the scene and model). A cutaway whose picture cannot be
made keeps its `need`, so the editor can still fill it (AI Studio / library).
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import config, library, projects
from .jobs import Job

UA = "Viku/0.1 (sermon reel studio)"   # Cloudflare's bot filter refuses Python's default user agent (403)
LANG_NAME = {"or": "Odia", "hi": "Hindi", "en": "English"}
SCENE_SYSTEM = (
    "You write picture descriptions for an AI image generator that illustrates short Christian sermon reels for Indian "
    "churches. You get one line of a sermon in {lang} (machine-transcribed, may contain errors), the lines around it "
    "and the reel's title. Understand what the line means and describe ONE concrete, respectful, photographable scene "
    "that shows that meaning: who is in it (Indian people, everyday Indian places), what they are doing, the light "
    "and the mood. Show the meaning as a moment from life (work, family, a journey, a struggle, help, joy, nature) - "
    "do NOT default to someone praying or crying in a church. This is a Christian reel: if a place of worship appears "
    "it is a simple Indian church; never a temple, mosque, idol, bindi, tilak or other faiths' symbols. No text, "
    "signs, letters or logos. No face of Jesus, no gore. The reel already has the scenes listed under 'Already used': "
    "yours must differ from all of them in people, place and action. Answer with the English scene only: one or two "
    "sentences, at most 60 words.")
STYLE = ("Vertical portrait composition, main subject centred. Photorealistic cinematic still, India, Indian Christian "
         "people, women with a clean bare forehead and modest clothes, {grade}, shallow depth of field, soft film grain, "
         "no text, no letters, no watermark. ")
# SDXL (default) honours a negative prompt - Flux has none and paints a bindi on most Indian women regardless of wording
SDXL_NEG = ("bindi, red dot on forehead, tilak, sindoor, forehead mark, temple, idol, text, words, letters, watermark, "
            "logo, deformed hands, extra fingers, blurry, cartoon")


class NotSetUp(Exception):
    pass


def cfg() -> dict:
    s = config.settings()
    c = dict(s.get("ai_pictures") or {})
    c["key"] = config.ai_pictures_key()
    return c


def ready() -> bool:
    c = cfg()
    return bool(c.get("url") and c.get("key"))


def every_reel() -> bool:
    """New AI pictures for every reel (default) once a generator is set up."""
    return ready() and bool(cfg().get("every_reel", True))


def _post(path: str, body: dict, timeout: float) -> tuple[bytes, str]:
    c = cfg()
    if not (c.get("url") and c.get("key")):
        raise NotSetUp("AI pictures are not set up (Settings -> AI pictures)")
    req = urllib.request.Request(c["url"].rstrip("/") + path, data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {c['key']}", "Content-Type": "application/json",
                                          "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        detail = e.read()[:300].decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {e.code} from the AI picture service: {detail}") from e


def scene(line: str, lang: str, around: str = "", title: str = "", used: list[str] | None = None) -> str:
    """Sermon line (any language) -> one English picture description, different from the reel's `used` scenes."""
    done = "; ".join(used or []) or "nothing yet"
    body = {"model": cfg().get("text_model") or "llama", "max_tokens": 160, "messages": [
        {"role": "system", "content": SCENE_SYSTEM.format(lang=LANG_NAME.get(lang, lang))},
        {"role": "user", "content": f"Reel title: {title}\nLines around it: {around}\nThe line: {line}\n"
                                    f"Already used: {done}"}]}
    raw, _ = _post("/text", body, 60)
    text = (json.loads(raw).get("response") or "").strip().strip('"').strip()
    text = re.sub(r"^(scene|description)\s*:\s*", "", text, flags=re.I)
    if len(text) < 12:
        raise RuntimeError("the text model gave no scene")
    return text[:500]


def picture(prompt: str, out: Path) -> tuple[Path, str]:
    """Prompt -> image file (SDXL 768x1344 by default; Flux 1024x1024 when it fails). -> (path, model)."""
    first = cfg().get("image_model") or "sdxl"
    tries = [first] + [m for m in ("sdxl", "flux") if m != first]
    err: Exception | None = None
    for m in tries:
        body = {"prompt": prompt, "model": m}
        body |= {"steps": 6} if m == "flux" else {"width": 768, "height": 1344, "steps": 20, "negative_prompt": SDXL_NEG}
        try:
            data, ctype = _post("/", body, 120)
        except Exception as e:  # noqa: BLE001 - try the next model
            err = e
            continue
        if len(data) < 2000 or not (data[:2] == b"\xff\xd8" or data[:4] == b"\x89PNG"):
            err = RuntimeError(f"{m}: not an image ({data[:120]!r})")
            continue
        p = out.with_suffix(".png" if data[:4] == b"\x89PNG" else ".jpg")
        p.write_bytes(data)
        return p, m
    raise err or RuntimeError("no picture")


def _around(captions: list[dict], t0: float, t1: float, pad: float = 6.0) -> str:
    return " ".join(c["text"] for c in captions if c["t1"] > t0 - pad and c["t0"] < t1 + pad and c.get("text"))[:600]


def _nearest(captions: list[dict], t: float) -> str:
    cs = [c for c in captions if c.get("text")]
    return min(cs, key=lambda c: abs((c["t0"] + c["t1"]) / 2 - t))["text"] if cs else ""


def fill(rid: str, job: Job | None = None, replace: bool = False) -> dict:
    """Make a new AI picture for every cutaway that needs one (replace=True: every cutaway, library pictures
    included). -> {"made", "failed", "errors"}. Saves the reel after each picture, so a stop keeps what was made."""
    if not ready():
        raise NotSetUp("AI pictures are not set up (Settings -> AI pictures)")
    p, r = projects.find_reel(rid)
    todo = [i for i, c in enumerate(r.get("cutaways", [])) if replace or not c.get("img") or c.get("need")]
    out_dir = projects.reel_dir(rid) / "ai"
    out_dir.mkdir(parents=True, exist_ok=True)
    setname = f"{p['name']} reel {rid.split('~')[1]} (AI)"
    made, errors = 0, []
    # scenes this reel already shows (pictures it keeps), so every new one is different
    used = [c["ai"]["scene"] for j, c in enumerate(r.get("cutaways", []))
            if j not in todo and (c.get("ai") or {}).get("scene")]
    for k, i in enumerate(todo):
        if job:
            job.check()
            job.update(k / max(len(todo), 1), f"AI pictures: {k + 1} of {len(todo)}")
        p, r = projects.find_reel(rid)
        if i >= len(r.get("cutaways", [])):
            continue
        c = r["cutaways"][i]
        need = c.get("need") or c.get("need_done") or {}
        # older reels have no line on the cutaway: take the captions spoken under it (else the nearest one)
        line = (need.get("text") or c.get("text") or _around(r.get("captions", []), c["t0"], c["t1"], 0.0)
                or _nearest(r.get("captions", []), (c["t0"] + c["t1"]) / 2)).strip()
        if not line:
            errors.append(f"cutaway {i + 1}: no sermon line")
            continue
        try:
            sc = scene(line, r.get("language", "or"), _around(r.get("captions", []), c["t0"], c["t1"]), r.get("title", ""),
                       used[-8:])
            grade = need.get("grade") or "soft natural daylight grade"
            f, model = picture(STYLE.format(grade=grade) + sc, out_dir / f"{i + 1:02d}-{int(time.time())}")
            words = [w for w in re.findall(r"[a-z]{4,}", sc.lower())][:8]
            res = library.import_paths([str(f)], list(dict.fromkeys((need.get("tags") or []) + words)),
                                       desc=sc[:400], setname=setname)
            lid = res["ids"][0] if res.get("ids") else None
            item = next((it for it in library.items() if it["id"] == lid), None)
            if not item:
                raise RuntimeError("library import failed")
        except Exception as e:  # noqa: BLE001 - keep going: one failed picture must not stop the reel
            errors.append(f"cutaway {i + 1}: {str(e)[:200]}")
            continue

        def upd(rr, i=i, item=item, sc=sc, model=model):
            cc = rr["cutaways"][i]
            cc["img"], cc["lib_id"] = item["path"], item["id"]
            cc["ai"] = {"scene": sc, "model": model, "made": time.strftime("%Y-%m-%dT%H:%M:%S")}
            if cc.get("need"):
                cc["need_done"] = cc.pop("need")
        _save(rid, upd)
        used.append(sc)
        made += 1
    if job:
        job.update(1.0, f"AI pictures: {made} made" + (f", {len(errors)} failed" if errors else ""))
    return {"made": made, "failed": len(errors), "errors": errors[:8]}


def _save(rid: str, fn):
    pid = rid.split("~", 1)[0]

    def upd(p):
        for rr in p["reels"]:
            if rr["id"] == rid:
                fn(rr)
                return
        raise projects.NotFound(rid)
    projects.update(pid, upd)
