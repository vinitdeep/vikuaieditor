"""Hook writer: a short title (<= 6 words, "!" / "?") and a sub line for a reel, offline.

    hook(lines, lang, verses=None) -> {"title", "sub", "theme", "tags", "why"}

lines = the reel's caption / transcript texts in play order ([{"text", "conf"?, "flags"?}] or plain strings).
Every 2-6 word span of every line is a candidate. Score (all lexicons are plain JSON: lexicon.json + hooks.json):
  + victory 1.2, hope 0.8, strong words (God / Jesus / "never" / "can" ...) 0.6 (each count capped at 2),
    direct address 0.8, theme words 0.6
  + question (question word in the span) 1.5 -> ends with "?"
  + span ends where the line ends or before a conjunction (Odia / Hindi put the verb last: a finished thought) 1.2,
    the whole line 0.5; a span cut mid-clause -0.8
  + the closing line 0.8 (house rule: reels end on the encouraging line), the hook line (first 4 s) 0.3
  + e5 "sounds like reels editors kept" (similarity_to_favourites, z-scored over the reel's lines) x0.5
  + length prior: 3-5 words 0.5
  - starts / ends on a conjunction or postposition 2, filler / call-and-response 2, admin notice 3, death / hell words 1,
    digits / verse announcements 1.5, Latin words inside Odia / Hindi 0.5 each, caption flags 1, ASR conf < 0.6 1
Sub: the verse card's English reference when the reel has one ("<gist> · John 15:5"), else the theme gist.
"""
from __future__ import annotations

import functools
import json
import re
from pathlib import Path

import numpy as np

from . import text as T

HERE = Path(__file__).parent


@functools.lru_cache(maxsize=1)
def data() -> dict:
    return json.loads((HERE / "hooks.json").read_text(encoding="utf-8"))


def _words(group: str, lang: str) -> list[str]:
    g = data()[group]
    return g.get(lang, []) + (g.get("en", []) if lang != "en" else [])


def _lang(lang: str) -> str:
    return lang if lang in ("or", "hi", "en") else "or"


def _is(word: str, group: str, lang: str) -> bool:
    w = T.norm(word).strip(".,!?।'\"")
    return any(w == T.norm(x) for x in _words(group, lang))


def theme(text: str, lang: str) -> dict | None:
    lang = _lang(lang)
    best, bn = None, 0
    for th in data()["themes"]:
        n = T.count_hits(text, th.get(lang, []) + th.get("en", []))
        if n > bn:
            best, bn = th, n
    return best


def _fav_z(texts: list[str]) -> list[float]:
    try:
        from . import embed
        if not embed.available() or len(texts) < 2:
            return [0.0] * len(texts)
        v = np.array([embed.similarity_to_favourites(t) for t in texts], np.float32)
        sd = float(v.std())
        return [0.0] * len(texts) if sd < 1e-6 else list(((v - v.mean()) / sd).clip(-2, 2))
    except Exception:  # noqa: BLE001
        return [0.0] * len(texts)


def _score_span(ws: list[str], lang: str, line_end: bool, whole: bool) -> tuple[float, dict]:
    s = " ".join(ws)
    why = {}
    f = {"victory": 1.2 * min(T.lex_hits(s, "victory", lang), 2), "hope": 0.8 * min(T.lex_hits(s, "hope_end", lang), 2),
         "strong": 0.6 * min(T.count_hits(s, _words("strong", lang)), 2),
         "address": 0.8 * min(T.lex_hits(s, "direct_address", lang), 1)}
    th = theme(s, lang)
    f["theme"] = 0.6 if th else 0.0
    q = T.count_hits(s, _words("question", lang)) > 0
    f["question"] = 1.5 if q else 0.0
    f["finished"] = (1.2 if line_end else 0.0) + (0.5 if whole else 0.0)
    f["length"] = 0.5 if 3 <= len(ws) <= 5 else 0.0
    pen = 0.0
    if _is(ws[0], "dangling_start", lang):
        pen += 2.0
    if _is(ws[-1], "dangling_end", lang) and not q:
        pen += 2.0
    if any(_is(w, "fillers", lang) for w in ws) or T.lex_hits(s, "call_response", lang):
        pen += 2.0
    if T.lex_hits(s, "admin_notice", lang):
        pen += 3.0
    if T.lex_hits(s, "negative_end", lang):
        pen += 1.0
    if re.search(r"\d", s) or T.lex_hits(s, "scripture", lang):
        pen += 1.5
    if lang != "en":
        pen += 0.5 * len([w for w in ws if re.fullmatch(r"[A-Za-z']+", w)])
    if len(set(ws)) < len(ws):  # "नहीं हो सकता नहीं हो सकता"
        pen += 1.0
    sc = sum(f.values()) - pen
    why = {k: round(v, 2) for k, v in f.items() if v} | ({"penalty": round(-pen, 2)} if pen else {})
    return sc, why | {"question": q, "lexical": f["victory"] + f["hope"] + f["strong"] > 0}


def hook(lines: list, lang: str, verses: list | None = None, t_lines: list | None = None) -> dict:
    """lines: [str | {"text", "conf", "flags", "t0"}]. -> {"title", "sub", "theme", "tags", "why"}"""
    lang = _lang(lang)
    items = [{"text": x} if isinstance(x, str) else dict(x) for x in lines]
    items = [it for it in items if (it.get("text") or "").strip()]
    if not items:
        return {"title": "", "sub": "", "theme": None, "tags": [], "why": {}}
    fav = _fav_z([it["text"] for it in items])
    best = (-1e9, None, None, None)
    n = len(items)
    for li, it in enumerate(items):
        ws = [w for w in re.split(r"\s+", it["text"].strip()) if w and not re.fullmatch(r"[\W_]+", w)]
        if not ws:
            continue
        line_bonus = 0.0
        if li == n - 1:
            line_bonus += 0.8
        if (it.get("t0") is not None and it["t0"] < 4.0) or li == 0:
            line_bonus += 0.3
        line_bonus += 0.5 * fav[li]
        if (it.get("conf") is not None) and float(it["conf"] or 0) < 0.6:
            line_bonus -= 1.0
        if it.get("flags"):
            line_bonus -= 1.0
        L = len(ws)
        for a in range(L):
            for b in range(a + 2, min(L, a + 6) + 1):
                # a clause ends at the line end or before a conjunction ("... କରିଥିଲା | କିନ୍ତୁ"); elsewhere it is cut
                end = b == L or _is(ws[b], "dangling_start", lang)
                sc, why = _score_span(ws[a:b], lang, line_end=end, whole=(a == 0 and b == L))
                if not end:
                    sc -= 0.8
                sc += line_bonus
                if sc > best[0]:
                    best = (sc, ws[a:b], why, li)
        if L == 1:
            sc, why = _score_span(ws, lang, True, True)
            if sc + line_bonus - 1.0 > best[0]:
                best = (sc + line_bonus - 1.0, ws, why, li)
    sc, ws, why, li = best
    title = re.sub(r"[\s.,;:।…!?]+$", "", " ".join(ws or []))
    if why and why.get("question"):
        title += "?"
    elif why and why.get("lexical"):
        title += "!"
    th = theme(" ".join(it["text"] for it in items), lang)
    gist = th["gist"] if th else ""
    ref = ""
    for v in verses or []:
        r = v.get("ref") or ""
        ref = r.split("·")[-1].strip() if "·" in r else r
        if ref:
            break
    sub = " · ".join(x for x in (gist, ref) if x)
    return {"title": title, "sub": sub, "theme": th["id"] if th else None, "tags": th["tags"] if th else [],
            "why": {"score": round(sc, 2), "line": li,
                    **{k: v for k, v in (why or {}).items() if k not in ("question", "lexical")}}}
