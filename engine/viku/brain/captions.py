"""Caption fixer: dictionary + learned correction memory + RNNT/CTC disagreement flags.

fix(text, lang, alt=None) -> {"text", "flags": [{"start","end","reason","suggest"}]}  (char offsets in text)
  1. dictionary.json  safe spelling fixes of church vocabulary the ASR gets wrong (applied)
  2. correction memory  before->after word pairs learned from editor caption edits (applied when seen again)
  3. flags  - "rnnt_ctc_disagree": the CTC decode of the same audio differs (suggest = CTC words)
           - "near_vocab": a word is one edit away from a Bible/church vocabulary word (suggest it)
           - "corrected": something was changed by 1/2, so the editor can review it
Captions stay verbatim otherwise - the preacher's words are never "corrected".
"""
from __future__ import annotations

import difflib
import json
import re
import threading
from pathlib import Path

from .. import config
from . import text as T

HERE = Path(__file__).parent
_lock = threading.Lock()


SEED = HERE.parents[2] / "data" / "brain_seed" / "caption_corrections.jsonl"  # repo seed (see its README)


def _dict() -> dict:
    """dictionary.json + the brain_seed corrections: safe pairs become fixes, unsafe ones (the wrong form is
    also a real word, e.g. में->मैं) only suggestions."""
    d = json.loads((HERE / "dictionary.json").read_text(encoding="utf-8"))
    d.setdefault("suggest", {})
    if SEED.exists():
        for line in SEED.read_text(encoding="utf-8").splitlines():
            try:
                c = json.loads(line)
            except json.JSONDecodeError:
                continue
            L, w, r = c.get("lang"), c.get("wrong"), c.get("right")
            if not (L and w and r):
                continue
            if c.get("safe"):
                d.setdefault("fixes", {}).setdefault(L, {}).setdefault(w, r)
            else:
                d["suggest"].setdefault(L, {})[w] = r
    return d


def memory_path() -> Path:
    d = config.sub("models") / "brain"
    d.mkdir(parents=True, exist_ok=True)
    return d / "corrections.json"


def memory() -> dict:
    f = memory_path()
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def learn_edit(before: str, after: str, lang: str) -> list[tuple[str, str]]:
    """Store word-level replacements from one caption edit."""
    a, b = (before or "").split(), (after or "").split()
    pairs = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if op == "replace" and (i2 - i1) <= 3 and (j2 - j1) <= 3:
            pairs.append((" ".join(a[i1:i2]), " ".join(b[j1:j2])))
    if pairs:
        with _lock:
            m = memory()
            L = m.setdefault(lang, {})
            for x, y in pairs:
                L.setdefault(x, {})
                L[x][y] = L[x].get(y, 0) + 1
            memory_path().write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    return pairs


def rebuild_memory(edits: list[dict]) -> int:
    with _lock:
        memory_path().write_text("{}", encoding="utf-8")
    n = 0
    for e in edits:
        n += len(learn_edit(e.get("before", ""), e.get("after", ""), e.get("lang", "or")))
    return n


def _replace_words(text: str, table: dict[str, str]) -> tuple[str, list[tuple[int, int, str]]]:
    """Whole-word / phrase replacement; returns new text + spans (in new text) that changed."""
    changed = []
    for src in sorted(table, key=len, reverse=True):
        dst = table[src]
        pat = re.compile(r"(?<![\w଀-୿ऀ-ॿ])" + re.escape(src) + r"(?![\w଀-୿ऀ-ॿ])")
        out, pos, spans = [], 0, []
        for m in pat.finditer(text):
            out.append(text[pos:m.start()])
            st = sum(len(x) for x in out)
            out.append(dst)
            spans.append((st, st + len(dst), src))
            pos = m.end()
        if spans:
            out.append(text[pos:])
            text = "".join(out)
            changed += spans
    return text, changed


def _word_spans(text: str) -> list[tuple[int, int, str]]:
    return [(m.start(), m.end(), m.group(0)) for m in re.finditer(r"\S+", text)]


def _near(w: str, vocab: list[str]) -> str | None:
    if len(w) < 4:  # short words (ଆମେ "we" vs ଆମେନ "amen") are too ambiguous
        return None
    best = difflib.get_close_matches(w, vocab, n=1, cutoff=0.85)
    return best[0] if best and best[0] != w else None


def fix(text: str, lang: str, alt: str | None = None) -> dict:
    d = _dict()
    table = dict(d.get("fixes", {}).get(lang, {}))
    mem = memory().get(lang, {})
    for before, afters in mem.items():
        table[before] = max(afters, key=afters.get)
    new, changed = _replace_words(text or "", table)
    flags = [{"start": a, "end": b, "reason": "corrected", "suggest": src} for a, b, src in changed]
    words = _word_spans(new)
    # RNNT vs CTC disagreement
    if alt and alt.strip() and alt.strip() != (text or "").strip():
        A = [w for _, _, w in words]
        B = alt.split()
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=[T.norm(x) for x in A], b=[T.norm(x) for x in B],
                                                          autojunk=False).get_opcodes():
            if op == "equal":
                continue
            if i2 > i1:
                s, e = words[i1][0], words[i2 - 1][1]
            else:
                s = words[i1][0] if i1 < len(words) else len(new)
                e = s
            flags.append({"start": s, "end": e, "reason": "rnnt_ctc_disagree", "suggest": " ".join(B[j1:j2])})
    sug = d.get("suggest", {}).get(lang, {})
    for s, e, w in words:
        if w in sug and not any(f["start"] <= s < f["end"] for f in flags):
            flags.append({"start": s, "end": e, "reason": "seed_suggest", "suggest": sug[w]})
    vocab = d.get("vocab", {}).get(lang, [])
    if vocab:
        nv = [T.norm(v) for v in vocab]
        for s, e, w in words:
            m = _near(T.norm(w), nv)
            if m and not any(f["start"] <= s < f["end"] for f in flags):
                flags.append({"start": s, "end": e, "reason": "near_vocab", "suggest": vocab[nv.index(m)]})
    flags.sort(key=lambda f: (f["start"], f["end"]))
    return {"text": new, "flags": flags}
