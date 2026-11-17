"""Verse detection + scripture-card placement.

Two detectors, both on the reel's captions (reel seconds):
- explicit: find_refs(text) - a book name (English or native, from the offline Bible) followed within ~30 chars by
  chapter and verse numbers (ASCII / Odia / Devanagari digits; "ଅଧ୍ୟାୟ", "ପଦ", "अध्याय", "पद", "chapter", "verse" may
  sit between them).
- semantic: windows of 1-3 consecutive captions are embedded (e5, "query: ") and compared with every verse of the
  reel's translation (bible.<code>.emb.npy). A verse is attached only when he is clearly quoting / paraphrasing it:
  the embedding must rank it near the top AND the caption must share rare content words with it (IDF-weighted stem
  overlap in the same script). See SEM_* thresholds and match_window().
place_verses(): a card shows only during a cutaway that has an image (never over the speaker's face): the cutaway
overlapping the quoting caption, else the next one starting within 8 s, else one ending at most 10 s before.
`top_y` (the card's top edge, ASS MarginV with top-centre alignment) defaults to 520 and is moved off any face YuNet
finds in the illustration under the card band.
"""
from __future__ import annotations

import functools
import math
import re
import sqlite3
from pathlib import Path

import numpy as np

from .. import bible, config

NUM = re.compile(r"(\d{1,3})\D{0,14}?(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?")
TOP_Y = 520
MIN_FACE = 90           # px (output frame): smaller faces are background crowd
CAP_TOP = 1300          # cards end above the caption area (captions sit 400 px from the bottom)

# semantic match thresholds (calibrated on the Before-the-Foundation sermon, see scripts in SAVE / README)
SEM_K = 30              # verses retrieved by meaning per caption window (+ 15 by shared rare words)
SEM_MIN_COS = 0.80      # e5 cosine floor (e5 cosines live in ~0.75-0.95)
Q_LEX, Q_HITS, Q_RUN = 0.40, 4, 2     # quote: >= 40 % of the verse's content words, >= 4 of them, a 2-word run,
Q_RARE, Q_HIT_IDF = 2, 16.0           # ... incl. >= 2 rare words (IDF >= RARE_IDF), summed IDF >= 16
RARE_IDF = 4.5
P_COS, P_RUN, P_RUN_IDF = 0.78, 4, 9.0  # paraphrase of a commonly preached verse: a 4-word run of its wording,
P2_COS, P2_RUN, P2_RUN_IDF = 0.855, 3, 7.0  # ... or a 3-word run when the meaning is very close
LEX_W = 1.0


# ------------------------------------------------------------- explicit --
def find_refs(text: str) -> list[str]:
    t = bible.norm(text)
    out = []
    for name, code in bible.book_names():
        if len(name) < 3:
            continue
        i = t.find(name)
        while i >= 0:
            before_ok = i == 0 or not t[i - 1].isalnum()
            m = NUM.search(t[i + len(name): i + len(name) + 32])
            if before_ok and m:
                ref = f"{bible.BOOK_EN[code]} {m.group(1)}:{m.group(2)}" + (f"-{m.group(3)}" if m.group(3) else "")
                if ref not in out:
                    out.append(ref)
            i = t.find(name, i + 1)
    return out


# ------------------------------------------------------------- semantic --
_TOK = re.compile(r"[\w଀-୿ऀ-ॣ०-ॿ]+")      # Indic letters + marks, but not the danda (U+0964/65)
_MARKS = re.compile(r"[ଁ-ଃ଼ା-୍ୖୗँ-ः़ा-्ॢॣ]")
CONTENT_IDF = 2.0       # stems in < ~13 % of verses count as content words


def toks(s: str) -> list[str]:
    return [t for t in _TOK.findall(bible.norm(s)) if not t.isdigit()]


def stem(t: str) -> str:
    """Crude Indic/English stem: the first 3 base letters; vowel signs / anusvara dropped, virama + nukta kept
    (सकता/सकते -> सकत, ହୃଦୟରୁ/ହୃଦୟରେ -> ହଦୟ). Words of < 2 base letters return themselves (phrase use only)."""
    out, n = [], 0
    for ch in t:
        if _MARKS.match(ch):
            if ch in "़଼्୍" and n and n <= 3:
                out.append(ch)
            continue
        if n == 3:
            break
        out.append(ch)
        n += 1
    return "".join(out) if n >= 2 else t


class Lex:
    """Per-translation lexical index aligned with the meaning-index rows: stem sequences, IDF, postings."""

    def __init__(self, lang: str):
        import json
        refs = json.loads(bible.refs_path(lang).read_text(encoding="utf-8"))
        c = sqlite3.connect(bible.db_path(lang))
        txt = {(b, ch, v): t for b, ch, v, t in c.execute("SELECT book, chapter, verse, text FROM verses")}
        c.close()
        self.seq = [[stem(w) for w in toks(txt.get(tuple(r), ""))] for r in refs]
        n = len(self.seq)
        df: dict[str, int] = {}
        for sq in self.seq:
            for st in set(sq):
                df[st] = df.get(st, 0) + 1
        self.idf = {st: math.log((n + 1) / (d + 1)) for st, d in df.items()}
        self.post: dict[str, list[int]] = {}
        self.tot = np.zeros(n, np.float32)
        for i, sq in enumerate(self.seq):
            for st in set(sq):
                w = self.idf[st]
                if w >= CONTENT_IDF:
                    self.post.setdefault(st, []).append(i)
                    self.tot[i] += w

    def candidates(self, text: str, k: int = 15) -> list[int]:
        """Verses sharing the most IDF-weighted content stems with `text` (share of the verse's content)."""
        acc: dict[int, float] = {}
        for st in {stem(w) for w in toks(text)}:
            w = self.idf.get(st, 0.0)
            if w < CONTENT_IDF or len(self.post.get(st, ())) > 4000:
                continue
            for i in self.post[st]:
                acc[i] = acc.get(i, 0.0) + w
        sc = sorted(((v / max(self.tot[i], 1e-6), i) for i, v in acc.items() if v >= 2 * CONTENT_IDF), reverse=True)
        return [i for _, i in sc[:k]]

    def overlap(self, text: str, row: int) -> dict:
        """lex = share of the verse's content weight the text repeats; hits = shared content stems;
        run = longest contiguous run of shared stems (any words), run_idf = its summed IDF."""
        cs = [stem(w) for w in toks(text)]
        vs = self.seq[row]
        cset = set(cs)
        content = {st for st in set(vs) if self.idf.get(st, 0) >= CONTENT_IDF}
        hit = [st for st in content if st in cset]
        hit_idf = sum(self.idf[st] for st in hit)
        lex = hit_idf / max(float(self.tot[row]), 1e-6)
        best, best_idf = 0, 0.0
        prev = [0] * (len(vs) + 1)
        for a in range(1, len(cs) + 1):
            cur = [0] * (len(vs) + 1)
            for b in range(1, len(vs) + 1):
                if cs[a - 1] == vs[b - 1]:
                    cur[b] = prev[b - 1] + 1
                    if cur[b] > best or (cur[b] == best and best):
                        ridf = sum(self.idf.get(st, 0) for st in vs[b - cur[b]:b])
                        if cur[b] > best or ridf > best_idf:
                            best, best_idf = cur[b], ridf
            prev = cur
        return {"lex": round(lex, 3), "hits": len(hit), "rare": sum(1 for st in hit if self.idf[st] >= RARE_IDF),
                "hit_idf": round(hit_idf, 2), "run": best, "run_idf": round(best_idf, 2)}


_lex: dict[str, Lex] = {}
_fam: dict[str, set[int]] = {}


def famous_rows(lang: str) -> set[int]:
    """Meaning-index rows of the commonly preached verses (famous_verses.py)."""
    if lang not in _fam:
        import json
        import re as _re

        from .famous_verses import FAMOUS
        refs = json.loads(bible.refs_path(lang).read_text(encoding="utf-8"))
        pos = {tuple(r): i for i, r in enumerate(refs)}
        rows = set()
        for m in _re.finditer(r"((?:\d )?[A-Za-z]+) (\d+):(\d+)", FAMOUS):
            pr = bible.parse_ref(m.group(0))
            if pr and (pr[0], pr[1], pr[2]) in pos:
                rows.add(pos[(pr[0], pr[1], pr[2])])
        _fam[lang] = rows
    return _fam[lang]


def lex_index(lang: str) -> Lex:
    if lang not in _lex:
        _lex[lang] = Lex(lang)
    return _lex[lang]


def lex_overlap(caption: str, verse_text: str, lang: str) -> tuple[float, int]:
    """(lex share, shared content stems) for an arbitrary verse text - kept for tools / tests."""
    L = lex_index(lang)
    cs = {stem(w) for w in toks(caption)}
    vs = {stem(w) for w in toks(verse_text)}
    content = {st: L.idf.get(st, 0) for st in vs if L.idf.get(st, 0) >= CONTENT_IDF}
    tot = sum(content.values())
    hit = [st for st in content if st in cs]
    return (sum(content[st] for st in hit) / tot if tot else 0.0), len(hit)


def caption_windows(caps: list[dict], max_n: int = 3, max_gap: float = 1.5, max_len: float = 12.0) -> list[tuple]:
    out = []
    for i in range(len(caps)):
        for j in range(i, min(i + max_n, len(caps))):
            if j > i and caps[j]["t0"] - caps[j - 1]["t1"] > max_gap:
                break
            if caps[j]["t1"] - caps[i]["t0"] > max_len:
                break
            txt = " ".join(c["text"] for c in caps[i:j + 1] if c.get("text"))
            if len(txt) >= 8:
                out.append((i, j, txt))
    return out


def judge(m: dict, famous: bool) -> str | None:
    """'quote' (he reads / quotes the verse), 'paraphrase' (a commonly preached verse in his own words) or None."""
    if (m["cos"] >= SEM_MIN_COS and m["lex"] >= Q_LEX and m["hits"] >= Q_HITS and m["run"] >= Q_RUN
            and m["rare"] >= Q_RARE and m["hit_idf"] >= Q_HIT_IDF):
        return "quote"
    if famous and ((m["cos"] >= P_COS and m["run"] >= P_RUN and m["run_idf"] >= P_RUN_IDF)
                   or (m["cos"] >= P2_COS and m["run"] >= P2_RUN and m["run_idf"] >= P2_RUN_IDF)):
        return "paraphrase"
    return None


def match_window(qv: np.ndarray, text: str, lang: str) -> dict | None:
    """Best verse for one caption window, or None. Candidates = nearest by meaning + by shared rare words;
    acceptance needs both meaning and wording evidence (judge())."""
    L = lex_index(lang)
    X, _ = bible._index(lang)
    fam = famous_rows(lang)
    rows = {i for i, _ in bible.similar_vec(qv, lang, SEM_K)} | set(L.candidates(text)) | fam
    best = None
    for i in rows:
        m = L.overlap(text, i) | {"row": i, "cos": round(float(X[i] @ qv), 4)}
        kind = judge(m, i in fam)
        if not kind:
            continue
        m["kind"] = kind
        m["combined"] = round(m["cos"] + LEX_W * m["lex"] + 0.03 * min(m["run"], 10) + (0.05 if i in fam else 0), 4)
        if best is None or m["combined"] > best["combined"]:
            best = m
    if best is None:
        return None
    info = bible.rows_info(lang, [(best["row"], best["cos"])])[0]
    return info | best


def rank_verses(text: str, lang: str, k: int = 10) -> list[dict]:
    """GET /bible/similar: verses ranked by meaning + wording (cos + lexical share + word run, like match_window,
    without the acceptance gate). `quote` says whether the detector would accept it as a quote / paraphrase."""
    from . import embed
    text = (text or "").strip()
    if not text or not bible.ensure_index(lang):
        return []
    qv = embed.embed_texts([text], "query: ")[0]
    L = lex_index(lang)
    X, _ = bible._index(lang)
    fam = famous_rows(lang)
    rows = {i for i, _ in bible.similar_vec(qv, lang, SEM_K)} | set(L.candidates(text))
    out = []
    for i in rows:
        m = L.overlap(text, i) | {"row": i, "cos": round(float(X[i] @ qv), 4)}
        m["quote"] = judge(m, i in fam)
        m["combined"] = round(m["cos"] + LEX_W * m["lex"] + 0.03 * min(m["run"], 10) + (0.05 if i in fam else 0), 4)
        out.append(m)
    out.sort(key=lambda m: -m["combined"])
    res = []
    for m in out[:k]:
        info = bible.rows_info(lang, [(m["row"], m["combined"])])[0]
        res.append(info | {"cos": m["cos"], "lex": round(m["lex"], 3), "run": m["run"], "quote": m["quote"]})
    return res


def detect(captions: list[dict], lang: str, semantic: bool = True) -> list[dict]:
    """All verses quoted in the captions: [{ref, kind, score, t0, t1, caption, ...}] (reel seconds), best first,
    one entry per verse."""
    if lang not in bible.TRANSLATIONS or not bible.db_path(lang).exists():
        return []
    caps = sorted([c for c in captions if c.get("text")], key=lambda c: c["t0"])
    found: dict[str, dict] = {}
    for c in caps:
        for ref in find_refs(c["text"]):
            found.setdefault(ref, {"ref": ref, "kind": "explicit", "score": 2.0, "t0": c["t0"], "t1": c["t1"],
                                   "caption": c["text"]})
    if semantic:
        from . import embed
        if embed.available() and caps and bible.ensure_index(lang):
            wins = caption_windows(caps)
            if wins:
                Q = embed.embed_texts([w[2] for w in wins], prefix="query: ")
                for (i, j, txt), qv in zip(wins, Q):
                    m = match_window(qv, txt, lang)
                    if not m:
                        continue
                    ref = m["ref"]
                    if any(_same_verse(ref, r) for r in found if found[r]["kind"] == "explicit"):
                        continue
                    cur = found.get(ref)
                    if cur is None or m["combined"] > cur["score"]:
                        found[ref] = {"ref": ref, "kind": "semantic", "how": m["kind"], "score": m["combined"],
                                      "cos": m["cos"], "lex": m["lex"], "hits": m["hits"], "run": m["run"],
                                      "t0": caps[i]["t0"], "t1": caps[j]["t1"], "caption": txt}
    keep: list[dict] = []   # one verse per quoting moment: a weaker hit overlapping a stronger one is a sibling text
    for d in sorted(found.values(), key=lambda d: -d["score"]):
        if d["kind"] == "explicit" or not any(k["t0"] < d["t1"] and d["t0"] < k["t1"] for k in keep):
            keep.append(d)
    return keep


def _same_verse(a: str, b: str) -> bool:
    pa, pb = bible.parse_ref(a), bible.parse_ref(b)
    if not pa or not pb or pa[:2] != pb[:2]:
        return False
    a1, a2 = pa[2] or 0, pa[3] or 999
    b1, b2 = pb[2] or 0, pb[3] or 999
    return a1 <= b2 and b1 <= a2


# ------------------------------------------------------------ placement --
def card_height(text: str, ref: str) -> int:
    """Approximate rendered height of the ASS Verse card below top_y (64 px text wrapped in a 900 px box,
    46 px ref line, 20 px box border). Measured on libass renders: ~24 px per base letter (Indic) / ~30 (Latin),
    ~74 px per text line."""
    base = len(_MARKS.sub("", text))
    per_line = 900 / (24 if re.search(r"[଀-୿ऀ-ॿ]", text) else 30)
    lines = max(1, math.ceil(base / per_line))
    return int(lines * 74 + 56 + 20)


@functools.lru_cache(maxsize=1)
def _detector():
    import cv2
    return cv2.FaceDetectorYN.create(str(config.ASSETS / "yunet.onnx"), "", (320, 320), 0.7)


@functools.lru_cache(maxsize=64)
def image_faces(path: str) -> tuple:
    """Face boxes (x, y, w, h) in the image's own pixels, YuNet on a <= 960 px copy."""
    import cv2
    img = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return ()
    h, w = img.shape[:2]
    s = min(1.0, 960 / max(h, w))
    sm = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else img
    det = _detector()
    det.setInputSize((sm.shape[1], sm.shape[0]))
    _, faces = det.detect(sm)
    if faces is None:
        return ()
    return tuple((float(f[0] / s), float(f[1] / s), float(f[2] / s), float(f[3] / s), (w, h)) for f in faces)


def faces_in_frame(cut: dict) -> list[tuple[float, float]]:
    """Vertical extents (y0, y1) in 1080x1920 output pixels of every face over the cutaway's Ken Burns move
    (same transform as media.reel.Cutaway)."""
    boxes = image_faces(cut["img"])
    if not boxes:
        return []
    w, h = boxes[0][4]
    scale = max(1080 / w, 1920 / h) * max(cut.get("z0", 1.12), cut.get("z1", 1.22))
    big = max(b[3] for b in boxes) * scale
    out = []
    for x, y, fw, fh, (w, h) in boxes:
        if fh * scale < max(MIN_FACE, 0.45 * big):   # background crowd: a card may cover it
            continue
        base = max(1080 / w, 1920 / h)
        z0, z1 = cut.get("z0", 1.12), cut.get("z1", 1.22)
        px, py = (cut.get("pan") or [0, 0])[:2]
        ys = []
        for u in (0.0, 0.5, 1.0):
            k = base * (z0 + (z1 - z0) * u)
            cx, cy = w / 2 + px * (u - 0.5), h / 2 + py * (u - 0.5)
            fx0, fx1 = k * (x - cx) + 540, k * (x + fw - cx) + 540
            if fx1 < 0 or fx0 > 1080:
                continue
            ys += [k * (y - cy) + 960, k * (y + fh - cy) + 960]
        if ys:
            out.append((min(ys) - 30, max(ys) + 30))   # forehead / chin margin
    return out


def choose_top_y(cut: dict, height: int) -> tuple[int, list]:
    faces = faces_in_frame(cut) if cut.get("img") else []
    if not faces:
        return TOP_Y, faces
    cands = [TOP_Y] + list(range(TOP_Y - 60, 149, -60)) + list(range(TOP_Y + 60, CAP_TOP - height + 1, 60))
    cands = [c for c in cands if 150 <= c and c + height <= CAP_TOP] or [TOP_Y]

    def overlap(t):  # the card box starts ~20 px above top_y
        return sum(max(0.0, min(t + height, b) - max(t - 20, a)) for a, b in faces)
    best = min(cands, key=lambda t: (overlap(t) > 0, overlap(t), abs(t - TOP_Y)))
    return int(best), faces


def _trim(txt: str, n: int = 170) -> str:
    if len(txt) <= n:
        return txt
    cut = max(txt.rfind(x, 0, n) for x in ("।", ";", ",", " "))
    return txt[:cut if cut > 60 else n].rstrip(" ,;") + " …"


def place_verses(captions: list[dict], cutaways: list[dict], lang: str, semantic: bool = True,
                 max_cards: int = 2) -> list[dict]:
    if lang not in bible.TRANSLATIONS or not bible.db_path(lang).exists() or not cutaways:
        return []
    cuts = sorted([c for c in cutaways if c.get("img") and Path(c["img"]).exists() and c["t1"] - c["t0"] >= 2.0],
                  key=lambda c: c["t0"])
    if not cuts:
        return []
    used: set[int] = set()
    out = []
    for d in detect(captions, lang, semantic):
        if len(out) >= max_cards:
            break

        def prio(i):
            # the card should appear while (or just after) he says it: a real overlap (>= 1 s or half the
            # cutaway) first, then the next cutaway within 8 s, then one just before
            cu = cuts[i]
            ov = min(cu["t1"], d["t1"]) - max(cu["t0"], d["t0"])
            if ov >= min(1.0, 0.5 * (cu["t1"] - cu["t0"])):
                return (0, -ov)
            if 0 <= cu["t0"] - d["t1"] <= 8:
                return (1, cu["t0"] - d["t1"])
            if 0 <= d["t0"] - cu["t1"] <= 10:
                return (2, d["t0"] - cu["t1"])
            return None
        cand = [(prio(i), i) for i in range(len(cuts)) if i not in used and prio(i) is not None]
        if not cand:
            continue
        k = min(cand)[1]
        try:
            v = bible.verse(d["ref"], lang)
        except Exception:  # noqa: BLE001
            continue
        used.add(k)
        cu = cuts[k]
        txt = _trim(v["text"])
        top_y, faces = choose_top_y(cu, card_height(txt, v["display_ref"]))
        out.append({"t0": round(cu["t0"] + 0.3, 3), "t1": round(cu["t1"] - 0.3, 3), "text": txt,
                    "ref": v["display_ref"], "top_y": top_y, "attribution": v["attribution"],
                    "match": {"kind": d["kind"], "score": round(float(d["score"]), 4), "caption": d["caption"],
                              "caption_t": [d["t0"], d["t1"]], **({"how": d["how"], "cos": d["cos"], "lex": d["lex"], "run": d["run"]}
                                                                   if d["kind"] == "semantic" else {})},
                    "faces": len(faces)})
    return sorted(out, key=lambda v: v["t0"])
