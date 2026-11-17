"""Devanagari -> Hinglish (casual Latin spelling, as Hindi reel thumbnails use) and Odia digits.

Rules: consonant + inherent 'a'; matras replace it; virama removes it; schwa deletion drops the
inherent 'a' at the end of a word and in the middle of V C a C V patterns (कमरा -> kamra, समझना ->
samajhna); anusvara / chandrabindu -> n (m before labials); nukta letters map to z / f / r.
A small dictionary fixes frequent words whose casual spelling differs (नहीं -> nahi, है -> hai).
    hinglish("अकेले नहीं")  -> "Akele Nahi"
"""
from __future__ import annotations

import re

CONS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
    "ष": "sh", "स": "s", "ह": "h", "ळ": "l", "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh",
    "फ़": "f", "य़": "y",
}
NUKTA = {"क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f"}
VOW = {"अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o",
       "औ": "au", "ऑ": "o", "ऍ": "e"}
MATRA = {"ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
         "ॉ": "o", "ॅ": "e"}
VIRAMA, NUK, ANUS, CANDRA, VISARGA = "्", "़", "ं", "ँ", "ः"
LABIAL = set("pbm")
DIGITS_DEV = str.maketrans("०१२३४५६७८९", "0123456789")
TO_ODIA = str.maketrans("0123456789", "୦୧୨୩୪୫୬୭୮୯")
WORDS = {"नहीं": "nahi", "नही": "nahi", "है": "hai", "हैं": "hain", "मैं": "main", "में": "mein", "यह": "yeh",
         "वह": "woh", "और": "aur", "के": "ke", "की": "ki", "का": "ka", "को": "ko", "से": "se", "पर": "par",
         "हम": "hum", "तुम": "tum", "आप": "aap", "प्रभु": "prabhu", "परमेश्वर": "parmeshwar", "यीशु": "yeshu",
         "मसीह": "masih", "शैतान": "shaitan", "सकूंगा": "sakunga", "सकूँगा": "sakunga", "सकता": "sakta",
         "कर": "kar", "जीवन": "jeevan", "प्रार्थना": "prarthana", "आशीष": "aashish", "विश्वास": "vishwas",
         "रोमियों": "romiyon", "यूहन्ना": "yuhanna", "फिलिप्पियों": "philippiyon", "भजन": "bhajan",
         "संहिता": "sanhita", "उत्पत्ति": "utpatti", "मत्ती": "matti", "लूका": "luka", "मरकुस": "markus"}


def _word(w: str) -> str:
    if w in WORDS:
        return WORDS[w]
    # tokens: (latin, kind) with kind C (consonant with inherent a), V (vowel), M (modifier)
    units: list[list] = []  # [text, has_inherent_a]
    i, n = 0, len(w)
    while i < n:
        ch = w[i]
        if ch in CONS or (ch + NUK) in CONS:
            lat = CONS.get(ch, "")
            if i + 1 < n and w[i + 1] == NUK:
                lat = NUKTA.get(ch, lat)
                i += 1
            unit = [lat, True]
            if i + 1 < n and w[i + 1] in MATRA:
                unit = [lat + MATRA[w[i + 1]], False]
                i += 1
            elif i + 1 < n and w[i + 1] == VIRAMA:
                unit = [lat, False]
                i += 1
            units.append(unit)
        elif ch in VOW:
            units.append([VOW[ch], False])
        elif ch in (ANUS, CANDRA):
            units.append(["~n", False])
        elif ch == VISARGA:
            units.append(["h", False])
        else:
            units.append([ch.translate(DIGITS_DEV), False])
        i += 1
    # schwa deletion: final consonant; V C(a) C V -> drop the middle a
    cons_idx = [k for k, u in enumerate(units) if u[1]]
    if units and units[-1][1] and len(units) > 1:
        units[-1][1] = False
    def voweled(u):
        return u[1] or bool(u[0]) and u[0][-1] in "aeiou"
    for k in reversed(cons_idx):  # right to left, so each deletion sees the result of the next one
        if 0 < k < len(units) - 1 and units[k][1]:
            prev, nxt = units[k - 1], units[k + 1]
            if voweled(prev) and nxt[0] != "~n" and voweled(nxt) and nxt[0][:1] not in "aeiou":
                units[k][1] = False
    out = ""
    for k, (lat, a) in enumerate(units):
        if lat == "~n":
            nxt = units[k + 1][0] if k + 1 < len(units) else ""
            out += "m" if nxt[:1] in LABIAL else "n"
            continue
        out += lat + ("a" if a else "")
    out = re.sub(r"aa$", "a", out)
    return re.sub(r"ee$", "i", out)


def hinglish(text: str, title_case: bool = True) -> str:
    """Devanagari (and mixed) text -> Hinglish. Latin runs pass through unchanged."""
    if not re.search(r"[ऀ-ॿ]", text or ""):
        return text or ""
    parts = re.split(r"([ऀ-ॿ]+)", text.replace("।", ".").replace("॥", "."))
    out = []
    for p in parts:
        if p and re.fullmatch(r"[ऀ-ॿ]+", p):
            w = _word(p)
            out.append(w[:1].upper() + w[1:] if title_case and w else w)
        else:
            out.append(p.translate(DIGITS_DEV))
    return "".join(out)


def odia_digits(s: str) -> str:
    return (s or "").translate(TO_ODIA)
