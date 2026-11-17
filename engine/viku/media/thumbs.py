"""Thumbnail designer (offline): 1080x1920 reel thumbnails in 12 styles (port of make_thumbs.py).

    make(rid, job, style=None, pose_t=None, title=None, sub=None, verse=None, out=None, renderer=None) -> dict

- Text by reel language: Odia reel -> Odia, Hindi reel -> Hinglish (translit.hinglish of the Devanagari title
  unless a Latin title is given), English -> English. Fonts: Noto Sans / Oriya / Devanagari (OFL, <data>/fonts).
- Background: the reel's first cutaway image that exists, else a blurred frame of the speaker.
- Pastor: offline U²-Net cut-out (media/cutout.py) from the full-res source frame at pose_t (reel seconds,
  mapped to source seconds through the reel's segments). pose_t None -> auto: speaker-only times scored by
  YuNet confidence x face size x frontal symmetry x eyes open x sharpness.
- Renderer: headless Chrome / Edge (HTML + CSS, text fitted by a tiny script) -> PNG -> JPG; fallback without
  a browser (or env VIKU_THUMB_RENDERER=pillow / renderer="pillow"): Pillow composite (background, shade,
  cut-out) + text through ffmpeg's libass (Pillow here has no raqm, so it cannot shape Odia itself).
- style None -> auto_style(): a style not used by the previous reel (and preferably by no other reel).
"""
from __future__ import annotations

import hashlib
import html
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from string import Template
from urllib.parse import quote

import cv2
import numpy as np

from .. import config, projects
from ..jobs import JobError
from . import assets_setup, cutout, ff
from .translit import hinglish, odia_digits

W, H = 1080, 1920
GOLD = "#FFD24A"
BOOK = ("<svg viewBox='0 0 24 24' style='width:1em;height:1em;vertical-align:-0.15em;margin-right:.35em'>"
        "<path fill='currentColor' d='M1.5 5.2C4.6 3.6 8 3.7 11.2 5.6V20c-3.2-1.8-6.6-1.9-9.7-.4zM12.8 5.6c3.2-1.9 "
        "6.6-2 9.7-.4v14.4c-3.1-1.5-6.5-1.4-9.7.4z'/></svg>")

# ----------------------------------------------------------------- styles --
# pastor: top / height of the cut-out and where his face centre lands (x); z = stacking order.
# fb: fallback (Pillow + libass) layout - title alignment (7 left, 8 centre, 9 right) + top, sub top,
#     credit alignment, credit top, darken.
STYLES: dict[str, dict] = {}


def _style(name, label, css, body, pastor, fb, case="none"):
    STYLES[name] = {"label": label, "css": css, "body": body, "pastor": pastor, "fb": fb, "case": case}


_style("golden-hour", "Golden hour: centred title, pastor right", """
.sh{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.72) 0%,rgba(0,0,0,.25) 38%,rgba(0,0,0,0) 55%,rgba(0,0,0,.55) 78%,rgba(0,0,0,.92) 100%)}
.t{top:230px;left:50px;right:50px;text-align:center;font-size:128px;line-height:1.14;color:#fff}
.s{top:575px;left:40px;right:40px;text-align:center;font-size:48px}
""", """$BG<div class='sh'></div>
<div class='abs t shadow' data-fit='330'>$T1<br><span class='g'>$T2</span></div>
<div class='abs s' data-fit='120'>$SUB</div>
$PASTOR
<div class='abs v' style='left:60px;top:1395px'>$VERSE</div>
$CREDIT_L(60,1495)""", {"top": 760, "h": 880, "fx": 730}, {"al": 8, "tt": 230, "st": 600, "ca": 1, "ct": 1500})

_style("spotlight", "Spotlight: gold glow behind a centred pastor, title band", """
.bg{filter:brightness(.55) saturate(1.1)}
.glow{position:absolute;left:90px;top:640px;width:900px;height:900px;border-radius:50%;background:radial-gradient(circle,rgba(255,200,80,.55) 0%,rgba(255,170,40,.18) 45%,rgba(0,0,0,0) 70%)}
.band{position:absolute;left:0;right:0;top:190px;height:540px;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.72) 20%,rgba(0,0,0,.72) 80%,rgba(0,0,0,0))}
.t{top:255px;left:40px;right:40px;text-align:center;font-size:124px;line-height:1.14;color:#fff}
.s{top:590px;left:40px;right:40px;text-align:center;font-size:46px}
.foot{position:absolute;left:0;right:0;bottom:0;height:560px;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.93))}
""", """$BG<div class='glow'></div><div class='band'></div>
$PASTOR<div class='foot'></div>
<div class='abs t shadow' data-fit='320'>$T1<br><span class='g'>$T2</span></div>
<div class='abs s' data-fit='110'>$SUB</div>
<div class='abs v' style='left:0;right:0;top:1420px;text-align:center'>$VERSE</div>
$CREDIT_C(1515)""", {"top": 730, "h": 900, "fx": 540}, {"al": 8, "tt": 260, "st": 600, "ca": 2, "ct": 1515, "dark": .45})

_style("split-panel", "Split: teal title panel with a diagonal gold edge, pastor left", """
.bg{background-position:center 70%}
.panel{position:absolute;left:0;right:0;top:0;height:800px;background:linear-gradient(160deg,#0E3B43,#082228);clip-path:polygon(0 0,100% 0,100% 82%,0 100%)}
.line{position:absolute;left:0;right:0;top:0;height:806px;background:$GOLD;clip-path:polygon(0 99%,100% 81%,100% 82.5%,0 100%)}
.t{top:240px;left:60px;right:60px;font-size:112px;line-height:1.14;color:#fff}
.s{top:560px;left:60px;right:60px;font-size:44px;color:#d8efe9}
.foot{position:absolute;left:0;right:0;bottom:0;height:560px;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.9))}
""", """$BG<div class='panel'></div><div class='line'></div>
$PASTOR<div class='foot'></div>
<div class='abs t shadow' data-fit='300'>$T1<br><span class='g'>$T2</span></div>
<div class='abs s' data-fit='110'>$SUBPLAIN</div>
<div class='abs v' style='right:60px;top:1415px;text-align:right'>$VERSE</div>
$CREDIT_R(60,1515)""", {"top": 830, "h": 870, "fx": 380}, {"al": 7, "tt": 240, "st": 560, "ca": 3, "ct": 1515, "panel": "#0E3B43"})

_style("bold-outline", "Bold: big outlined title left with a gold bar, pastor right", """
.sh{position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.7) 0%,rgba(0,0,0,.25) 55%,rgba(0,0,0,0) 75%),linear-gradient(180deg,rgba(0,0,0,.35) 0%,rgba(0,0,0,0) 40%,rgba(0,0,0,.88) 100%)}
.t{top:230px;left:55px;right:40px;font-size:146px;line-height:1.1;color:#fff;-webkit-text-stroke:5px #111;paint-order:stroke fill}
.bar{display:inline-block;background:$GOLD;color:#111;-webkit-text-stroke:0;padding:0 18px;border-radius:10px;transform:rotate(-2deg)}
.s{top:640px;left:58px;right:40px;font-size:50px;color:#fff}
""", """$BG<div class='sh'></div>
$PASTOR
<div class='abs t' data-fit='380'>$T1<br><span class='bar'>$T2</span></div>
<div class='abs s shadow' data-fit='120'>$SUBPLAIN</div>
<div class='abs v' style='left:58px;top:1395px'>$VERSE</div>
$CREDIT_L(58,1495)""", {"top": 720, "h": 940, "fx": 760}, {"al": 7, "tt": 230, "st": 650, "ca": 1, "ct": 1495},
       case="upper")

_style("letterbox", "Cinematic letterbox, thin gold rules around the title", """
.bg{background-position:center 40%}
.sh{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.55) 0%,rgba(0,0,0,.15) 40%,rgba(0,0,0,.2) 60%,rgba(0,0,0,.92) 100%)}
.lb{position:absolute;left:0;right:0;height:170px;background:#000}
.frame{top:250px;left:80px;right:80px;border-top:3px solid $GOLD;border-bottom:3px solid $GOLD;padding:30px 0 26px;text-align:center}
.t{font-size:112px;line-height:1.14;color:#fff}
.s{margin-top:10px;font-size:46px;color:$GOLD}
""", """$BG<div class='sh'></div><div class='lb' style='top:0'></div><div class='lb' style='bottom:0'></div>
<div class='abs frame'><div class='t shadow' data-fit='280'>$T1<br><span class='g'>$T2</span></div>
<div class='s shadow' data-fit='70'>$SUBPLAIN</div></div>
$PASTOR
<div class='abs v' style='left:0;right:0;top:1420px;text-align:center'>$VERSE</div>
$CREDIT_C(1515)""", {"top": 840, "h": 820, "fx": 540}, {"al": 8, "tt": 280, "st": 600, "ca": 2, "ct": 1515, "bars": 1})

_style("poster", "Poster: huge stacked title, pastor in front of the letters", """
.bg{filter:brightness(.75) blur(14px) saturate(1.2)}
.sh{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.5),rgba(0,0,0,.1) 45%,rgba(0,0,0,.92) 100%)}
.t{top:215px;left:20px;right:20px;text-align:center;font-size:190px;line-height:1.02;color:#fff;letter-spacing:-2px;text-shadow:0 8px 30px rgba(0,0,0,.6)}
.s{top:1350px;left:40px;right:40px;text-align:center;font-size:44px;z-index:3}
""", """$BG<div class='sh'></div>
<div class='abs t' data-fit='620'>$T1<br><span class='g'>$T2</span></div>
$PASTOR
<div class='abs s' data-fit='110'>$SUB</div>
<div class='abs v' style='left:0;right:0;top:1445px;text-align:center;z-index:3'>$VERSE</div>
$CREDIT_C(1535)""", {"top": 860, "h": 820, "fx": 540, "z": 2}, {"al": 8, "tt": 215, "st": 1350, "ca": 2, "ct": 1535},
       case="upper")

_style("storybook", "Storybook: inset white frame, round gold portrait", """
.sh{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,rgba(0,0,0,0) 40%,rgba(0,0,0,.65) 100%),linear-gradient(180deg,rgba(0,0,0,.62),rgba(0,0,0,0) 40%,rgba(0,0,0,.78) 100%)}
.frame{position:absolute;inset:34px;border:6px solid rgba(255,255,255,.9);border-radius:46px}
.badge{top:200px;right:90px;background:$GOLD;color:#111;font-size:40px;padding:8px 26px;border-radius:16px;transform:rotate(5deg)}
.t{top:280px;left:70px;right:70px;font-size:116px;line-height:1.08;color:#fff}
.s{top:560px;left:72px;right:60px;font-size:44px}
.circ{position:absolute;right:70px;top:930px;width:580px;height:580px;border-radius:50%;border:10px solid $GOLD;overflow:hidden;background:radial-gradient(circle,#2f6f73,#0E3B43);box-shadow:0 12px 40px rgba(0,0,0,.6)}
""", """$BG<div class='sh'></div><div class='frame'></div>
$BADGE
<div class='abs t shadow' data-fit='270'>$T1<br><span class='g'>$T2</span></div>
<div class='abs s' data-fit='110'>$SUB</div>
<div class='circ'>$PASTOR</div>
$CREDIT_L(80,1545)""", {"top": 40, "h": 760, "fx": 290, "circle": 1}, {"al": 7, "tt": 280, "st": 570, "ca": 1, "ct": 1545})

_style("gallery", "Gallery: gilded border, italic title, pastor left", """
.bg{background-position:center 45%}
.sh{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.66),rgba(0,0,0,.05) 42%,rgba(0,0,0,.25) 60%,rgba(0,0,0,.93) 100%)}
.gild{position:absolute;inset:22px;border:14px solid transparent;border-image:linear-gradient(135deg,#8a6a1f,#ffe08a,#b8892a,#fff0b0,#8a6a1f) 1;box-shadow:inset 0 0 0 4px rgba(0,0,0,.5)}
.badge{top:205px;left:0;right:0;text-align:center;color:$GOLD;font-size:36px;letter-spacing:8px}
.t{top:270px;left:60px;right:60px;text-align:center;font-style:italic;font-size:120px;line-height:1.1;color:#fff}
.s{top:580px;left:60px;right:60px;text-align:center;font-style:italic;font-size:46px;color:#f3e6c4}
""", """$BG<div class='sh'></div><div class='gild'></div>
<div class='abs badge shadow'>— $CHURCH —</div>
<div class='abs t shadow' data-fit='300'><span class='g'>$T1</span><br>$T2</div>
<div class='abs s shadow' data-fit='70'>$SUBPLAIN</div>
$PASTOR
<div class='abs v' style='right:70px;top:1420px;text-align:right'>$VERSE</div>
$CREDIT_R(70,1520)""", {"top": 770, "h": 890, "fx": 360}, {"al": 8, "tt": 270, "st": 590, "ca": 3, "ct": 1520})

_style("victory-ribbon", "Victory: diagonal gold ribbon carries the punchline", """
.sh{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.58),rgba(0,0,0,0) 40%,rgba(0,0,0,.9) 100%)}
.ribbon{position:absolute;left:-60px;right:-60px;top:340px;height:240px;background:linear-gradient(90deg,#c8941e,$GOLD,#ffe9a3,$GOLD,#c8941e);transform:rotate(-5deg);box-shadow:0 14px 40px rgba(0,0,0,.55)}
.t1{top:205px;left:70px;right:60px;font-size:100px;line-height:1.15;color:#fff}
.t2{top:385px;left:40px;right:40px;text-align:center;font-size:104px;line-height:1.2;color:#151515;transform:rotate(-5deg)}
.s{top:650px;left:70px;right:60px;font-size:46px}
""", """$BG<div class='sh'></div>
<div class='abs t1 shadow' data-fit='130'>$T1</div>
<div class='ribbon'></div><div class='abs t2' data-fit='150'>$T2</div>
<div class='abs s' data-fit='110'>$SUB</div>
$PASTOR
<div class='abs v' style='left:70px;top:1420px'>$VERSE</div>
$CREDIT_L(70,1520)""", {"top": 770, "h": 890, "fx": 740}, {"al": 7, "tt": 215, "st": 660, "ca": 1, "ct": 1520},
       case="upper")

_style("prayer-halo", "Prayer: soft light halo, glowing italic title", """
.sh{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 18%,rgba(255,235,190,.35),rgba(0,0,0,0) 45%),linear-gradient(180deg,rgba(0,0,0,.48),rgba(0,0,0,.1) 40%,rgba(0,0,0,.9) 100%)}
.halo{position:absolute;left:140px;top:780px;width:800px;height:800px;border-radius:50%;background:radial-gradient(circle,rgba(255,240,200,.45),rgba(255,240,200,0) 65%)}
.t{top:255px;left:40px;right:40px;text-align:center;font-style:italic;font-size:128px;line-height:1.1;color:#fff;text-shadow:0 0 30px rgba(255,230,170,.6),0 6px 18px rgba(0,0,0,.7)}
.s{top:580px;left:40px;right:40px;text-align:center;font-style:italic;font-size:44px;color:#fff3d6}
""", """$BG<div class='sh'></div><div class='halo'></div>
<div class='abs t' data-fit='310'><span class='g'>$T1</span><br>$T2</div>
<div class='abs s shadow' data-fit='110'>$SUBPLAIN</div>
$PASTOR
<div class='abs v' style='left:0;right:0;top:1440px;text-align:center'>$VERSE</div>
$CREDIT_C(1530)""", {"top": 800, "h": 860, "fx": 540, "glow": 1}, {"al": 8, "tt": 260, "st": 590, "ca": 2, "ct": 1530})

_style("rays-slab", "Victory rays: light rays, title on a gold slab", """
.bg{background-position:center 40%}
.rays{position:absolute;inset:0;background:repeating-conic-gradient(from 0deg at 50% 30%,rgba(255,220,120,.16) 0deg 6deg,rgba(255,220,120,0) 6deg 18deg);mix-blend-mode:screen}
.sh{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.62) 0%,rgba(0,0,0,.15) 36%,rgba(0,0,0,.1) 55%,rgba(0,0,0,.93) 100%)}
.t1{top:200px;left:40px;right:40px;text-align:center;font-size:140px;line-height:1.15;color:#fff}
.slab{position:absolute;left:60px;right:60px;top:405px;height:200px;background:linear-gradient(180deg,#ffe58f,$GOLD 55%,#d99b1c);border-radius:22px;box-shadow:0 16px 40px rgba(0,0,0,.55)}
.t2{top:405px;left:80px;right:80px;height:200px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:124px;line-height:1.1;color:#1a1206}
.s{top:650px;left:40px;right:40px;text-align:center;font-size:46px}
""", """$BG<div class='rays'></div><div class='sh'></div>
<div class='abs t1 shadow' data-fit='190'>$T1</div>
<div class='slab'></div><div class='abs t2' data-fit='200'>$T2</div>
<div class='abs s' data-fit='110'>$SUB</div>
$PASTOR
<div class='abs v' style='left:0;right:0;top:1440px;text-align:center'>$VERSE</div>
$CREDIT_C(1530)""", {"top": 790, "h": 860, "fx": 540}, {"al": 8, "tt": 210, "st": 660, "ca": 2, "ct": 1530})

_style("vine-poster", "Poster: bold outlined title top-left, pastor right", """
.bg{background-position:center 35%}
.sh{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.62) 0%,rgba(0,0,0,.1) 30%,rgba(0,0,0,.2) 50%,rgba(0,0,0,.94) 88%)}
.t{top:215px;left:60px;right:50px;font-size:150px;line-height:1.04;color:#fff;-webkit-text-stroke:6px #111;paint-order:stroke fill;text-shadow:0 10px 30px rgba(0,0,0,.6)}
.s{top:560px;left:62px;right:50px;font-size:46px}
""", """$BG<div class='sh'></div>
<div class='abs t' data-fit='330'>$T1<br><span class='g'>$T2</span></div>
<div class='abs s' data-fit='110'>$SUB</div>
$PASTOR
<div class='abs v' style='left:62px;top:1400px'>$VERSE</div>
$CREDIT_L(62,1500)""", {"top": 790, "h": 880, "fx": 760}, {"al": 7, "tt": 215, "st": 570, "ca": 1, "ct": 1500},
       case="upper")

STYLE_ORDER = list(STYLES)

BASE_CSS = """
@font-face{font-family:VLa;src:url('$fLa');font-weight:700}
@font-face{font-family:VOr;src:url('$fOr');font-weight:700}
@font-face{font-family:VDe;src:url('$fDe');font-weight:700}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1920px;overflow:hidden;background:#000}
body{font-family:VLa,VOr,VDe,sans-serif;font-weight:700}
.abs{position:absolute}
.bg{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.13);transform-origin:50% 35%}
.g{color:$GOLD}
.shadow{text-shadow:0 6px 20px rgba(0,0,0,.8),0 2px 4px rgba(0,0,0,.9)}
.t,.t1,.t2,.s,.v{white-space:nowrap}
.pill{display:inline-block;white-space:nowrap;background:rgba(0,0,0,.6);border-radius:40px;padding:14px 34px;color:#fff}
.vpill{display:inline-block;background:rgba(0,0,0,.62);border:2px solid $GOLD;border-radius:34px;padding:10px 30px;color:$GOLD;font-size:40px}
.credit .n{font-size:58px;color:#fff;letter-spacing:1px;line-height:1.1}
.credit .c{font-size:38px;color:$GOLD;line-height:1.25}
.pastor{position:absolute;filter:drop-shadow(0 0 28px rgba(0,0,0,.55));-webkit-mask-image:linear-gradient(180deg,#000 82%,transparent 100%)}
.upper .t,.upper .t1,.upper .t2{text-transform:uppercase}
"""
FIT_JS = """<script>
(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){
 document.querySelectorAll('[data-fit]').forEach(function(e){
  var mh=+e.dataset.fit, s=parseFloat(getComputedStyle(e).fontSize), n=0;
  while((e.scrollWidth>e.clientWidth+2||e.offsetHeight>mh)&&s>22&&n<80){s*=0.95;e.style.fontSize=s+'px';n++;}
 });
 document.body.setAttribute('data-done','1');
});
</script>"""


# ------------------------------------------------------------------ text --
def furl(p) -> str:
    return "file:///" + quote(str(Path(p).resolve()).replace("\\", "/"), safe="/:")


def clean_title(t: str) -> str:
    t = re.sub(r"[…\.\!\?।,;:]+$", "", (t or "").strip()).strip()
    w = t.split()
    return " ".join(w[:6])


def split2(t: str) -> tuple[str, str]:
    """Title -> (first line, last line) balanced by characters; the last line is the highlighted one."""
    w = t.split()
    if len(w) <= 1:
        return "", t
    best, bk = 10 ** 9, len(w) - 1
    for k in range(1, len(w)):
        a, b = " ".join(w[:k]), " ".join(w[k:])
        d = abs(len(a) - len(b))
        if d < best:
            best, bk = d, k
    return " ".join(w[:bk]), " ".join(w[bk:])


def has_dev(s: str) -> bool:
    return bool(re.search(r"[ऀ-ॿ]", s or ""))


def localize(s: str, lang: str) -> str:
    return hinglish(s) if lang == "hi" and has_dev(s) else (s or "")


def verse_label(r: dict, lang: str, given: str | None, texts: list[str]) -> str:
    if given:
        return given
    ref_en, native = None, None
    for v in r.get("verses") or []:
        dr = v.get("ref") or ""
        if dr:
            parts = [x.strip() for x in dr.split("·")]
            native, ref_en = parts[0], parts[-1]
            break
    if not ref_en:
        try:
            from ..brain import scripture
            for t in texts:
                refs = scripture.find_refs(t or "")
                if refs:
                    ref_en = refs[0]
                    break
        except Exception:  # noqa: BLE001
            ref_en = None
    if not ref_en:
        return ""
    if lang == "en":
        return ref_en
    if not native or native == ref_en:
        try:
            from .. import bible
            native = bible.verse(ref_en, lang)["ref_native"]
        except Exception:  # noqa: BLE001
            native = ref_en
    if lang == "or":
        return odia_digits(native)
    return hinglish(native)


# ----------------------------------------------------------------- frames --
def src_time(r: dict, t: float) -> float:
    """Reel seconds -> absolute source seconds through the play-order segments."""
    acc = 0.0
    segs = r.get("segments") or []
    for s, e in segs:
        if t < acc + (e - s) or (s, e) == tuple(segs[-1]):
            return float(s + min(max(t - acc, 0.0), e - s - 0.04))
        acc += e - s
    return float(segs[0][0]) if segs else t


def speaker_times(r: dict, step: float = 0.5) -> list[float]:
    dur = float(r.get("duration") or sum(e - s for s, e in r.get("segments") or []))
    cuts = r.get("cutaways") or []
    out, t = [], 0.6
    while t < dur - 0.6:
        if not any(c["t0"] - 0.45 <= t <= c["t1"] + 0.45 for c in cuts):
            out.append(round(t, 2))
        t += step
    return out or [round(dur / 3, 2)]


def auto_pose(r: dict, job, step: float = 0.5) -> tuple[float, dict]:
    """Best speaker-only time of the reel by cutout.pose_score (reads the joined 1280x720 reel source)."""
    times = speaker_times(r, step)
    src = r.get("src")
    best = (-1.0, times[len(times) // 3], {})
    if src and Path(src).exists():
        sw, sh = 1280, 720
        p = job.popen([ff.ffmpeg(), "-nostdin", "-loglevel", "error", "-i", src, "-vf",
                       f"fps={1 / step},scale={sw}:{sh}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        tset = {round(t, 2) for t in times}
        n, i = sw * sh * 3, 0
        try:
            while True:
                b = p.stdout.read(n)
                if len(b) < n:
                    break
                t = round(i * step + step / 2, 2)  # fps filter samples the middle of each interval
                i += 1
                near = min(tset, key=lambda x: abs(x - t)) if tset else t
                if abs(near - t) > step / 2 + 1e-3:
                    continue
                f = np.frombuffer(b, np.uint8).reshape(sh, sw, 3)
                sc, info = cutout.pose_score(f)
                if sc > best[0]:
                    best = (sc, t, info)
                if i % 10 == 0:
                    job.check()
                    job.update(0.05 + 0.25 * min(i * step / max(times[-1], 1), 1), "thumbnail: choosing a pose")
            p.wait()
        finally:
            job.release(p)
    return best[1], best[2] | {"score": round(best[0], 3)}


def grab(video: str, t: float, out: Path, job) -> np.ndarray:
    ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1",
            str(out)], job=job)
    img = cv2.imdecode(np.fromfile(str(out), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise JobError(f"could not read a frame at {t:.2f}s from {video}")
    return img


# --------------------------------------------------------------- browser --
def find_browser() -> str:
    env = os.environ.get("VIKU_BROWSER")
    if env and Path(env).exists():
        return env
    roots = [os.environ.get(k) for k in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
    rels = [r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe",
            r"Chromium\Application\chrome.exe", r"BraveSoftware\Brave-Browser\Application\brave.exe"]
    for rel in rels:
        for root in roots:
            if root and (Path(root) / rel).exists():
                return str(Path(root) / rel)
    for name in ("chrome", "msedge", "chromium", "google-chrome"):
        p = shutil.which(name)
        if p:
            return p
    return ""


def render_browser(html_path: Path, png: Path, job) -> None:
    exe = find_browser()
    if not exe:
        raise JobError("no Chrome / Edge found")
    prof = Path(tempfile.mkdtemp(prefix="viku-thumb-"))
    try:
        job.run([exe, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                 "--no-default-browser-check", "--allow-file-access-from-files", f"--user-data-dir={prof}",
                 "--force-device-scale-factor=1", "--window-size=1080,1920", "--virtual-time-budget=6000",
                 f"--screenshot={png}", furl(html_path)], timeout=120)
    finally:
        shutil.rmtree(prof, ignore_errors=True)
    if not png.exists():
        raise JobError("browser did not write the screenshot")


# ----------------------------------------------------------------- layout --
def pastor_tag(cut_size, face, spec) -> str:
    cw, ch = cut_size
    hgt = spec["h"]
    k = hgt / ch
    fcx = (face[0] + face[2] / 2) * k if face else cw * k / 2
    left = spec["fx"] - fcx
    if spec.get("circle"):
        fcy = (face[1] + face[3] / 2) * k if face else hgt * 0.25
        top = 290 - fcy  # face centre ~ 290 px into the 580 px circle (head + shoulders)
        return (f"<img class='pastor' src='$bust' style='left:{left:.0f}px;top:{top:.0f}px;height:{hgt}px;"
                f"filter:none;-webkit-mask-image:none'>")
    z = f"z-index:{spec['z']};" if spec.get("z") else ""
    glow = "filter:drop-shadow(0 0 30px rgba(255,235,190,.45));" if spec.get("glow") else ""
    top = max(spec["top"], 1735 - hgt)  # bust bottom (faded) sits just under the credit
    return f"<img class='pastor' src='$bust' style='left:{left:.0f}px;top:{top}px;height:{hgt}px;{z}{glow}'>"


def credit_parts(lang: str) -> tuple[str, str]:
    st = config.settings()
    line = st.get("credit_line") or ""
    parts = [x.strip() for x in re.split(r"[·|•]", line) if x.strip()]
    name = parts[0] if parts else ""
    church = parts[1] if len(parts) > 1 else (st.get("church_name") or "")
    return name, localize(church, lang)


def build_html(style: str, ctx: dict) -> str:
    s = STYLES[style]
    e = html.escape
    t1, t2 = ctx["t1"], ctx["t2"]
    sub = e(ctx["sub"])
    verse = f"<span class='vpill'>{BOOK}{e(ctx['verse'])}</span>" if ctx["verse"] else ""
    name, church = e(ctx["name"]), e(ctx["church"])

    def credit(align, pos):
        return (f"<div class='abs credit shadow' style='text-align:{align};{pos};z-index:3'>"
                f"<div class='n'>{name}</div><div class='c'>{church}</div></div>")
    body = s["body"]
    body = re.sub(r"\$CREDIT_L\((\d+),(\d+)\)", lambda m: credit("left", f"left:{m[1]}px;top:{m[2]}px"), body)
    body = re.sub(r"\$CREDIT_R\((\d+),(\d+)\)", lambda m: credit("right", f"right:{m[1]}px;top:{m[2]}px"), body)
    body = re.sub(r"\$CREDIT_C\((\d+)\)", lambda m: credit("center", f"left:0;right:0;top:{m[1]}px"), body)
    badge = f"<div class='abs badge'>{e(ctx['verse'])}</div>" if ctx["verse"] else ""
    if style == "storybook":
        verse = ""
    body = Template(body).safe_substitute(
        BG=f"<div class='bg' style=\"background-image:url('{ctx['bg']}')\"></div>",
        PASTOR=Template(ctx["pastor"]).safe_substitute(bust=ctx["bust"]),
        T1=e(t1), T2=e(t2), SUB=f"<span class='pill'>{sub}</span>" if sub else "", SUBPLAIN=sub,
        VERSE=verse, BADGE=badge, CHURCH=church)
    css = Template(BASE_CSS + s["css"]).safe_substitute(GOLD=GOLD, **ctx["fonts"])
    cls = "upper" if s.get("case") == "upper" and ctx["lang"] != "or" else ""
    return (f"<!doctype html><html><head><meta charset='utf-8'><style>{css}</style></head>"
            f"<body class='{cls}'>{body}{FIT_JS}</body></html>")


# --------------------------------------------------------------- fallback --
def _ass_color(hexs: str) -> str:
    h = hexs.lstrip("#")
    return f"&H00{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def render_fallback(style: str, ctx: dict, bg_img: np.ndarray, cut: np.ndarray, png_out: Path, wd: Path, job):
    """No browser: Pillow composite (background + shade + cut-out) and libass text (Noto fonts)."""
    from PIL import Image, ImageFilter
    s = STYLES[style]
    fb = s["fb"]
    bh, bw = bg_img.shape[:2]
    k = max(W / bw, H / bh) * 1.08
    bgr = cv2.resize(bg_img, (int(bw * k + 1), int(bh * k + 1)), interpolation=cv2.INTER_AREA)
    y0 = (bgr.shape[0] - H) // 3
    x0 = (bgr.shape[1] - W) // 2
    canvas = Image.fromarray(cv2.cvtColor(bgr[y0:y0 + H, x0:x0 + W], cv2.COLOR_BGR2RGB)).convert("RGBA")
    if style == "poster":
        canvas = canvas.filter(ImageFilter.GaussianBlur(14))
    y = np.arange(H, dtype=np.float32)[:, None]
    a = np.maximum(np.clip(1 - y / 620, 0, 1) * 0.7, np.clip((y - 1150) / 600, 0, 1) * 0.92) + fb.get("dark", 0) * 0.5
    shade = np.zeros((H, W, 4), np.uint8)
    shade[..., 3] = (np.clip(a, 0, 1) * 255).astype(np.uint8).repeat(W, 1)
    canvas = Image.alpha_composite(canvas, Image.fromarray(shade))
    if fb.get("panel"):
        hx = fb["panel"].lstrip("#")
        panel = Image.new("RGBA", (W, 760), tuple(int(hx[i:i + 2], 16) for i in (0, 2, 4)) + (235,))
        canvas.alpha_composite(panel, (0, 0))
    if fb.get("bars"):
        canvas.alpha_composite(Image.new("RGBA", (W, 170), (0, 0, 0, 255)), (0, 0))
    # pastor
    sp = s["pastor"]
    hgt = sp["h"] if not sp.get("circle") else 900
    ch, cw = cut.shape[:2]
    kk = hgt / ch
    im = Image.fromarray(cv2.cvtColor(cut, cv2.COLOR_BGRA2RGBA)).resize((max(int(cw * kk), 1), hgt), Image.LANCZOS)
    fx = ctx["face"]
    fcx = (fx[0] + fx[2] / 2) * kk if fx else im.width / 2
    face_x = sp["fx"] if not sp.get("circle") else 760
    top = sp["top"] if not sp.get("circle") else 760
    al = np.array(im)[..., 3].astype(np.float32)
    fade = np.clip((hgt - np.arange(hgt)) / (hgt * 0.18), 0, 1)[:, None]
    arr = np.array(im)
    arr[..., 3] = (al * fade).astype(np.uint8)
    canvas.alpha_composite(Image.fromarray(arr), (int(face_x - fcx), top)) if 0 else \
        canvas.paste(Image.fromarray(arr), (int(face_x - fcx), top), Image.fromarray(arr))
    if fb.get("bars"):
        canvas.alpha_composite(Image.new("RGBA", (W, 170), (0, 0, 0, 255)), (0, H - 170))
    base = wd / "fb_base.png"
    canvas.convert("RGB").save(base)
    # text via libass
    lang = ctx["lang"]
    fam = assets_setup.FAMILY.get(lang if lang == "or" else ("hi" if has_dev(ctx["t1"] + ctx["t2"]) else "en"))
    gold = _ass_color(GOLD)
    al_t = fb["al"]
    mlr = (60, 60)
    tsz = 128 if len(ctx["t1"] + ctx["t2"]) < 16 else (108 if len(ctx["t1"] + ctx["t2"]) < 26 else 88)
    ca = {1: 7, 2: 8, 3: 9}[fb["ca"]]
    hdr = ("[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
           "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
           "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
           "MarginL, MarginR, MarginV, Encoding\n"
           f"Style: T,{fam},{tsz},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,1,0,0,0,100,100,0,0,1,5,4,{al_t},{mlr[0]},{mlr[1]},{fb['tt']},1\n"
           f"Style: S,{fam},46,&H00FFFFFF,&H00FFFFFF,&H99000000,&H99000000,1,0,0,0,100,100,0,0,3,14,0,{al_t},{mlr[0]},{mlr[1]},{fb['st'] + 20},1\n"
           f"Style: V,{fam},40,{gold},{gold},&HA0000000,&HA0000000,1,0,0,0,100,100,0,0,3,12,0,{ca},62,62,{fb['ct'] - 95},1\n"
           f"Style: N,Noto Sans,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,3,{ca},62,62,{fb['ct']},1\n"
           f"Style: C,{fam},38,{gold},{gold},&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2.5,2,{ca},62,62,{fb['ct'] + 72},1\n"
           "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")

    def esc(x):
        return (x or "").replace("{", "(").replace("}", ")").replace("\\", "/")
    t1, t2 = ctx["t1"], ctx["t2"]
    title = (esc(t1) + "\\N" if t1 else "") + "{\\c" + gold + "}" + esc(t2)
    ev = [f"Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{title}"]
    if ctx["sub"]:
        ev.append(f"Dialogue: 0,0:00:00.00,0:00:05.00,S,,0,0,0,,{esc(ctx['sub'])}")
    if ctx["verse"]:
        ev.append(f"Dialogue: 0,0:00:00.00,0:00:05.00,V,,0,0,0,,{esc(ctx['verse'])}")
    ev.append(f"Dialogue: 0,0:00:00.00,0:00:05.00,N,,0,0,0,,{esc(ctx['name'])}")
    ev.append(f"Dialogue: 0,0:00:00.00,0:00:05.00,C,,0,0,0,,{esc(ctx['church'])}")
    (wd / "thumb.ass").write_text(hdr + "\n".join(ev) + "\n", encoding="utf-8-sig")
    fdir = assets_setup.ensure_fonts().resolve()
    try:
        fd = os.path.relpath(fdir, wd.resolve()).replace("\\", "/")
    except ValueError:
        fd = ff.filter_path(fdir)
    ff.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", base.name, "-vf",
            f"ass=thumb.ass:fontsdir='{fd}'", "-frames:v", "1", png_out.name], job=job, cwd=str(wd))


# ------------------------------------------------------------------- main --
def auto_style(p: dict, r: dict) -> str:
    """Deterministic: walk the style list from a reel-number offset; skip the previous reel's style and,
    when possible, any style another reel of the project already uses."""
    reels = p.get("reels", [])
    idx = next((i for i, x in enumerate(reels) if x["id"] == r["id"]), len(reels))
    prev = ((reels[idx - 1].get("thumbnail") or {}).get("style") if idx > 0 else None)
    used = {(x.get("thumbnail") or {}).get("style") for x in reels if x["id"] != r["id"]}
    try:
        n = int(str(r["id"]).split("~")[1])
    except (IndexError, ValueError):
        n = int(hashlib.md5(str(r["id"]).encode()).hexdigest(), 16) % 97
    order = STYLE_ORDER[(n - 1) * 5 % len(STYLE_ORDER):] + STYLE_ORDER[:(n - 1) * 5 % len(STYLE_ORDER)]
    for s in order:
        if s != prev and s not in used:
            return s
    return next(s for s in order if s != prev)


def make(rid: str, job, style: str | None = None, pose_t: float | None = None, title: str | None = None,
         sub: str | None = None, verse: str | None = None, out: str | Path | None = None,
         renderer: str | None = None, save: bool = True) -> dict:
    p, r = projects.find_reel(rid)
    lang = r.get("language") if r.get("language") in ("or", "hi", "en") else "or"
    th = r.get("thumbnail") or {}
    if style and style not in STYLES:
        raise JobError(f"unknown thumbnail style '{style}' - one of {', '.join(STYLES)}")
    style_user = style is not None   # an editor's choice sticks for later automatic runs
    if style is None and th.get("style_user") and th.get("style") in STYLES:
        style, style_user = th["style"], True
    style = style or auto_style(p, r)
    wd = projects.reel_dir(rid) / "thumb"
    wd.mkdir(parents=True, exist_ok=True)

    # text
    raw_title = title if title is not None else (th.get("title") or r.get("title") or "")
    raw_sub = sub if sub is not None else (th.get("sub") if th.get("sub") is not None else r.get("sub") or "")
    vlabel = verse_label(r, lang, verse if verse is not None else th.get("verse"), [raw_sub, raw_title])
    if " · " in raw_sub and vlabel:   # "You are not alone · John 15:5" -> the ref moves to the verse pill
        head, tail = raw_sub.rsplit(" · ", 1)
        if re.search(r"\d+\s*:\s*\d+", tail):
            raw_sub = head
    ttl = clean_title(localize(raw_title, lang))
    t1, t2 = split2(ttl)
    sub_txt = localize(raw_sub, lang).strip()
    name, church = credit_parts(lang)

    # pose
    job.update(0.02, "thumbnail: choosing a pose")
    pose_info = {}
    pose_user = pose_t is not None
    if pose_t is None and th.get("pose_user") and th.get("pose_t") is not None:
        pose_t, pose_user = th["pose_t"], True
    if pose_t is None:
        pose_t, pose_info = auto_pose(r, job)
    pose_t = float(pose_t)
    ts = src_time(r, pose_t)
    job.update(0.35, "thumbnail: cutting out the pastor")
    frame = grab(p["video_path"], ts, wd / "pose.png", job)
    cut, cinfo = cutout.bust(frame)
    cv2.imwrite(str(wd / "bust.png"), cut)
    job.check()

    # background
    bg_path = next((c["img"] for c in sorted(r.get("cutaways") or [], key=lambda c: c["t0"])
                    if c.get("img") and Path(c["img"]).exists()), None)
    if bg_path:
        bg_img = cv2.imdecode(np.fromfile(bg_path, np.uint8), cv2.IMREAD_COLOR)
    else:
        bg_img = None
    if bg_img is None:
        small = cv2.resize(frame, (frame.shape[1] // 4, frame.shape[0] // 4))
        bg_img = cv2.resize(cv2.GaussianBlur(small, (0, 0), 6), (frame.shape[1], frame.shape[0]))
        cv2.imwrite(str(wd / "bg.jpg"), bg_img)
        bg_path = str(wd / "bg.jpg")

    fdir = assets_setup.ensure_fonts()
    ctx = {"lang": lang, "t1": t1, "t2": t2, "sub": sub_txt, "verse": vlabel, "name": name, "church": church,
           "bg": furl(bg_path), "bust": furl(wd / "bust.png"), "face": cinfo.get("face_in_cut"),
           "fonts": {"fLa": furl(fdir / "NotoSans-Bold.ttf"), "fOr": furl(fdir / "NotoSansOriya-Bold.ttf"),
                     "fDe": furl(fdir / "NotoSansDevanagari-Bold.ttf")}}
    ctx["pastor"] = pastor_tag((cut.shape[1], cut.shape[0]), ctx["face"], STYLES[style]["pastor"])

    if out is None:
        n = rid.split("~")[1]
        out = projects.exports_dir(p["id"]) / f"{n}-{projects.slug(r.get('title') or 'reel')}.jpg"
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    png = wd / "thumb.png"
    if png.exists():
        png.unlink()
    want = (renderer or os.environ.get("VIKU_THUMB_RENDERER") or "auto").lower()
    used = None
    job.update(0.6, f"thumbnail: rendering '{style}'")
    if want in ("auto", "browser", "chrome", "edge") and find_browser():
        hp = wd / "thumb.html"
        hp.write_text(build_html(style, ctx), encoding="utf-8")
        try:
            render_browser(hp, png, job)
            used = "browser:" + Path(find_browser()).stem
        except JobError:
            if want != "auto":
                raise
    if used is None:
        render_fallback(style, ctx, bg_img, cut, png, wd, job)
        used = "pillow+libass"
    from PIL import Image
    Image.open(png).convert("RGB").crop((0, 0, W, H)).save(out, "JPEG", quality=92, optimize=True)
    res = {"thumbnail": str(out), "style": style, "pose_t": round(pose_t, 2), "source_t": round(ts, 3),
           "renderer": used, "title": ttl, "sub": sub_txt, "verse": vlabel, "cutout_model": cutout.MODEL,
           "pose": pose_info, "cutout": {k: cinfo.get(k) for k in ("face", "box", "size")}}
    if save:
        def upd(pp):
            for rr in pp["reels"]:
                if rr["id"] == rid:
                    t = rr.get("thumbnail") or {}
                    t.update({"style": style, "pose_t": res["pose_t"], "path": str(out), "renderer": used})
                    if style_user:
                        t["style_user"] = True
                    if pose_user:
                        t["pose_user"] = True
                    if title is not None:
                        t["title"] = title
                    if sub is not None:
                        t["sub"] = sub
                    if verse is not None:
                        t["verse"] = verse
                    rr["thumbnail"] = t
        projects.update(p["id"], upd)
    return res
