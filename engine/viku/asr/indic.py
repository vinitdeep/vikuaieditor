"""IndicConformer (AI4Bharat 600M multilingual, ONNX) adapter for Odia / Hindi.

Runs viku/runners/indic_runner.py (vendored AI4Bharat model code, viku/runners/indic_model.py) as a subprocess with the
engine's own python (needs the `asr` dependency group: torch CPU + onnxruntime) or settings paths.indic_python; weights
from the model manager (<data>/models/indic-conformer-600m) or settings paths.indic_dir. One process per call: the model loads once and
transcribes every chunk; RNNT text is the caption, CTC text rides along as "alt" so the
caption fixer can flag words where the two decoders disagree.

language "auto": each chunk gets a language score per candidate (or, hi) from the CTC
posteriors (mean max posterior under that language's token mask + 2 x posterior mass on that
language's tokens). Because a preacher switches language in blocks, the per-chunk decision is
smoothed: duration-weighted vote of score margins over +-3 neighbouring chunks. Chunks whose
smoothed language differs from their own are re-decoded with the smoothed language.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

from .. import config
from ..jobs import Job, JobError

RUNNER = Path(__file__).resolve().parent.parent / "runners" / "indic_runner.py"
CANDS = ["or", "hi"]


def model_dir() -> Path:
    from .. import models
    return Path(models.indic_model_dir() or ".")


def python() -> str:
    """Interpreter for the runner: settings.paths.indic_python -> this env (when torch is installed) -> legacy venv."""
    py = config.path("indic_python")
    if py and Path(py).is_file():
        return py
    if runtime_ok():
        return sys.executable
    return config.legacy("indic_python")


_rt: bool | None = None


def runtime_ok() -> bool:
    """torch + onnxruntime importable in the engine env (checked without importing torch into the server)."""
    global _rt
    if _rt is None:
        _rt = all(importlib.util.find_spec(m) is not None for m in ("torch", "onnxruntime", "soundfile"))
    return _rt


def available() -> bool:
    py = python()
    return bool(py) and Path(py).exists() and (model_dir() / "assets" / "encoder.onnx").exists()


def _run(wav: str, chunks: list, lang: str, job: Job, ctc: bool, prog=(0.0, 1.0)) -> list[dict]:
    if not available():
        raise JobError("IndicConformer (Odia/Hindi speech recognition) is not installed - finish first-run setup "
                       "(POST /models/install {\"ids\": [\"indic-conformer\"]})")
    tmp = Path(tempfile.mkdtemp(prefix="viku_asr_"))
    req = tmp / "req.json"
    res = tmp / "res.json"
    req.write_text(json.dumps({"model_dir": str(model_dir()), "wav": str(wav), "chunks": chunks, "lang": lang,
                               "candidates": CANDS, "ctc": ctc}), encoding="utf-8")
    import subprocess
    p = job.popen([python(), "-X", "utf8", str(RUNNER), str(req), str(res)],
                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(tmp))
    tail = []
    try:
        for line in iter(p.stdout.readline, b""):
            s = line.decode("utf-8", "replace").strip()
            if s.startswith("PROGRESS"):
                _, d, n = s.split()
                f = int(d) / max(int(n), 1)
                job.update(prog[0] + (prog[1] - prog[0]) * f, f"transcribing {d}/{n}")
            elif s:
                tail = (tail + [s])[-20:]
        p.wait()
    finally:
        job.release(p)
    job.check()
    if p.returncode != 0 or not res.exists():
        raise JobError("IndicConformer runner failed: " + " | ".join(tail[-6:]))
    return json.loads(res.read_text(encoding="utf-8"))["chunks"]


def smooth_languages(items: list[dict], k: int = 3) -> list[str]:
    out = []
    for i in range(len(items)):
        tot, seen = {c: 0.0 for c in CANDS}, False
        for j in range(max(0, i - k), min(len(items), i + k + 1)):
            lid = items[j].get("lid") or {}
            if not lid:
                continue
            seen = True
            w = (items[j]["end"] - items[j]["start"]) * (2.0 if j == i else 1.0)
            best = max(c["score"] for c in lid.values())
            for c in CANDS:
                if c in lid:
                    tot[c] += w * (lid[c]["score"] - best)
        out.append(max(tot, key=tot.get) if seen else items[i].get("lang", CANDS[0]))
    return out


def transcribe(wav: str, chunks: list, lang: str, job: Job, ctc: bool = True) -> list[dict]:
    items = _run(wav, chunks, lang, job, ctc, prog=(0.0, 0.9 if lang == "auto" else 1.0))
    if lang == "auto":
        sm = smooth_languages(items)
        redo = {i: L for i, (it, L) in enumerate(zip(items, sm)) if it.get("lid") and it["lang"] != L}
        for L in set(redo.values()):
            idx = [i for i, v in redo.items() if v == L]
            again = _run(wav, [chunks[i] for i in idx], L, job, ctc, prog=(0.9, 1.0))
            for i, it in zip(idx, again):
                it["lid"] = items[i].get("lid")
                items[i] = it
    out = []
    for it in items:
        if not it.get("text"):
            continue
        out.append({"start": round(float(it["start"]), 3), "end": round(float(it["end"]), 3), "text": it["text"],
                    "lang": it["lang"], "conf": it.get("conf", 0.0), "alt": it.get("ctc")})
    return out
