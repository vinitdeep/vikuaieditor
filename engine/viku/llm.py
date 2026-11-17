"""Optional local LLM (Ollama, http://127.0.0.1:11434) for reel titles / descriptions / hashtags. Never required.

    status() -> {"ollama": bool, "url", "models": [...], "model": chosen | None}
    describe(rid, use_llm=False) -> {"title", "sub", "description", "hashtags", "source": "heuristic"|"ollama:<model>",
                                     "llm_error"?}

Without Ollama (or use_llm false) the draft is offline: hook title (brain/hooks.py), sub = theme gist / verse ref,
description = the reel's strongest lines + verse + credit line, hashtags = theme tags + language + church.
The draft is stored on the reel as `describe` (the editor copies what they like into the title / sub fields).
"""
from __future__ import annotations

import json
import re
import time
import urllib.request

from . import config, projects

_status: tuple[float, dict] | None = None
PREFER = ("qwen", "llama3", "gemma", "mistral", "phi")
LANG_NAME = {"or": "Odia", "hi": "Hindi", "en": "English"}


def base_url() -> str:
    return (config.settings().get("ollama_url") or "http://127.0.0.1:11434").rstrip("/")


def status(force: bool = False) -> dict:
    global _status
    if _status and not force and time.time() - _status[0] < 30:
        return _status[1]
    st = {"ollama": False, "url": base_url(), "models": [], "model": None}
    try:
        with urllib.request.urlopen(base_url() + "/api/tags", timeout=0.6) as r:
            names = [m["name"] for m in json.loads(r.read()).get("models", [])]
        st["ollama"] = True
        st["models"] = names
        want = config.settings().get("ollama_model")
        st["model"] = want if want in names else next(
            (n for p in PREFER for n in names if n.lower().startswith(p)), names[0] if names else None)
    except Exception:  # noqa: BLE001
        pass
    _status = (time.time(), st)
    return st


def _heuristic(r: dict) -> dict:
    from .brain import hooks
    lang = r.get("language", "or")
    caps = r.get("captions") or []
    hk = hooks.hook(caps, lang, r.get("verses"))
    title = r.get("title") or hk["title"]
    sub = r.get("sub") or hk["sub"]
    verse = ""
    for v in r.get("verses") or []:
        verse = f"\"{v.get('text', '').strip()}\" - {v.get('ref', '')}".strip()
        break
    body = " ".join(c["text"] for c in caps[-3:]) if caps else ""
    st = config.settings()
    credit = st.get("credit_line") or st.get("church_name") or ""
    desc = "\n\n".join(x for x in (title, body, verse, credit) if x)
    tags = ["#" + t for t in hk.get("tags", [])]
    tags += {"or": ["#Odia", "#OdiaSermon", "#OdiaChristian"], "hi": ["#Hindi", "#HindiSermon", "#HindiChristian"],
             "en": ["#Sermon"]}.get(lang, [])
    tags += ["#Jesus", "#Faith", "#Shorts"]
    church = re.sub(r"[^\w]", "", st.get("church_name") or "")
    if church:
        tags.append("#" + church)
    return {"title": title, "sub": sub, "description": desc, "hashtags": list(dict.fromkeys(tags))[:12],
            "source": "heuristic"}


def _ollama(r: dict, draft: dict, model: str) -> dict:
    lang = LANG_NAME.get(r.get("language", "or"), "Odia")
    text = "\n".join(c["text"] for c in r.get("captions") or [])
    verses = "; ".join(v.get("ref", "") for v in r.get("verses") or [])
    prompt = (f"You write social media copy for a church's short sermon reel. The reel is in {lang}.\n"
              f"Transcript (automatic captions, may contain recognition errors):\n{text}\n"
              f"Bible verse shown: {verses or 'none'}\n\n"
              f"Return JSON with keys: title (a hook in {lang} script, at most 6 words, ending with ! or ?), "
              f"sub (one short English line), description (2-3 sentences in {lang} then one English sentence), "
              f"hashtags (8 hashtags, mix of {lang} and English). Be faithful to what the preacher says; "
              f"no invented claims. Draft hook for reference: {draft['title']}")
    req = urllib.request.Request(base_url() + "/api/generate", method="POST",
                                 data=json.dumps({"model": model, "prompt": prompt, "format": "json", "stream": False,
                                                  "options": {"temperature": 0.4}}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        out = json.loads(json.loads(resp.read())["response"])
    tags = out.get("hashtags") or []
    if isinstance(tags, str):
        tags = tags.split()
    return {"title": str(out.get("title") or draft["title"]).strip(), "sub": str(out.get("sub") or draft["sub"]).strip(),
            "description": str(out.get("description") or draft["description"]).strip(),
            "hashtags": ["#" + str(t).lstrip("#").replace(" ", "") for t in tags][:12] or draft["hashtags"],
            "source": f"ollama:{model}"}


def describe(rid: str, use_llm: bool = False) -> dict:
    _, r = projects.find_reel(rid)
    res = _heuristic(r)
    if use_llm:
        st = status(force=True)
        if st["ollama"] and st["model"]:
            try:
                res = _ollama(r, res, st["model"])
            except Exception as e:  # noqa: BLE001
                res["llm_error"] = f"{type(e).__name__}: {e}"
        else:
            res["llm_error"] = "Ollama is not running on this PC (optional) - showing the offline draft"
    pid = rid.split("~")[0]

    def upd(p):
        for rr in p["reels"]:
            if rr["id"] == rid:
                rr["describe"] = res
    projects.update(pid, upd)
    return res
