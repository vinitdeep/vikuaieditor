"""Text helpers shared by the brain: normalisation, tokens, lexicon matching, script detection."""
from __future__ import annotations

import functools
import json
import re
import unicodedata
from pathlib import Path

HERE = Path(__file__).parent

# Odia has two code points for "va" (U+0B35 / U+0B71) and nukta variants; ASR + IRV mix them.
_MAP = str.maketrans({"ଵ": "ୱ", "‌": None, "‍": None, "ଡ଼": "ଡ଼",
                      "ଢ଼": "ଢ଼", "क़": "क़", "ड़": "ड़"})


def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s or "").translate(_MAP).lower()
    return re.sub(r"\s+", " ", s).strip()


def tokens(s: str) -> list[str]:
    return [t for t in re.split(r"[^\w଀-୿ऀ-ॿ]+", norm(s)) if t]


@functools.lru_cache(maxsize=1)
def lexicon() -> dict:
    return json.loads((HERE / "lexicon.json").read_text(encoding="utf-8"))


@functools.lru_cache(maxsize=1)
def concepts() -> list[dict]:
    return json.loads((HERE / "concepts.json").read_text(encoding="utf-8"))["concepts"]


def count_hits(text: str, words: list[str]) -> int:
    t = norm(text)
    toks = tokens(text)
    n = 0
    for w in words:
        w = norm(w)
        if " " in w:
            n += t.count(w)
        elif len(w) <= 2:
            n += sum(1 for k in toks if k == w)
        else:
            n += sum(1 for k in toks if k.startswith(w))
    return n


def lex_hits(text: str, group: str, lang: str) -> int:
    lx = lexicon().get(group, {})
    langs = [lang] if lang in lx else list(lx)
    words = [w for L in langs for w in lx.get(L, [])]
    # sermons code-switch: always also try English loanwords
    if lang != "en":
        words += lx.get("en", [])
    return count_hits(text, words)


def script_of(text: str) -> str:
    o = len(re.findall(r"[଀-୿]", text or ""))
    d = len(re.findall(r"[ऀ-ॿ]", text or ""))
    l_ = len(re.findall(r"[A-Za-z]", text or ""))
    best = max((o, "or"), (d, "hi"), (l_, "en"))
    return best[1] if best[0] else "en"


def letters(text: str) -> int:
    return len(re.findall(r"[\w଀-୿ऀ-ॿ]", text or ""))


def short_title(text: str, n: int = 38) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    if len(t) <= n:
        return t
    cut = t[:n].rsplit(" ", 1)[0]
    return (cut or t[:n]) + "…"
