"""USFM parsing + verse lookup on a tiny in-memory eBible-style zip."""
import io
import zipfile

import pytest

from viku import bible
from viku.jobs import JobError

JHN = r"""\id JHN World English Bible
\h John
\toc1 The Good News According to John
\toc2 John
\toc3 Jn
\mt1 John
\c 3
\s1 Born again
\p
\v 16 \w For|strong="G1063"\w* God so loved the world,\f + \fr 3:16 \ft a footnote\f* that he gave his one and only Son,
\q1 that whoever believes in him should not perish, but have eternal life.
\v 17 For God didn’t send his Son into the world to judge the world,\x + \xo 3:17 \xt Luke 9:56\x* but that the world should be saved through him.
\c 15
\p
\v 5 I am the vine. You are the branches.
"""

ROM_OR = r"""\id ROM
\h ରୋମୀୟ
\toc1 ରୋମୀୟଙ୍କ ପ୍ରତି ପତ୍ର
\toc2 ରୋମୀୟ
\c 10
\p
\v 9 ଯଦି ତୁମ୍ଭେ ମୁଖରେ ଯୀଶୁଙ୍କୁ ପ୍ରଭୁ ବୋଲି ସ୍ୱୀକାର କର,
\v 10 କାରଣ ହୃଦୟରେ ବିଶ୍ୱାସ କରି ଲୋକ ଧାର୍ମିକ ଗଣିତ ହୁଏ।
"""


def _zip(files: dict) -> bytes:
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for k, v in files.items():
            z.writestr(k, v)
    return b.getvalue()


def test_parse_usfm_strips_footnotes_crossrefs_and_word_attributes():
    code, names, verses = bible.parse_usfm(JHN)
    assert code == "JHN"
    assert names["h"] == "John" and names["toc3"] == "Jn"
    d = {(c, v): t for c, v, t in verses}
    assert set(d) == {(3, 16), (3, 17), (15, 5)}
    assert d[(3, 16)].startswith("For God so loved the world, that he gave")
    assert d[(3, 16)].endswith("should not perish, but have eternal life.")  # poetry line joins the verse
    assert "strong" not in d[(3, 16)] and "footnote" not in d[(3, 16)]
    assert "Luke 9:56" not in d[(3, 17)]


@pytest.fixture(scope="module")
def dbs():
    bible.build_db("en", _zip({"44JHNengwebp.usfm": JHN}))
    bible.build_db("or", _zip({"46ROMory.usfm": ROM_OR}))
    yield
    for lang in ("en", "or"):
        bible.db_path(lang).unlink(missing_ok=True)
    bible._names_cache.clear()


def test_verse_lookup_english(dbs):
    v = bible.verse("John 3:16", "en")
    assert v["book"] == "JHN" and v["chapter"] == 3 and v["verse_start"] == 16
    assert v["text"].startswith("For God so loved")
    assert v["attribution"] == "World English Bible (WEB), public domain"
    r = bible.verse("Jn 3:16-17", "en")
    assert [x["verse"] for x in r["verses"]] == [16, 17]


def test_verse_lookup_native_name_and_digits(dbs):
    v = bible.verse("ରୋମୀୟ ୧୦:୧୦", "or")  # Odia book name + Odia digits
    assert v["ref"] == "Romans 10:10"
    assert v["display_ref"] == "ରୋମୀୟ 10:10 · Romans 10:10"
    assert "Bridge Connectivity Solutions" in v["attribution"]


def test_parse_ref_variants(dbs):
    assert bible.parse_ref("Romans 10:9-10") == ("ROM", 10, 9, 10)
    assert bible.parse_ref("rom 10") == ("ROM", 10, None, None)
    assert bible.parse_ref("John 15:5") == ("JHN", 15, 5, 5)
    assert bible.parse_ref("Johnny 3:16") is None  # partial word must not match


def test_missing_verse_is_a_clear_error(dbs):
    with pytest.raises(JobError):
        bible.verse("John 99:1", "en")
