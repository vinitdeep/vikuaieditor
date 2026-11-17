"""IndicConformer batch runner - a subprocess of the engine (the engine's own env, `asr` dependency group: torch CPU +
onnxruntime), or any python with those packages (settings paths.indic_python).

    <python> indic_runner.py <request.json> <result.json>

Model code: the vendored `indic_model.py` next to this file (MIT, AI4Bharat); weights: the model manager's
<data>/models/indic-conformer-600m (or settings paths.indic_dir).

request = {"model_dir": ".../models/indic-conformer-600m", "wav": "16k mono wav",
           "chunks": [[s, e], ...] (seconds in that wav), "lang": "or"|"hi"|"auto",
           "candidates": ["or", "hi"], "ctc": true}
result  = {"chunks": [{"start","end","lang","text" (RNNT),"ctc" (CTC text|null),"conf","lid":{lang: score}}]}

The model loads once; each chunk is encoded once and decoded with RNNT (and CTC when asked)
from the same encoder output. conf = mean max CTC posterior over non-blank frames.
Language id ("auto"): CTC posterior mass that falls on each candidate language's tokens
(full-vocab softmax), averaged over speech frames; the larger mass wins.
Progress lines on stdout: "PROGRESS <done> <total>".
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch


def main():
    req = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_path = Path(sys.argv[2])
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from indic_model import IndicASRConfig, IndicASRModel  # noqa: E402

    model = IndicASRModel(IndicASRConfig(ts_folder=req["model_dir"]))
    blank = model.config.BLANK_ID
    wav, sr = sf.read(req["wav"], dtype="float32", always_2d=False)
    if wav.ndim > 1:
        wav = wav.mean(1)
    assert sr == 16000, f"need 16 kHz wav, got {sr}"
    lang_req = req.get("lang", "or")
    cands = req.get("candidates") or ["or", "hi"]
    want_ctc = bool(req.get("ctc", True))
    chunks = req["chunks"]
    res = []
    print(f"PROGRESS 0 {len(chunks)}", flush=True)
    for i, (s, e) in enumerate(chunks):
        x = wav[int(s * sr): int(e * sr)]
        item = {"start": s, "end": e, "lang": lang_req, "text": "", "ctc": None, "conf": 0.0, "lid": {}}
        if len(x) < sr * 0.2:
            res.append(item)
            continue
        t = torch.from_numpy(np.ascontiguousarray(x)).unsqueeze(0)
        with torch.inference_mode():
            enc, enc_len = model.encode(t)
            raw = model.models["ctc_decoder"].run(["logprobs"], {"encoder_output": enc})[0][0]  # (T, V)
            T = int(enc_len[0])
            raw = raw[:T]
            p = np.exp(raw - raw.max(-1, keepdims=True))
            p /= p.sum(-1, keepdims=True)
            fblank = p.shape[1] - 1  # blank is the last token of the full vocab (shared by all languages)
            speech = p[:, fblank] < 0.5
            lang = lang_req
            if lang_req == "auto":
                for c in cands:
                    m = [k for k in np.flatnonzero(model.language_masks[c]) if k != fblank]
                    mass = float(p[speech][:, m].sum(1).mean()) if speech.any() else 0.0
                    lpc = torch.from_numpy(raw[None, :, model.language_masks[c]]).log_softmax(dim=-1)[0]
                    pmc = lpc.exp().max(-1).values.numpy()
                    nbc = (lpc.argmax(-1) != blank).numpy()
                    conf = float(pmc[nbc].mean()) if nbc.any() else 0.0
                    item["lid"][c] = {"mass": round(mass, 4), "conf": round(conf, 4), "score": round(conf + 2 * mass, 4)}
                lang = max(item["lid"], key=lambda k: item["lid"][k]["score"]) if item["lid"] else cands[0]
            item["lang"] = lang
            # per-language CTC (masked) for text + confidence
            lp = torch.from_numpy(raw[None, :, model.language_masks[lang]]).log_softmax(dim=-1)[0]
            pm = lp.exp().max(-1).values.numpy()
            idx = lp.argmax(-1)
            nb = (idx != blank).numpy()  # masked vocab: blank = BLANK_ID (256)
            item["conf"] = round(float(pm[nb].mean()) if nb.any() else 0.0, 4)
            if want_ctc:
                col = torch.unique_consecutive(idx)
                item["ctc"] = "".join(model.vocab[lang][int(k)] for k in col if int(k) != blank).replace("▁", " ").strip()
            item["text"] = model._rnnt_decode(enc, enc_len, lang).strip()
        res.append(item)
        print(f"PROGRESS {i + 1} {len(chunks)}", flush=True)
    out_path.write_text(json.dumps({"chunks": res}, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
