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


@functools.lru_cache(maxsize=256)
def _norm_words(words: tuple[str, ...]) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    """-> (phrases, short exact words, prefix words), normalised once."""
    ws = [norm(w) for w in words if w and norm(w)]
    return (tuple(w for w in ws if " " in w), tuple(w for w in ws if " " not in w and len(w) <= 2),
            tuple(w for w in ws if " " not in w and len(w) > 2))


def count_hits(text: str, words: list[str]) -> int:
    phr, short, pre = _norm_words(tuple(words))
    t = norm(text)
    toks = tokens(text)
    n = sum(t.count(w) for w in phr)
    n += sum(1 for k in toks if k in short)
    for k in toks:
        n += sum(1 for w in pre if k.startswith(w))
    return n


@functools.lru_cache(maxsize=1)
def _lex_words() -> dict:
    out = {}
    for group, lx in lexicon().items():
        if not isinstance(lx, dict):
            continue
        for lang in ("or", "hi", "en"):
            langs = [lang] if lang in lx else list(lx)
            words = [w for L in langs for w in lx.get(L, [])]
            if lang != "en":
                words += lx.get("en", [])  # sermons code-switch: English loanwords always count
            out[(group, lang)] = tuple(dict.fromkeys(words))
    return out


@functools.lru_cache(maxsize=200000)
def lex_hits(text: str, group: str, lang: str) -> int:
    words = _lex_words().get((group, lang if lang in ("or", "hi", "en") else "or"), ())
    return count_hits(text, list(words)) if words else 0


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
