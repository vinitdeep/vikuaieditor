"""Offline music generator: procedural cinematic underscore beds (royalty-free, made on this PC).

    generate(mood, seed=1, duration=90.0) -> (stereo float32 [n, 2] at 48 kHz, info)

Everything is numpy (no scipy, no samples, no network). Deterministic: the same (mood, seed, duration) gives the same
bytes. The bed is built on a CIRCULAR timeline of exactly `duration` seconds - every note, release tail and the reverb
wrap around the end - so the file loops seamlessly.

Synthesis
- Voices = band-limited wavetables (additive: harmonic k has amplitude a_k of the timbre x a 3rd-order low-pass
  weight at k*f0), two tables per note (dark / bright) cross-faded by a slow brightness curve = a subtractive filter
  sweep without per-sample IIR filtering. Pads use 2-3 detuned voices spread in stereo; strings add a delayed vibrato.
- Harmony: soft diatonic progressions (I-V-vi-IV, vi-IV-I-V, I-IV-vi-V, ...), nearest-voicing voice leading in the
  E3-C5 band, roots in the bass octave.
- Space: circular FFT convolution with a synthetic, darkened stereo reverb tail (RT60 3-5 s).
- Master: 35 Hz high-pass + gentle 5 kHz low-pass (FFT domain), BS.1770 loudness normalisation to -14 LUFS, true
  peak kept <= -1.5 dBTP (4x oversampled), TPDF dither on export.

House rule: NO bells / chimes / glockenspiel / shimmer. Timbres are pads, strings, a felt piano (harmonics rolled off
below 2 kHz, only up to C5) and a low-passed pluck pulse; `bell_check()` measures what that rule forbids (tonal
partials above 2 kHz with a fast attack) and the tests hold every mood to it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

SR = 48000
TS = 4096                     # wavetable length
HARD_CAP_HZ = 2000.0          # no oscillator partial above 2 kHz: clear of bell / shimmer territory and of the speech presence band

MOODS = {
    "hopeful": {"label": "Hopeful piano + pad", "desc": "felt piano broken chords over a soft pad, I-V-vi-IV"},
    "victorious": {"label": "Victorious strings swell", "desc": "string-pad swells, low boom on the downbeats"},
    "reflective": {"label": "Reflective ambient", "desc": "slow sine pads and a drone, vi-IV-I-V"},
    "prayerful": {"label": "Prayerful warm pad", "desc": "warm pad and low drone, very slow movement"},
    "uplifting": {"label": "Uplifting pulse", "desc": "soft eighth-note pluck pulse, pad and bass"},
}
DEFAULT_SEEDS = {"hopeful": 1, "victorious": 1, "reflective": 1, "prayerful": 1, "uplifting": 1}

# theme ids from brain/hooks.json -> music mood (autobuild picks a bed by the reel's theme)
THEME_MOOD = {
    "victory": "victorious", "enemy_defeated": "victorious", "can_do": "victorious", "resurrection": "victorious",
    "fear_not": "victorious",
    "prayer": "prayerful", "healing": "prayerful", "spirit": "prayerful", "cross": "prayerful",
    "depression": "reflective", "storm": "reflective", "pride": "reflective", "words": "reflective",
    "hope": "hopeful", "not_alone": "hopeful", "love": "hopeful", "light": "hopeful", "family": "hopeful",
    "foundation": "hopeful", "vine": "hopeful",
    "salvation": "uplifting",
}


def mood_for_theme(theme: str | None) -> str:
    return THEME_MOOD.get(theme or "", "hopeful")


# ------------------------------------------------------------------ helpers --
def mtof(m: float) -> float:
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def _lp(fr: np.ndarray, fc: float, order: int = 3) -> np.ndarray:
    return 1.0 / np.sqrt(1.0 + (fr / fc) ** (2 * order))


TIMBRES = {
    # name: harmonic amplitude law a_k
    "saw": lambda k: 1.0 / k,
    "warm": lambda k: np.where(k % 2 == 1, 1.0 / k ** 1.6, 0.25 / k ** 1.8),
    "sine": lambda k: np.where(k == 1, 1.0, np.where(k == 2, 0.18, np.where(k == 3, 0.05, 0.0))),
    "felt": lambda k: 1.0 / k ** 1.25,
    "string": lambda k: (1.0 / k) * (1.0 + 0.35 * np.exp(-((k - 3.0) ** 2) / 2.0)),
    "bass": lambda k: np.where(k == 1, 1.0, np.where(k == 2, 0.3, np.where(k == 3, 0.08, 0.0))),
}
_PHASES = (np.arange(1, 129) ** 2 * 0.6180339887) % 1.0   # fixed per-harmonic phases (shared by dark / bright)
_tables: dict = {}


def table(timbre: str, f0: float, fc: float) -> np.ndarray:
    """One cycle (TS samples) of `timbre` at fundamental f0 through a low-pass at fc (cached, float32)."""
    key = (timbre, round(f0, 2), round(fc))
    t = _tables.get(key)
    if t is None:
        kmax = int(min(HARD_CAP_HZ, SR * 0.45) // f0)
        k = np.arange(1, max(kmax, 1) + 1, dtype=np.float64)
        a = TIMBRES[timbre](k) * _lp(k * f0, fc)
        x = np.arange(TS) / TS
        t = (a[:, None] * np.sin(2 * np.pi * (k[:, None] * x[None, :] + _PHASES[: len(k), None]))).sum(0)
        t = (t / max(np.abs(t).max(), 1e-9)).astype(np.float32)
        if len(_tables) > 4000:
            _tables.clear()
        _tables[key] = t
    return t


def env_adsr(n: int, a: float, d: float, s: float, r: float, hold: int) -> np.ndarray:
    """Raised-cosine attack, decay to sustain s, hold until `hold` samples, exponential-ish release over r s."""
    e = np.full(n, s, np.float32)
    na, nd, nr = max(int(a * SR), 1), max(int(d * SR), 1), max(int(r * SR), 1)
    na = min(na, n)
    e[:na] = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, na, dtype=np.float32))
    if na < n:
        m = min(nd, n - na)
        e[na:na + m] = 1.0 + (s - 1.0) * (1 - np.exp(-np.linspace(0, 4, m, dtype=np.float32))) / (1 - math.exp(-4))
    hold = min(max(hold, na), n)
    if hold < n:
        lvl = e[hold - 1] if hold > 0 else s
        m = n - hold
        e[hold:] = lvl * np.exp(-np.linspace(0, 6.9, m, dtype=np.float32)) * np.linspace(1, 0, m, dtype=np.float32) ** 0.5
    return e


@dataclass
class Bed:
    n: int
    seed: int

    def __post_init__(self):
        self.L = np.zeros(self.n, np.float32)
        self.R = np.zeros(self.n, np.float32)
        self.rng = np.random.default_rng(self.seed)

    def add(self, start: int, sig: np.ndarray, pan: float, gain: float = 1.0):
        """Add mono `sig` at sample `start` on the circular timeline with equal-power pan (-1..1)."""
        th = (pan + 1) * math.pi / 4
        gl, gr = math.cos(th) * gain, math.sin(th) * gain
        start %= self.n
        m = min(len(sig), self.n)
        sig = sig[:m]
        k = min(m, self.n - start)
        self.L[start:start + k] += gl * sig[:k]
        self.R[start:start + k] += gr * sig[:k]
        if k < m:
            self.L[: m - k] += gl * sig[k:]
            self.R[: m - k] += gr * sig[k:]

    def circ(self, curve: np.ndarray, start: int, m: int) -> np.ndarray:
        idx = (start + np.arange(m)) % self.n
        return curve[idx]


def voice(f0: float, m: int, timbre: str, fc_dark: float, fc_bright: float, morph: np.ndarray,
          phase0: float = 0.0, vibrato: float = 0.0) -> np.ndarray:
    """Wavetable oscillator: dark / bright tables cross-faded by `morph` (0..1 per sample)."""
    td, tb = table(timbre, f0, fc_dark), table(timbre, f0, fc_bright)
    if vibrato:
        t = np.arange(m, dtype=np.float64) / SR
        depth = vibrato * np.clip((t - 0.6) / 1.2, 0, 1)
        fi = f0 * (1 + depth * np.sin(2 * np.pi * 5.2 * t + phase0 * 6.28))
        ph = np.cumsum(fi) / SR + phase0
    else:
        ph = np.arange(m, dtype=np.float64) * (f0 / SR) + phase0
    idx = ((ph % 1.0) * TS).astype(np.int32) & (TS - 1)
    a, b = td[idx], tb[idx]
    return a + (b - a) * morph.astype(np.float32)


# ----------------------------------------------------------------- harmony --
MAJOR = [0, 2, 4, 5, 7, 9, 11]


def chord(degree: int, extra: tuple = ()) -> list[int]:
    """Diatonic triad on scale degree 1..7 (semitones above the key root) + extra scale steps (e.g. 9 -> add9)."""
    i = degree - 1
    pcs = [MAJOR[(i + s) % 7] + 12 * ((i + s) // 7) for s in (0, 2, 4)]
    for e in extra:
        pcs.append(MAJOR[(i + e - 1) % 7] + 12 * ((i + e - 1) // 7))
    return pcs


def voicing(pcs: list[int], key: int, lo: int, hi: int, prev: list[int] | None) -> list[int]:
    """Closest-motion voicing of the pitch classes inside [lo, hi] (MIDI)."""
    base = sorted({(key + p) % 12 for p in pcs})
    best, bd = None, 1e9
    n = len(base)
    for inv in range(n):
        order = base[inv:] + base[:inv]
        for start in range(lo, lo + 12):
            if start % 12 != order[0]:
                continue
            notes, cur = [], start
            for pc in order:
                while cur % 12 != pc:
                    cur += 1
                notes.append(cur)
                cur += 1
            if notes[-1] > hi:
                continue
            d = 0.0 if prev is None else sum(abs(a - b) for a, b in zip(sorted(notes), sorted(prev)))
            d += 0.02 * abs((notes[0] + notes[-1]) / 2 - (lo + hi) / 2)
            if d < bd:
                best, bd = notes, d
    return best or [key + p for p in pcs]


# ----------------------------------------------------------------- layers --
def pad_layer(bed: Bed, chords: list, key: int, bar: int, bars_per_chord: int, timbre: str, gain: float,
              fc: tuple, morph: np.ndarray, attack: float, release: float, detune_cents: float, voices: int = 2,
              lo: int = 52, hi: int = 72, vibrato: float = 0.0, swell: bool = False, active=None, octave: int = 0):
    prev = None
    L = bar * bars_per_chord
    for ci, pcs in enumerate(chords):
        notes = voicing(pcs, key, lo, hi, prev)
        prev = notes
        start = ci * L
        if active is not None and not active(ci):
            continue
        m = L + int(release * SR)
        e = env_adsr(m, attack, 0.6, 0.85, release, L)
        if swell:   # crescendo through the chord, easing off at the change
            t = np.linspace(0, 1, m, dtype=np.float32)
            e = e * (0.45 + 0.55 * np.sin(np.clip(t * (m / L), 0, 1) * np.pi * 0.62) ** 2)
        mo = bed.circ(morph, start, m)
        for nn in notes:
            for v in range(voices):
                det = (v - (voices - 1) / 2) * detune_cents
                f = mtof(nn + 12 * octave + det / 100.0)
                sig = voice(f, m, timbre, fc[0], fc[1], mo, bed.rng.random(), vibrato) * e
                pan = float(np.clip((v - (voices - 1) / 2) * 0.7 + bed.rng.uniform(-0.25, 0.25), -0.9, 0.9))
                bed.add(start, sig, pan, gain / (len(notes) * voices) ** 0.5)


def bass_layer(bed: Bed, chords: list, key: int, bar: int, bars_per_chord: int, gain: float, active=None,
               attack: float = 0.08):
    L = bar * bars_per_chord
    for ci, pcs in enumerate(chords):
        if active is not None and not active(ci):
            continue
        root = 36 + (key + pcs[0]) % 12
        if root > 43:
            root -= 12
        m = L + int(0.8 * SR)
        e = env_adsr(m, attack, 0.5, 0.8, 0.8, L)
        sig = voice(mtof(root), m, "bass", 400, 600, np.zeros(m, np.float32), 0.0) * e
        bed.add(ci * L, sig, 0.0, gain)


def drone_layer(bed: Bed, key: int, gain: float, morph: np.ndarray, timbre: str = "warm"):
    """Root + fifth held through the whole loop (two overlapping halves so it wraps without a seam)."""
    n = bed.n
    for midi in (key - 12 + 12 * (key < 48), key - 5 + 12 * (key < 48)):
        for half in (0, 1):
            m = n
            t = np.linspace(0, 1, m, dtype=np.float32)
            e = np.sin(np.pi * t) ** 2   # two copies offset by n/2 sum to a constant level
            sig = voice(mtof(midi), m, timbre, 300, 700, bed.circ(morph, half * n // 2, m), bed.rng.random()) * e
            bed.add(half * n // 2, sig, bed.rng.uniform(-0.3, 0.3), gain * 0.5)


def piano_layer(bed: Bed, chords: list, key: int, bar: int, bars_per_chord: int, gain: float, pattern: list,
                active=None):
    """Felt piano broken chords. `pattern` = [(beat, chord tone index, octave)], 4 beats per bar."""
    beat = bar // 4
    L = bar * bars_per_chord
    prev = None
    for ci, pcs in enumerate(chords):
        notes = voicing(pcs, key, 55, 71, prev)
        prev = notes
        if active is not None and not active(ci):
            continue
        for b_ in range(bars_per_chord):
            for (bt, ti, octv) in pattern:
                nn = notes[ti % len(notes)] + 12 * octv
                nn = min(nn, 72)                  # never above C5
                f = mtof(nn)
                m = int(3.2 * SR)
                t = np.arange(m, dtype=np.float32) / SR
                tau = 1.6 * (261.6 / f) ** 0.35
                e = (1 - np.exp(-t / 0.006)) * np.exp(-t / tau)
                e *= np.clip((3.2 - t) / 0.4, 0, 1)
                mo = np.exp(-t / 0.35).astype(np.float32)          # hammer brightness decays fast
                vel = 0.8 + 0.2 * bed.rng.random()
                sig = (voice(f, m, "felt", 700, 1700, mo, bed.rng.random()) * 0.6
                       + voice(f * 1.0006, m, "felt", 700, 1700, mo, bed.rng.random()) * 0.4) * e * vel
                start = ci * L + b_ * bar + int(bt * beat) + int(bed.rng.uniform(0, 0.012) * SR)
                bed.add(start, sig, float(np.clip((nn - 64) / 14, -0.6, 0.6)), gain)


def pulse_layer(bed: Bed, chords: list, key: int, bar: int, bars_per_chord: int, gain: float, morph: np.ndarray,
                active=None):
    """Soft eighth-note pluck pulse on chord tones (low-passed, 10 ms attack, short decay)."""
    eighth = bar // 8
    L = bar * bars_per_chord
    prev = None
    seq = [0, 2, 1, 2, 0, 2, 1, 2]
    for ci, pcs in enumerate(chords):
        notes = voicing(pcs, key, 48, 62, prev)
        prev = notes
        if active is not None and not active(ci):
            continue
        for b_ in range(bars_per_chord):
            for k8 in range(8):
                nn = notes[seq[k8] % len(notes)]
                f = mtof(nn)
                m = int(0.7 * SR)
                t = np.arange(m, dtype=np.float32) / SR
                e = (1 - np.exp(-t / 0.010)) * np.exp(-t / 0.22)
                start = ci * L + b_ * bar + k8 * eighth
                mo = np.exp(-t / 0.08) * (0.5 + 0.5 * float(morph[start % bed.n]))
                acc = 1.0 if k8 % 2 == 0 else 0.7
                sig = voice(f, m, "saw", 450, 1300, mo.astype(np.float32), 0.0) * e * acc
                bed.add(start, sig, -0.35 if k8 % 2 else 0.35, gain)


def boom_layer(bed: Bed, bar: int, every_bars: int, n_bars: int, gain: float, active=None):
    """Low sine boom with a pitch drop (felt timpani / sub hit) on downbeats - nothing above ~200 Hz."""
    m = int(1.6 * SR)
    t = np.arange(m, dtype=np.float64) / SR
    f = 42 + 22 * np.exp(-t / 0.09)
    ph = np.cumsum(f) / SR
    e = (1 - np.exp(-t / 0.012)) * np.exp(-t / 0.45)
    sig = (np.sin(2 * np.pi * ph) * e).astype(np.float32)
    for b_ in range(0, n_bars, every_bars):
        if active is not None and not active(b_):
            continue
        bed.add(b_ * bar, sig, 0.0, gain)


# ------------------------------------------------------------- processing --
# Signals here are channel-first (2, n) float arrays (contiguous rows = fast FFTs).
def tone_shape(x: np.ndarray, hp: float = 35.0, lp: float = 5000.0) -> np.ndarray:
    n = x.shape[1]
    f = np.fft.rfftfreq(n, 1 / SR)
    H = (1.0 / np.sqrt(1.0 + (hp / np.maximum(f, 1e-3)) ** 4)) * _lp(f, lp, 2)
    return np.fft.irfft(np.fft.rfft(x, axis=1) * H[None, :], n=n, axis=1)


def reverb(x: np.ndarray, rng: np.random.Generator, rt60: float, wet: float, damp_hz: float = 2500.0) -> np.ndarray:
    """Circular FFT convolution with a synthetic stereo tail (decorrelated noise, exp decay, darkened, pre-delay)."""
    n = x.shape[1]
    m = int(min(rt60 * 1.3, n / SR * 0.9) * SR)
    t = np.arange(m) / SR
    pre = int(0.025 * SR)
    damp = _lp(np.fft.rfftfreq(n, 1 / SR), damp_hz, 1)
    ir = rng.standard_normal((2, m)) * np.exp(-6.9 * t / rt60)[None, :]
    ir[:, :pre] = 0
    ir *= np.clip((t - pre / SR) / 0.04, 0, 1)[None, :]
    irf = np.fft.rfft(ir, n=n, axis=1) * damp[None, :]
    irf /= np.sqrt(np.mean(np.abs(irf) ** 2, axis=1, keepdims=True)) + 1e-12
    y = np.fft.irfft(np.fft.rfft(x, axis=1) * irf, n=n, axis=1)
    return x * (1 - wet) + y * (wet * 0.9)


# K-weighting (ITU-R BS.1770-4, 48 kHz) as frequency responses (circular = exact for a loop)
_KB1, _KA1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]
_KB2, _KA2 = [1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]


def _biquad_H(b, a, n):
    w = np.exp(-1j * np.pi * np.arange(n // 2 + 1) / (n / 2))
    return (b[0] + b[1] * w + b[2] * w * w) / (a[0] + a[1] * w + a[2] * w * w)


def _cf(x: np.ndarray) -> np.ndarray:
    """(n, 2) or (2, n) -> contiguous (2, n) float64."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[None, :]
    if x.shape[0] > x.shape[1]:
        x = x.T
    return np.ascontiguousarray(x)


def lufs(x: np.ndarray) -> float:
    """Integrated loudness (BS.1770-4, gated) of a 48 kHz signal, (n, ch) or (ch, n)."""
    x = _cf(x)
    n = x.shape[1]
    H = _biquad_H(_KB1, _KA1, n) * _biquad_H(_KB2, _KA2, n)
    y = np.fft.irfft(np.fft.rfft(x, axis=1) * H[None, :], n=n, axis=1)
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    c = np.concatenate([[0.0], np.cumsum((y ** 2).sum(0))])
    starts = np.arange(0, n - blk + 1, hop)
    z = (c[starts + blk] - c[starts]) / blk
    z1 = z[-0.691 + 10 * np.log10(np.maximum(z, 1e-12)) > -70]
    if not len(z1):
        return -70.0
    rel = -0.691 + 10 * np.log10(z1.mean()) - 10
    z2 = z1[(-0.691 + 10 * np.log10(z1)) > rel]
    return float(-0.691 + 10 * np.log10(z2.mean()))


def true_peak(x: np.ndarray, os: int = 4, seg: int = 1 << 15, pad: int = 256) -> float:
    """dBTP estimate: 4x FFT oversampling of overlapping power-of-two segments (wrapping: the bed loops)."""
    x = _cf(x)
    n = x.shape[1]
    step = seg - 2 * pad
    pk = 0.0
    for a in range(0, n, step):
        idx = np.arange(a - pad, a - pad + seg) % n
        u = np.fft.irfft(np.fft.rfft(x[:, idx], axis=1), n=seg * os, axis=1) * os
        pk = max(pk, float(np.abs(u[:, pad * os:(pad + min(step, n - a)) * os]).max()))
    return 20 * math.log10(max(pk, 1e-9))


def bell_check(x: np.ndarray) -> dict:
    """What the no-bells rule forbids, measured on the mono sum (STFT 2048 / hop 512):
    hf_ratio = share of energy above 2 kHz; tonal_onsets = events where a tonal partial above 2 kHz (a local spectral
    peak >= 15 dB over its +-12-bin median and within 30 dB of the frame's strongest bin) rises >= 15 dB within 40 ms
    - the signature of a bell / chime / glockenspiel strike. -> {hf_ratio, hf_db, tonal_onsets, tonal_onsets_per_min}"""
    x = _cf(x)
    mono = x.mean(0)
    nfft, hop = 2048, 512
    swv = np.lib.stride_tricks.sliding_window_view
    frames = swv(mono, nfft)[::hop] * np.hanning(nfft)
    S = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    f = np.fft.rfftfreq(nfft, 1 / SR)
    hf = f >= 2000
    ratio = float(S[:, hf].sum() / (S.sum() + 1e-20))
    db = 10 * np.log10(S + 1e-20)
    floor = np.median(swv(np.pad(db, ((0, 0), (12, 12)), mode="edge"), 25, axis=1), axis=2)
    peak = np.zeros_like(db, dtype=bool)
    peak[:, 1:-1] = (db[:, 1:-1] >= db[:, :-2]) & (db[:, 1:-1] >= db[:, 2:])
    tonal = peak & (db - floor >= 15) & (db >= db.max(1, keepdims=True) - 30) & hf[None, :]
    lag = max(1, int(0.04 * SR / hop))
    rise = np.zeros_like(tonal)
    rise[lag:] = db[lag:] - db[:-lag] >= 15
    hit = np.any(tonal & rise, axis=1)
    onsets = int(hit[0]) + int((hit[1:] & ~hit[:-1]).sum())
    mins = len(mono) / SR / 60
    return {"hf_ratio": round(ratio, 5), "hf_db": round(10 * math.log10(max(ratio, 1e-12)), 1),
            "tonal_onsets": onsets, "tonal_onsets_per_min": round(onsets / max(mins, 1e-6), 2)}


# ------------------------------------------------------------------ moods --
KEYS = [48, 50, 51, 53, 55]   # C, D, Eb, F, G (the bed's key root, MIDI octave 3)
PROGS = {
    "pop": [chord(1, (9,)), chord(5), chord(6), chord(4, (9,))],          # I-V-vi-IV
    "epic": [chord(6), chord(4, (9,)), chord(1), chord(5)],                # vi-IV-I-V
    "lift": [chord(1, (9,)), chord(4), chord(6), chord(5)],                # I-IV-vi-V
    "rest": [chord(1, (9,)), chord(4, (9,)), chord(1), chord(5)],          # I-IV-I-V
    "plagal": [chord(1), chord(6), chord(4, (9,)), chord(1, (9,))],        # I-vi-IV-I
}


def _smooth(target: float) -> int:
    """Nearest 2^a 3^b 5^c sample count (fast FFT sizes for the whole-loop convolution)."""
    best = 1
    for a in range(0, 25):
        for b in range(0, 12):
            for c in range(0, 9):
                v = 2 ** a * 3 ** b * 5 ** c
                if abs(v - target) < abs(best - target):
                    best = v
    return best


def _plan(mood: str, seed: int, duration: float):
    rng = np.random.default_rng(seed * 7919 + sum(map(ord, mood)))
    spec = {
        "hopeful": {"bpm": 72, "bpc": 1, "progs": ["pop", "lift"]},
        "victorious": {"bpm": 80, "bpc": 2, "progs": ["epic", "pop"]},
        "reflective": {"bpm": 60, "bpc": 2, "progs": ["epic", "rest"]},
        "prayerful": {"bpm": 56, "bpc": 2, "progs": ["rest", "plagal"]},
        "uplifting": {"bpm": 96, "bpc": 1, "progs": ["pop", "lift"]},
    }[mood]
    bar_s = 240.0 / spec["bpm"]
    cyc = 4 * spec["bpc"]                                        # bars per progression cycle
    n_bars = max(cyc, int(round(duration / bar_s / cyc)) * cyc)
    bar = _smooth(duration * SR / n_bars)                        # exact fit: n_bars bars = the whole loop
    n = bar * n_bars
    prog = PROGS[spec["progs"][int(rng.integers(len(spec["progs"])))]]
    key = KEYS[int(rng.integers(len(KEYS)))]
    chords = [prog[i % 4] for i in range(n_bars // spec["bpc"])]
    return rng, n, bar, n_bars, spec["bpc"], chords, key


def generate(mood: str, seed: int = 1, duration: float = 90.0, progress=None) -> tuple[np.ndarray, dict]:
    """-> (float32 (n, 2) at 48 kHz, info). `progress(fraction, message)` is called between stages."""
    progress = progress or (lambda f, m: None)
    if mood not in MOODS:
        raise ValueError(f"unknown mood {mood!r} (one of {', '.join(MOODS)})")
    duration = float(min(max(duration, 20.0), 240.0))
    rng, n, bar, n_bars, bpc, chords, key = _plan(mood, int(seed), duration)
    bed = Bed(n, int(seed) * 104729 + sum(map(ord, mood)))
    t = np.arange(n, dtype=np.float32) / n                      # 0..1 over the loop
    nch = len(chords)
    sec = lambda lo, hi: (lambda ci: lo <= ci / nch < hi)       # noqa: E731 - arrangement sections (fractions)
    k1 = int(rng.integers(2, 4))
    morph = (0.5 - 0.5 * np.cos(2 * np.pi * k1 * t + rng.uniform(0, 6.28))).astype(np.float32)
    rt, wet = 3.5, 0.32
    progress(0.05, f"{MOODS[mood]['label']}: voices")

    if mood == "hopeful":
        pad_layer(bed, chords, key, bar, bpc, "saw", 0.55, (500, 1500), morph, 1.2, 1.8, 9, voices=2)
        pat = [(0, 0, 0), (1, 1, 0), (2, 2, 0), (3, 1, 0)] if rng.random() < 0.5 else \
              [(0, 0, 0), (1.5, 2, 0), (2, 1, 0), (3, 2, 0)]
        piano_layer(bed, chords, key, bar, bpc, 0.30, pat, active=sec(0.12, 0.94))
        bass_layer(bed, chords, key, bar, bpc, 0.30, active=sec(0.25, 0.94))
        rt, wet = 3.2, 0.30
    elif mood == "victorious":
        pad_layer(bed, chords, key, bar, bpc, "string", 0.75, (700, 2000), morph, 1.6, 2.0, 7, voices=3,
                  vibrato=0.004, swell=True)
        pad_layer(bed, chords, key, bar, bpc, "warm", 0.35, (300, 800), morph, 1.0, 2.0, 5, voices=2, lo=43, hi=60,
                  active=sec(0.2, 1.01))
        bass_layer(bed, chords, key, bar, bpc, 0.40, attack=0.3)
        boom_layer(bed, bar, bpc, n_bars, 0.55, active=lambda b: 0.25 <= b / n_bars < 0.95)
        rt, wet = 3.8, 0.30
    elif mood == "reflective":
        slow = (0.5 - 0.5 * np.cos(2 * np.pi * t)).astype(np.float32)
        pad_layer(bed, chords, key, bar, bpc, "sine", 0.70, (400, 900), slow, 2.5, 3.0, 6, voices=2, lo=57, hi=76)
        pad_layer(bed, chords, key, bar, bpc, "warm", 0.40, (250, 700), morph, 2.0, 3.0, 8, voices=2, lo=45, hi=62)
        drone_layer(bed, key, 0.30, slow, "sine")
        rt, wet = 4.8, 0.42
    elif mood == "prayerful":
        slow = (0.5 - 0.5 * np.cos(2 * np.pi * t + rng.uniform(0, 6.28))).astype(np.float32)
        pad_layer(bed, chords, key, bar, bpc, "warm", 0.75, (350, 1000), slow, 2.2, 3.0, 7, voices=3)
        drone_layer(bed, key, 0.40, slow, "warm")
        bass_layer(bed, chords, key, bar, bpc, 0.18, active=sec(0.3, 0.9), attack=0.6)
        rt, wet = 4.2, 0.38
    elif mood == "uplifting":
        pad_layer(bed, chords, key, bar, bpc, "saw", 0.45, (600, 1700), morph, 0.6, 1.2, 10, voices=2)
        pulse_layer(bed, chords, key, bar, bpc, 0.22, morph, active=sec(0.0, 1.01))
        bass_layer(bed, chords, key, bar, bpc, 0.35, attack=0.04)
        boom_layer(bed, bar, 2, n_bars, 0.25, active=lambda b: 0.25 <= b / n_bars < 0.9)
        rt, wet = 2.8, 0.25

    progress(0.6, "reverb")
    x = np.stack([bed.L, bed.R]).astype(np.float64)        # (2, n)
    x = reverb(x, bed.rng, rt, wet)
    x = tone_shape(x)
    x -= x.mean(1, keepdims=True)
    progress(0.85, "loudness -14 LUFS")
    loud = lufs(x)
    g = 10 ** ((-14.0 - loud) / 20)
    tp = true_peak(x) + 20 * math.log10(g)
    if tp > -1.5:                                            # keep >= 1.5 dB true-peak headroom (bed sits lower)
        g *= 10 ** ((-1.5 - tp) / 20)
        tp = -1.5
    x *= g
    info = {"mood": mood, "seed": int(seed), "duration": round(n / SR, 3), "key": key, "bars": n_bars,
            "bpm": round(240.0 / (bar / SR), 2), "lufs": round(loud + 20 * math.log10(g), 2), "true_peak": round(tp, 2),
            "sample_peak_db": round(20 * math.log10(float(np.abs(x).max()) + 1e-12), 2)}
    x = np.ascontiguousarray(x.T)
    return x.astype(np.float32), info


def loop_seam(x: np.ndarray) -> float:
    """Jump at the loop point relative to the signal's typical sample-to-sample change (1.0 = ordinary)."""
    d = np.abs(np.diff(x, axis=0))
    seam = np.abs(x[0] - x[-1]).max()
    return float(seam / (np.percentile(d, 99.9) + 1e-12))


def write(x: np.ndarray, path: str, seed: int = 0):
    """16-bit FLAC (TPDF dither) or WAV by extension."""
    import soundfile as sf
    rng = np.random.default_rng(seed + 17)
    lsb = 1.0 / 32768
    y = x + (rng.random(x.shape, dtype=np.float32) - rng.random(x.shape, dtype=np.float32)) * lsb
    y = np.clip(y, -1.0, 1.0 - lsb)
    sf.write(path, y, SR, subtype="PCM_16")
