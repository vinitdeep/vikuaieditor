"""Offline Bible: eBible.org USFM zips -> <data>/bible/<code>.sqlite (verses + FTS5 trigram index).

Translations: or = ory (Indian Revised Version, Odia), hi = hin2017 (IRV Hindi), en = eng-web (World English
Bible). Attribution is read from each zip's copr.htm (fallback strings below) and stored per translation.
Refs accept English names/abbreviations or native names (\\h, \\toc1-3 of the USFM), ASCII/Odia/Devanagari digits:
"Romans 10:10", "Rom 10:9-10", "ରୋମୀୟ ୧୦:୧୦", "रोमियों 10:10", "John 3".
"""
from __future__ import annotations

import html
import io
import re
import sqlite3
import urllib.request
import zipfile
from pathlib import Path

from . import config
from .jobs import Cancelled, Job, JobError

TRANSLATIONS = {
    "or": {"code": "ory", "url": "https://ebible.org/Scriptures/ory_usfm.zip",
           "attribution": "Indian Revised Version (IRV) Odia © 2017, 2019, 2021 Bridge Connectivity Solutions, CC BY-SA 4.0"},
    "hi": {"code": "hin2017", "url": "https://ebible.org/Scriptures/hin2017_usfm.zip",
           "attribution": "Indian Revised Version (IRV) Hindi © 2017, 2018, 2019 Bridge Connectivity Solutions, CC BY-SA 4.0"},
    "en": {"code": "eng-web", "url": "https://ebible.org/Scriptures/eng-web_usfm.zip",
           "attribution": "World English Bible (WEB), public domain"},
}

# USFM code -> English name + extra aliases
BOOKS = [
    ("GEN", "Genesis", "gen ge gn"), ("EXO", "Exodus", "exod ex"), ("LEV", "Leviticus", "lev lv"),
    ("NUM", "Numbers", "num nm"), ("DEU", "Deuteronomy", "deut dt"), ("JOS", "Joshua", "josh jos"),
    ("JDG", "Judges", "judg jdg"), ("RUT", "Ruth", "ru"), ("1SA", "1 Samuel", "1 sam 1sam"),
    ("2SA", "2 Samuel", "2 sam 2sam"), ("1KI", "1 Kings", "1 kgs 1kgs"), ("2KI", "2 Kings", "2 kgs 2kgs"),
    ("1CH", "1 Chronicles", "1 chr 1chr"), ("2CH", "2 Chronicles", "2 chr 2chr"), ("EZR", "Ezra", "ezr"),
    ("NEH", "Nehemiah", "neh"), ("EST", "Esther", "esth est"), ("JOB", "Job", "jb"),
    ("PSA", "Psalms", "psalm ps psa"), ("PRO", "Proverbs", "prov prv pr"), ("ECC", "Ecclesiastes", "eccl ecc qoh"),
    ("SNG", "Song of Songs", "song of solomon song sos"), ("ISA", "Isaiah", "isa is"), ("JER", "Jeremiah", "jer"),
    ("LAM", "Lamentations", "lam"), ("EZK", "Ezekiel", "ezek eze ezk"), ("DAN", "Daniel", "dan dn"),
    ("HOS", "Hosea", "hos"), ("JOL", "Joel", "jl"), ("AMO", "Amos", "am"), ("OBA", "Obadiah", "obad ob"),
    ("JON", "Jonah", "jon"), ("MIC", "Micah", "mic"), ("NAM", "Nahum", "nah"), ("HAB", "Habakkuk", "hab"),
    ("ZEP", "Zephaniah", "zeph zep"), ("HAG", "Haggai", "hag"), ("ZEC", "Zechariah", "zech zec"),
    ("MAL", "Malachi", "mal"), ("MAT", "Matthew", "matt mt"), ("MRK", "Mark", "mk mrk"), ("LUK", "Luke", "lk luk"),
    ("JHN", "John", "jn jhn"), ("ACT", "Acts", "act"), ("ROM", "Romans", "rom rm"),
    ("1CO", "1 Corinthians", "1 cor 1cor"), ("2CO", "2 Corinthians", "2 cor 2cor"), ("GAL", "Galatians", "gal"),
    ("EPH", "Ephesians", "eph"), ("PHP", "Philippians", "phil php"), ("COL", "Colossians", "col"),
    ("1TH", "1 Thessalonians", "1 thess 1thess 1 th"), ("2TH", "2 Thessalonians", "2 thess 2thess 2 th"),
    ("1TI", "1 Timothy", "1 tim 1tim"), ("2TI", "2 Timothy", "2 tim 2tim"), ("TIT", "Titus", "tit"),
    ("PHM", "Philemon", "phlm phm"), ("HEB", "Hebrews", "heb"), ("JAS", "James", "jas jm"),
    ("1PE", "1 Peter", "1 pet 1pet"), ("2PE", "2 Peter", "2 pet 2pet"), ("1JN", "1 John", "1 jn 1jn 1 john"),
    ("2JN", "2 John", "2 jn 2jn"), ("3JN", "3 John", "3 jn 3jn"), ("JUD", "Jude", "jud"),
    ("REV", "Revelation", "rev rv revelations"),
]
BOOK_EN = {c: n for c, n, _ in BOOKS}
ORDER = {c: i for i, (c, _, _) in enumerate(BOOKS)}

DIGITS = str.maketrans("୦୧୨୩୪୫୬୭୮୯०१२३४५६७८९", "01234567890123456789")
SKIP = re.compile(r"^(id|ide|h|toc\d|mt\d?|mte\d?|imt\d?|is\d?|ip|ipr|iot|io\d?|ili\d?|im|imq|ie|rem|s\d?|ms\d?|mr|r|sr|"
                  r"sp|cl|cd|d|sts|restore|periph|cat|usfm)$")


def bdir() -> Path:
    return config.sub("bible")


def db_path(lang: str) -> Path:
    return bdir() / f"{TRANSLATIONS[lang]['code']}.sqlite"


def status() -> dict:
    return {lang: db_path(lang).exists() for lang in TRANSLATIONS}


def ready() -> bool:
    return all(status().values())


# ---------------------------------------------------------------- parse --
def clean_inline(s: str) -> str:
    s = re.sub(r"\\f\s.*?\\f\*", "", s, flags=re.S)
    s = re.sub(r"\\fe\s.*?\\fe\*", "", s, flags=re.S)
    s = re.sub(r"\\x\s.*?\\x\*", "", s, flags=re.S)
    s = re.sub(r"\|[^\\|]*?(?=\\\+?[a-z]+\d?\*)", "", s)        # \w word|strong="..."\w*  -> word
    s = re.sub(r"\\\+?[a-z]+\d*\*?", " ", s)                    # remaining character markers
    s = s.replace("~", " ").replace("//", " ")
    s = re.sub(r"\s+", " ", s)
    return re.sub(r" ([,.;:!?।’”)])", r"\1", s).strip()


def parse_usfm(text: str) -> tuple[str, dict, list[tuple[int, int, str]]]:
    """-> (book code, names {h,toc1,toc2,toc3}, [(chapter, verse, text)])."""
    text = re.sub(r"\\f\s.*?\\f\*", "", text, flags=re.S)
    text = re.sub(r"\\fe\s.*?\\fe\*", "", text, flags=re.S)
    text = re.sub(r"\\x\s.*?\\x\*", "", text, flags=re.S)
    code, names, verses = "", {}, []
    ch, vs, buf = 0, None, []

    def flush():
        if vs is not None and ch:
            t = clean_inline(" ".join(buf))
            if t:
                verses.append((ch, vs, t))

    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("\\"):
            if vs is not None:
                buf.append(line)
            continue
        m = re.match(r"\\([a-z]+\d*)\s*(.*)", line)
        if not m:
            continue
        mk, rest = m.group(1), m.group(2)
        if mk == "id":
            code = rest.split()[0].upper() if rest else ""
            continue
        if mk in ("h", "toc1", "toc2", "toc3"):
            names[mk] = rest.strip()
            continue
        if mk == "c":
            flush()
            vs, buf = None, []
            try:
                ch = int(rest.split()[0])
            except (ValueError, IndexError):
                pass
            continue
        if SKIP.match(mk):
            continue
        # paragraph / poetry markers carry verse text; \v may appear anywhere in the line
        if mk != "v":
            rest = re.sub(r"^\\?[a-z]+\d*\s*", "", rest) if rest.startswith("\\") and not rest.startswith("\\v ") else rest
        parts = re.split(r"\\v\s+", ("\\v " + rest) if mk == "v" else rest)
        if parts and parts[0].strip() and vs is not None:
            buf.append(parts[0])
        for part in parts[1:]:
            flush()
            m2 = re.match(r"(\d+)[\w-]*\s*(.*)", part, flags=re.S)
            if not m2:
                continue
            vs, buf = int(m2.group(1)), [m2.group(2)]
    flush()
    return code, names, verses


def build_db(lang: str, zbytes: bytes) -> dict:
    zf = zipfile.ZipFile(io.BytesIO(zbytes))
    attribution = TRANSLATIONS[lang]["attribution"]
    copr = ""
    if "copr.htm" in zf.namelist():  # keep the publisher's own statement too
        t = html.unescape(re.sub(r"<[^>]+>", "\n", zf.read("copr.htm").decode("utf-8", "replace")))
        lines = [l.strip() for l in t.splitlines() if l.strip()]
        copr = " · ".join(l for l in lines if re.search(r"Bible|copyright|©|Contributor|public domain|license", l, re.I))[:600]
    out = db_path(lang)
    tmp = out.with_suffix(".tmp")
    if tmp.exists():
        tmp.unlink()
    c = sqlite3.connect(tmp)
    c.executescript("""
        CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE books(code TEXT PRIMARY KEY, ord INT, name_en TEXT, h TEXT, toc1 TEXT, toc2 TEXT, toc3 TEXT);
        CREATE TABLE verses(book TEXT, chapter INT, verse INT, text TEXT, PRIMARY KEY(book, chapter, verse));
        CREATE VIRTUAL TABLE fts USING fts5(text, book UNINDEXED, chapter UNINDEXED, verse UNINDEXED, tokenize='trigram');
    """)
    nb = nv = 0
    for name in sorted(zf.namelist()):
        if not name.lower().endswith((".usfm", ".sfm")):
            continue
        code, names, verses = parse_usfm(zf.read(name).decode("utf-8-sig", "replace"))
        if code not in ORDER or not verses:
            continue
        c.execute("INSERT OR REPLACE INTO books VALUES(?,?,?,?,?,?,?)",
                  (code, ORDER[code], BOOK_EN[code], names.get("h"), names.get("toc1"), names.get("toc2"),
                   names.get("toc3")))
        c.executemany("INSERT OR REPLACE INTO verses VALUES(?,?,?,?)", [(code, a, b, t) for a, b, t in verses])
        c.executemany("INSERT INTO fts VALUES(?,?,?,?)", [(t, code, a, b) for a, b, t in verses])
        nb += 1
        nv += len(verses)
    c.executemany("INSERT INTO meta VALUES(?,?)", [("lang", lang), ("code", TRANSLATIONS[lang]["code"]),
                                                   ("attribution", attribution), ("copr", copr),
                                                   ("source", TRANSLATIONS[lang]["url"])])
    c.commit()
    c.close()
    tmp.replace(out)
    _names_cache.clear()
    return {"lang": lang, "books": nb, "verses": nv, "attribution": attribution}


def download(job: Job, langs: list[str] | None = None) -> list[dict]:
    langs = langs or list(TRANSLATIONS)
    res = []
    for i, lang in enumerate(langs):
        t = TRANSLATIONS[lang]
        job.update(i / len(langs), f"downloading {t['code']}")
        try:
            req = urllib.request.Request(t["url"], headers={"User-Agent": "viku-engine"})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
        except Exception as e:  # noqa: BLE001
            raise JobError(f"download failed for {t['url']}: {e}")
        job.check()
        job.update((i + 0.6) / len(langs), f"indexing {t['code']}")
        info = build_db(lang, data)
        try:  # meaning index (embeddings of every verse) - offline, a few minutes per translation on CPU
            with job.scope((i + 0.65) / len(langs), (i + 1) / len(langs)):
                info["meaning_index"] = embed_index(lang, job)
        except (JobError, Cancelled):
            raise
        except Exception as e:  # noqa: BLE001 - the Bible still works without it (built lazily later)
            info["meaning_index"] = f"failed: {e}"
        res.append(info)
    return res


# --------------------------------------------------------------- lookup --
_names_cache: dict[str, list[tuple[str, str]]] = {}


def norm(s: str) -> str:
    s = (s or "").translate(DIGITS).lower()
    s = re.sub(r"[.\u200c\u200d]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def book_names() -> list[tuple[str, str]]:
    """[(normalized name, code)] longest first, from English list + every downloaded translation."""
    if "all" in _names_cache:
        return _names_cache["all"]
    names = []
    for code, en, alias in BOOKS:
        names.append((norm(en), code))
        names.append((norm(code), code))
        for a in _aliases(alias):
            names.append((norm(a), code))
    for lang in TRANSLATIONS:
        f = db_path(lang)
        if not f.exists():
            continue
        c = sqlite3.connect(f)
        for code, h, t1, t2, t3 in c.execute("SELECT code, h, toc1, toc2, toc3 FROM books"):
            for n in (h, t1, t2, t3):
                if n and len(norm(n)) >= 2:
                    names.append((norm(n), code))
        c.close()
    names = sorted(set(names), key=lambda x: -len(x[0]))
    _names_cache["all"] = names
    return names


def _aliases(alias: str) -> list[str]:
    toks, out, i = alias.split(), [], 0
    while i < len(toks):
        if toks[i].isdigit() and i + 1 < len(toks):
            out.append(toks[i] + " " + toks[i + 1])
            i += 2
        else:
            out.append(toks[i])
            i += 1
    return out


REF_TAIL = re.compile(r"^\s*(\d+)(?:\s*[:.]\s*(\d+)(?:\s*[-–]\s*(\d+))?)?")


def parse_ref(ref: str) -> tuple[str, int, int | None, int | None] | None:
    q = norm(ref)
    for name, code in book_names():
        if q.startswith(name):
            rest = q[len(name):]
            if rest and rest[0].isalnum() and not rest[0].isdigit():
                continue  # partial word match
            m = REF_TAIL.match(rest)
            if not m:
                continue
            ch = int(m.group(1))
            v1 = int(m.group(2)) if m.group(2) else None
            v2 = int(m.group(3)) if m.group(3) else v1
            return code, ch, v1, v2
    return None


def _conn(lang: str) -> sqlite3.Connection:
    f = db_path(lang)
    if not f.exists():
        raise JobError(f"Bible for '{lang}' not downloaded - POST /bible/download first")
    return sqlite3.connect(f)


def attribution(lang: str) -> str:
    c = _conn(lang)
    r = c.execute("SELECT v FROM meta WHERE k='attribution'").fetchone()
    c.close()
    return r[0] if r else TRANSLATIONS[lang]["attribution"]


def verse(ref: str, lang: str) -> dict:
    pr = parse_ref(ref)
    if not pr:
        raise JobError(f"cannot parse reference: {ref}")
    code, ch, v1, v2 = pr
    c = _conn(lang)
    if v1 is None:
        rows = c.execute("SELECT verse, text FROM verses WHERE book=? AND chapter=? ORDER BY verse", (code, ch)).fetchall()
    else:
        rows = c.execute("SELECT verse, text FROM verses WHERE book=? AND chapter=? AND verse BETWEEN ? AND ? ORDER BY verse",
                         (code, ch, v1, v2)).fetchall()
    b = c.execute("SELECT h, toc2 FROM books WHERE code=?", (code,)).fetchone()
    c.close()
    if not rows:
        raise JobError(f"verse not found: {ref}")
    native = (b[0] or b[1] or BOOK_EN[code]).strip() if b else BOOK_EN[code]
    span = f"{ch}" + (f":{v1}" if v1 else "") + (f"-{v2}" if v2 and v2 != v1 else "")
    en = f"{BOOK_EN[code]} {span}"
    return {"ref": en, "ref_native": f"{native} {span}", "display_ref": f"{native} {span} · {en}" if lang != "en" else en,
            "book": code, "chapter": ch, "verse_start": v1, "verse_end": v2, "lang": lang,
            "text": " ".join(t for _, t in rows), "verses": [{"verse": v, "text": t} for v, t in rows],
            "attribution": attribution(lang)}


def search(q: str, lang: str, limit: int = 30) -> list[dict]:
    q = (q or "").strip()
    if not q:
        return []
    pr = parse_ref(q)
    if pr:
        try:
            return [verse(q, lang)]
        except JobError:
            pass
    c = _conn(lang)
    if len(q) >= 3:
        rows = c.execute("SELECT book, chapter, verse, text FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?",
                         ('"' + q.replace('"', '""') + '"', limit)).fetchall()
    else:
        rows = c.execute("SELECT book, chapter, verse, text FROM verses WHERE text LIKE ? LIMIT ?",
                         (f"%{q}%", limit)).fetchall()
    c.close()
    return [{"ref": f"{BOOK_EN.get(b, b)} {ch}:{v}", "book": b, "chapter": ch, "verse": v, "text": t, "lang": lang}
            for b, ch, v, t in rows]


# ------------------------------------------------------- meaning index --
# Every verse embedded once with multilingual-e5-small ("passage: " + verse text) into
# <data>/bible/<code>.emb.npy (float16, L2-normalised) + <code>.emb.refs.json ([[book, chapter, verse], ...]
# in the same row order). bible.similar() embeds the probe with "query: " and ranks by cosine.
_emb_cache: dict[str, tuple] = {}


def emb_path(lang: str) -> Path:
    return bdir() / f"{TRANSLATIONS[lang]['code']}.emb.npy"


def refs_path(lang: str) -> Path:
    return bdir() / f"{TRANSLATIONS[lang]['code']}.emb.refs.json"


def index_ready(lang: str) -> bool:
    return emb_path(lang).exists() and refs_path(lang).exists()


def embed_index(lang: str, job: Job | None = None) -> dict:
    import json
    import time

    import numpy as np

    from .brain import embed
    c = _conn(lang)
    rows = c.execute("SELECT v.book, v.chapter, v.verse, v.text FROM verses v JOIN books b ON b.code=v.book "
                     "ORDER BY b.ord, v.chapter, v.verse").fetchall()
    c.close()
    code = TRANSLATIONS[lang]["code"]
    t0 = time.perf_counter()

    def prog(done, total):
        if job is not None:
            job.check()
            el = time.perf_counter() - t0
            eta = el / max(done, 1) * (total - done)
            job.update(done / total, f"Bible meaning index {code}: {done}/{total} verses (~{eta:.0f} s left)")

    if job is not None:
        job.update(0.0, f"Bible meaning index {code}: {len(rows)} verses")
    embed.ensure_model(job)
    X = embed.embed_texts([r[3] for r in rows], prefix="passage: ", batch=64, cache=False, progress=prog)
    tmp = emb_path(lang).with_suffix(".tmp.npy")
    np.save(tmp, X.astype(np.float16))
    tmp.replace(emb_path(lang))
    refs_path(lang).write_text(json.dumps([[b, ch, v] for b, ch, v, _ in rows]), encoding="utf-8")
    _emb_cache.pop(lang, None)
    secs = round(time.perf_counter() - t0, 1)
    return {"lang": lang, "code": code, "verses": len(rows), "seconds": secs,
            "mb": round(emb_path(lang).stat().st_size / 1e6, 1)}


def ensure_index(lang: str, job: Job | None = None) -> bool:
    """Build the meaning index if missing (minutes on CPU). False when the Bible itself is missing."""
    if lang not in TRANSLATIONS or not db_path(lang).exists():
        return False
    if not index_ready(lang):
        embed_index(lang, job)
    return True


def _index(lang: str):
    import json

    import numpy as np
    f = emb_path(lang)
    m = f.stat().st_mtime
    hit = _emb_cache.get(lang)
    if hit and hit[0] == m:
        return hit[1], hit[2]
    X = np.load(f).astype(np.float32)
    refs = json.loads(refs_path(lang).read_text(encoding="utf-8"))
    _emb_cache[lang] = (m, X, refs)
    return X, refs


def similar_vec(q, lang: str, k: int = 10) -> list[tuple[int, float]]:
    """(row, cosine) of the k nearest verses for an already-embedded query vector."""
    import numpy as np
    X, _ = _index(lang)
    s = X @ q
    top = np.argpartition(-s, min(k, len(s) - 1))[:k]
    top = top[np.argsort(-s[top])]
    return [(int(i), float(s[i])) for i in top]


def rows_info(lang: str, hits: list[tuple[int, float]]) -> list[dict]:
    _, refs = _index(lang)
    c = _conn(lang)
    out = []
    for i, sc in hits:
        b, ch, v = refs[i]
        t = c.execute("SELECT text FROM verses WHERE book=? AND chapter=? AND verse=?", (b, ch, v)).fetchone()
        nb = c.execute("SELECT h, toc2 FROM books WHERE code=?", (b,)).fetchone()
        native = ((nb[0] or nb[1]) if nb else None) or BOOK_EN[b]
        en = f"{BOOK_EN[b]} {ch}:{v}"
        out.append({"ref": en, "display_ref": f"{native.strip()} {ch}:{v} · {en}" if lang != "en" else en,
                    "book": b, "chapter": ch, "verse": v, "text": t[0] if t else "", "score": round(sc, 4),
                    "row": i})
    c.close()
    return out


def similar(text: str, lang: str, k: int = 10) -> list[dict]:
    """Verses closest in meaning to `text` in translation `lang` (builds the index on first use)."""
    from .brain import embed
    text = (text or "").strip()
    if not text:
        return []
    if not ensure_index(lang):
        raise JobError(f"Bible for '{lang}' not downloaded - POST /bible/download first")
    q = embed.embed_texts([text], prefix="query: ")[0]
    return rows_info(lang, similar_vec(q, lang, k))
