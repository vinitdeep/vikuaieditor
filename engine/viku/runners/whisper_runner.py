"""faster-whisper (CTranslate2, MIT) English runner - a subprocess of the engine (same env, `asr` dependency group).

    <python> whisper_runner.py <request.json> <result.json>

request = {"model_dir": ".../models/whisper/base.en", "wav": "16k mono wav", "chunks": [[s, e], ...], "lang": "en"}
result  = {"chunks": [{"start","end","lang","text","conf"}]}   conf = exp(mean token log-prob) of the chunk.
Progress lines on stdout: "PROGRESS <done> <total>".
"""
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf


def main():
    req = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_path = Path(sys.argv[2])
    from faster_whisper import WhisperModel

    threads = int(req.get("threads") or max(1, (os.cpu_count() or 4) - 1))
    model = WhisperModel(req["model_dir"], device="cpu", compute_type="int8", cpu_threads=threads)
    multilingual = model.model.is_multilingual
    wav, sr = sf.read(req["wav"], dtype="float32", always_2d=False)
    if wav.ndim > 1:
        wav = wav.mean(1)
    assert sr == 16000, f"need 16 kHz wav, got {sr}"
    chunks = req["chunks"]
    res = []
    print(f"PROGRESS 0 {len(chunks)}", flush=True)
    for i, (s, e) in enumerate(chunks):
        x = np.ascontiguousarray(wav[int(s * sr): int(e * sr)])
        item = {"start": s, "end": e, "lang": "en", "text": "", "conf": 0.0}
        if len(x) >= sr * 0.2:
            segs, _ = model.transcribe(x, language="en" if multilingual else None, beam_size=5,
                                       condition_on_previous_text=False, vad_filter=False,
                                       without_timestamps=True, temperature=0.0)
            segs = list(segs)
            item["text"] = " ".join(sg.text.strip() for sg in segs).strip()
            lp = [sg.avg_logprob for sg in segs if sg.text.strip()]
            item["conf"] = round(math.exp(sum(lp) / len(lp)), 4) if lp else 0.0
            if segs and all(sg.no_speech_prob > 0.6 for sg in segs):
                item["text"] = ""
        res.append(item)
        print(f"PROGRESS {i + 1} {len(chunks)}", flush=True)
    out_path.write_text(json.dumps({"chunks": res}, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
