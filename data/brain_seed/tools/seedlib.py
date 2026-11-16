"""Shared loaders for the Viku Brain seed builder.

Sources (read-only):
  BTF  = "Before the Foundation" (Odia + Hindi), cues in absolute source seconds.
  SALV = "Salvation" (Odia), full-video IndicConformer SRT.
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEED = HERE.parent  # data/brain_seed

BTF_WORK = Path(r"C:\Users\vinit\Downloads\Before the Foundation reels\_work")
SALV_SRT = Path(r"C:\Users\vinit\Downloads\Salvation _ ପରିତ୍ରାଣ _ Pastor Jacob Deep _ Sunday Service Live _ TAPP Church Hirakud.or.srt")
AIVE = Path(r"C:\Users\vinit\Documents\Claude\Projects\AI Video Editing")

SERMONS = {
    "btf": "Before the Foundation (Pastor Jacob Deep, TAPP Church Hirakud)",
    "salvation": "Salvation / ପରିତ୍ରାଣ (Pastor Jacob Deep, TAPP Church Hirakud)",
}


def _ts(s):
    h, m, rest = s.strip().split(":")
    sec, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000.0


def load_srt(path):
    txt = Path(path).read_text(encoding="utf-8-sig")
    out = []
    for block in re.split(r"\r?\n\r?\n", txt.strip()):
        lines = [l for l in block.splitlines() if l.strip()]
        if len(lines) < 2:
            continue
        i = 1 if "-->" in lines[1] else 0
        if "-->" not in lines[i]:
            continue
        a, b = lines[i].split("-->")
        out.append([round(_ts(a), 2), round(_ts(b), 2), " ".join(lines[i + 1:]).strip()])
    return out


def load_cues(sermon):
    """Return (odia_cues, hindi_cues_or_None). Each cue = [start, end, text]."""
    if sermon == "btf":
        or_c = json.loads((BTF_WORK / "cues_abs.json").read_text(encoding="utf-8"))
        hi_c = json.loads((BTF_WORK / "cues_hi_abs.json").read_text(encoding="utf-8"))
        return or_c, hi_c
    if sermon == "salvation":
        return load_srt(SALV_SRT), None
    raise KeyError(sermon)


# ---------------------------------------------------------------- language id
# Hindi function words as they come out of the HINDI ASR (Devanagari).
HI_DEV = set("""है हैं था थे थी के की का में से और नहीं नही हम आप तो कि को जो भी कर रहा रहे रही हो ये वो यह वह
क्या कैसे लिए पर जब तब सकते सकता सकती गया गए दिया करते करता होता होते हमारे आपको हमें उनको उसको उसका उसके
इसलिए लेकिन किंतु क्योंकि अगर मैं मुझे मेरा मेरे हमारा आपका आपके बोल बोलते बोला जाता जाते जा कोई कुछ सब
अभी वहाँ यहाँ ऐसे वैसे बहुत ज्यादा""".split())
# Hindi words as they come out of the ODIA ASR (Hindi speech transliterated into Odia script).
HI_ODIA = set("""ହେ ହୈ ହଁ ଥା ଥେ ଥୀ କେ ମେ ମେଁ ହମ ଆପ ଆପକୋ ହମେ ନହି ନହୀ ଔର ଯବ ତବ କୁଛ କୁଚ କ୍ୟା କ୍ୟୋ କ୍ୟୁଁ ଉସ ଇସ ଲିଏ ଲିୟେ
ହୋତା ହୋତେ ରହା ରହେ କିୟା କିଆ ଗ୍ୟା ଗୟା ଜାତା ଜାତେ ସକତେ ସକତା ସକେଗେ ଏକ୍ଦମ ବୋଲତେ ବୋଲା ମୈ ମୈଂ ମୁଝେ ମେରା ମେରେ ହମାରା ହମାରେ
ଆପକା ଆପକେ କୋ କୋଈ ଲେକିନ କିଉଁକି ଅଗର ଯୋ ଭି ଭୀ ସବ ସବକୋ ବହୁତ ଅଭି ଅଭୀ ୱୋ ୱହ ଯେହ ଐସେ ଦିୟା ପତା""".split())
# Odia function words (Odia ASR).
OR_WORDS = set("""ଏବଂ ଆମେ ଆମର ଆମକୁ ଯେତେବେଳେ ସେତେବେଳେ କଣ କ'ଣ ଅଛି ଅଛନ୍ତି ନାହିଁ ନାହାନ୍ତି ପାଇଁ ହେଲା ହେଲେ କରି କରିବା କରନ୍ତି ଯଦି ତାହେଲେ
ଆପଣ ଆପଣଙ୍କ ଆପଣଙ୍କୁ ଆପଣମାନେ ମୁଁ ଏହି ଏଇ ଯେ ଥିଲା ଥିଲେ ଦେଖିବା ଦେଖୁଛୁ ଦେଖୁଅଛୁ ତାହା ସେହି କିନ୍ତୁ ଆଉ ତ ମାନେ କୁହାଯାଏ ଲେଖା
ଯାଇଛି ହୋଇ ହେଇ ହେଇଛି ହୋଇଛି ଗୋଟେ ଗୋଟିଏ ପ୍ରଭୁଙ୍କ ପ୍ରଭୁଙ୍କର ତାଙ୍କର ତାଙ୍କୁ ଯୋଉ ଯେଉଁ କେତେ ସମସ୍ତେ ତୁମେ ତୁମର ମୋତେ ମୋର
ଭାବରେ ବିଷୟରେ ବିଷୟ ଜାଣିଛନ୍ତି ପାରିବା ପାରିବେ ନୁହେଁ ହିଁ ବି ମଧ୍ୟ""".split())

_tok = re.compile(r"[\u0B00-\u0B7F\u0900-\u097F']+")


def tokens(text):
    return _tok.findall(text)


def hi_score_dev(text):
    t = tokens(text)
    if not t:
        return 0.0
    return sum(1 for w in t if w in HI_DEV) / len(t)


def odia_script_scores(text):
    t = tokens(text)
    if not t:
        return 0.0, 0.0
    h = sum(1 for w in t if w in HI_ODIA) / len(t)
    o = sum(1 for w in t if w in OR_WORDS) / len(t)
    return h, o


def cue_lang(or_text, hi_text=None):
    """'hi' or 'or' for one cue (or a short run of cues)."""
    h, o = odia_script_scores(or_text)
    d = hi_score_dev(hi_text) if hi_text is not None else None
    score = h - o
    if d is not None:
        # Hindi ASR on real Hindi speech is dense with function words (~0.35+);
        # on Odia speech it is garbage with few of them (~0.1).
        score += (d - 0.18) * 1.5
    return "hi" if score > 0.02 else "or"
