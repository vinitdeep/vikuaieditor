"""ASS (libass) subtitle document for a reel: title hook, subtitle, captions, verse cards, credit.

Styles follow the house rules (reel_track.HEAD) with redistributable Noto fonts:
caption family by reel language; Latin runs inside Odia/Devanagari text switch to Noto Sans
inline so English words, digits and the credit line never fall back to a system font.
"""
from __future__ import annotations

import re

from .assets_setup import FAMILY

STYLE_FMT = ("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
             "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
             "MarginL, MarginR, MarginV, Encoding")


def head(lang: str, caption_size: int = 74) -> str:
    f = FAMILY.get(lang, "Noto Sans")
    L = "Noto Sans"
    styles = [
        f"Style: Title,{f},88,&H00FFFFFF,&H00FFFFFF,&H50000000,&H50000000,1,0,0,0,100,100,0,0,3,18,0,8,60,60,170,1",
        f"Style: Sub,{L},48,&H0000D7FF,&H00FFFFFF,&H50000000,&H50000000,1,0,0,0,100,100,0,0,3,12,0,8,60,60,318,1",
        f"Style: Cap,{f},{caption_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,1,0,0,0,100,100,0,0,1,4.5,3,2,70,70,400,1",
        f"Style: Foot,{L},40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2.5,0,2,60,60,230,1",
        f"Style: Verse,{f},64,&H00FFFFFF,&H00FFFFFF,&H60000000,&H60000000,1,0,0,0,100,100,0,0,3,20,0,8,90,90,520,1",
        f"Style: Ref,{f},46,&H0000D7FF,&H00FFFFFF,&H60000000,&H60000000,1,0,0,0,100,100,0,0,3,20,0,8,90,90,520,1",
    ]
    return ("[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n"
            "ScaledBorderAndShadow: yes\n\n[V4+ Styles]\n" + STYLE_FMT + "\n" + "\n".join(styles) +
            "\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")


def ts(t: float) -> str:
    cs = int(round(max(t, 0) * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02}:{cs // 100 % 60:02}.{cs % 100:02}"


_LATIN = re.compile(r"[!-ɏ‐-‧·]+(?:[ ]+[!-ɏ‐-‧·]+)*")


def esc(text: str) -> str:
    return (text or "").replace("\\", "⧵").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def latin_runs(text: str, base: str) -> str:
    """Wrap Latin/ASCII runs in {\\fnNoto Sans}...{\\fn<base>} for non-Latin base fonts."""
    if base == "Noto Sans":
        return text
    return _LATIN.sub(lambda m: "{\\fnNoto Sans}" + m.group(0) + "{\\fn" + base + "}", text)


def build(reel: dict, dur: float, credit: str) -> str:
    lang = reel.get("language", "or")
    base = FAMILY.get(lang, "Noto Sans")
    style = reel.get("style") or {}
    out = [head(lang, int(style.get("caption_size", 74)))]

    def T(s: str, b: str = base) -> str:
        return latin_runs(esc(s), b)

    ev = []
    if reel.get("title"):
        ev.append(f"Dialogue: 0,{ts(0.2)},{ts(min(4.2, dur))},Title,,0,0,0,,"
                  f"{{\\fad(300,500)\\fscx90\\fscy90\\t(0,250,\\fscx100\\fscy100)}}{T(reel['title'])}")
    if reel.get("sub"):
        ev.append(f"Dialogue: 0,{ts(0.5)},{ts(min(4.2, dur))},Sub,,0,0,0,,{{\\fad(300,500)}}{T(reel['sub'], 'Noto Sans')}")
    if credit:
        ev.append(f"Dialogue: 0,{ts(0)},{ts(dur)},Foot,,0,0,0,,{T(credit, 'Noto Sans')}")
    for c in reel.get("captions", []):
        a, b = max(c["t0"], 0), min(c["t1"], dur)
        if b - a > 0.2 and c.get("text"):
            ev.append(f"Dialogue: 1,{ts(a)},{ts(b)},Cap,,0,0,0,,"
                      f"{{\\fad(60,60)\\fscx92\\fscy92\\t(0,120,\\fscx100\\fscy100)}}{T(c['text'])}")
    for v in reel.get("verses", []):
        a, b = max(v["t0"], 0), min(v["t1"], dur)
        mv = int(v.get("top_y") or 0)
        if b - a > 0.5:
            ev.append(f"Dialogue: 2,{ts(a)},{ts(b)},Verse,,0,0,{mv},,{{\\fad(350,350)}}{T(v['text'])}"
                      f"\\N{{\\rRef}}{T(v.get('ref', ''))}")
    return out[0] + "\n".join(ev) + "\n"
