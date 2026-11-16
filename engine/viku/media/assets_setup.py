"""First-run assets: Noto fonts (OFL, downloaded once into <data>/fonts) and synthesized SFX
(<data>/sfx/impact.wav + swell.wav; port of make_sfx.py - the bell "shimmer" is deliberately gone)."""
from __future__ import annotations

import urllib.request
import wave
from pathlib import Path

import numpy as np

from .. import config

FONT_BASE = "https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/"
FONTS = {  # file -> url path
    "NotoSansOriya-Bold.ttf": "NotoSansOriya/hinted/ttf/NotoSansOriya-Bold.ttf",
    "NotoSansOriya-Regular.ttf": "NotoSansOriya/hinted/ttf/NotoSansOriya-Regular.ttf",
    "NotoSansDevanagari-Bold.ttf": "NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Bold.ttf",
    "NotoSansDevanagari-Regular.ttf": "NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Regular.ttf",
    "NotoSans-Bold.ttf": "NotoSans/hinted/ttf/NotoSans-Bold.ttf",
    "NotoSans-Regular.ttf": "NotoSans/hinted/ttf/NotoSans-Regular.ttf",
    "LICENSE-OFL.txt": "LICENSE",
}
FAMILY = {"or": "Noto Sans Oriya", "hi": "Noto Sans Devanagari", "en": "Noto Sans"}


def fonts_dir() -> Path:
    return config.sub("fonts")


def fonts_ready() -> bool:
    d = fonts_dir()
    return all((d / f).exists() for f in FONTS)


def ensure_fonts() -> Path:
    d = fonts_dir()
    for f, u in FONTS.items():
        if not (d / f).exists():
            tmp = d / (f + ".part")
            req = urllib.request.Request(FONT_BASE + u, headers={"User-Agent": "viku-engine"})
            with urllib.request.urlopen(req, timeout=60) as r:
                tmp.write_bytes(r.read())
            tmp.replace(d / f)
    return d


# ---------------------------------------------------------------- SFX ----
SR = 48000


def _onepole_lp(x, fc):
    a = np.exp(-2 * np.pi * fc / SR)
    y = np.empty_like(x)  # plain loop: clips are a few seconds
    z = 0.0
    for i, v in enumerate(x):
        z = (1 - a) * v + a * z
        y[i] = z
    return y


def _save(path: Path, l, r=None, peak_db=-6.0):
    r = l if r is None else r
    st = np.stack([l, r], 1)
    st *= 10 ** (peak_db / 20) / (np.abs(st).max() + 1e-9)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((st * 32767).astype(np.int16).tobytes())


def _reverb(x, secs=1.6, mix=0.35, seed=1):
    n = int(secs * SR)
    g = np.random.default_rng(seed)
    ir = g.standard_normal(n) * np.exp(-np.linspace(0, 7, n))
    ir = _onepole_lp(ir, 5000)
    ir /= np.abs(ir).sum() ** 0.5 * 8
    dry = np.concatenate([x, np.zeros(n)])
    wet = np.convolve(x, ir)[: len(dry)]
    wet = np.pad(wet, (0, len(dry) - len(wet)))
    return (1 - mix) * dry + mix * wet


def sfx_dir() -> Path:
    return config.sub("sfx")


def sfx_ready() -> bool:
    return all((sfx_dir() / f"{n}.wav").exists() for n in ("impact", "swell"))


def ensure_sfx() -> Path:
    """swell 1.0 s: band-passed air noise rising into a cut. impact 2.5 s: low pitch-dropping sub boom.
    NEVER bell / chime / shimmer (user rule)."""
    d = sfx_dir()
    rng = np.random.default_rng(7)
    if not (d / "swell.wav").exists():
        n = int(1.0 * SR)
        t = np.linspace(0, 1, n)
        noise = rng.standard_normal(n)
        lo, hi = _onepole_lp(noise, 600), _onepole_lp(noise, 4500)
        sw = (lo * (1 - t) + hi * t) * (t ** 2.2) * (1 - np.clip((t - 0.93) / 0.07, 0, 1))
        sw = _onepole_lp(sw - _onepole_lp(sw, 150), 8000)
        _save(d / "swell.wav", _reverb(sw, 1.0, 0.3, 1), _reverb(sw, 1.0, 0.3, 2), -8)
    if not (d / "impact.wav").exists():
        n = int(2.5 * SR)
        t = np.arange(n) / SR
        f = 70 * np.exp(-t * 1.2) + 38
        ph = 2 * np.pi * np.cumsum(f) / SR
        sub = np.sin(ph) * np.exp(-t * 1.6) * np.minimum(t / 0.004, 1)
        body = _onepole_lp(rng.standard_normal(n), 900) * np.exp(-t * 9) * 0.6
        imp = sub + body
        _save(d / "impact.wav", _reverb(imp, 1.8, 0.25, 5), _reverb(imp, 1.8, 0.25, 6), -6)
    return d
