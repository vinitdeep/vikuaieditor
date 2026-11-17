# Minimal inference port of AI4Bharat IndicConformer-600M-multilingual `model_onnx.py`
# (https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual, revision 2a77d305).
#
# MIT License
# Copyright (c) AI4Bharat (Indian Institute of Technology Madras)
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so, subject to the following conditions:
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of
# the Software.
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
# THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
# TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
#
# Viku changes: no `transformers` / `huggingface_hub` dependency (plain config object, local folder only), CPU only,
# per-language joint post-nets load lazily (only the languages actually decoded). Encoder / CTC / RNNT greedy decoding
# is unchanged from upstream, so the text matches the upstream model_onnx.py.
"""IndicConformer inference: TorchScript mel preprocessor + ONNX encoder, CTC and RNNT decoders.

    m = IndicASRModel(IndicASRConfig(ts_folder="<dir containing assets/>"))
    enc, enc_len = m.encode(wav_tensor_1xN_16k)
    text = m._rnnt_decode(enc, enc_len, "or")
"""
from __future__ import annotations

import json
import os

import numpy as np
import onnxruntime as ort
import torch

SHARED = ["encoder", "ctc_decoder", "rnnt_decoder", "joint_enc", "joint_pred", "joint_pre_net"]


class IndicASRConfig:
    def __init__(self, ts_folder: str = "path", BLANK_ID: int = 256, RNNT_MAX_SYMBOLS: int = 10,
                 PRED_RNN_LAYERS: int = 2, PRED_RNN_HIDDEN_DIM: int = 640, SOS: int = 5632,
                 FRAME_DURATION_MS: float = 0.08, threads: int = 0):
        self.ts_folder = ts_folder
        self.BLANK_ID = BLANK_ID
        self.RNNT_MAX_SYMBOLS = RNNT_MAX_SYMBOLS
        self.PRED_RNN_LAYERS = PRED_RNN_LAYERS
        self.PRED_RNN_HIDDEN_DIM = PRED_RNN_HIDDEN_DIM
        self.SOS = SOS
        self.FRAME_DURATION_MS = FRAME_DURATION_MS
        self.threads = threads


class IndicASRModel:
    def __init__(self, config: IndicASRConfig):
        self.config = config
        self.d = torch.device("cpu")
        a = os.path.join(config.ts_folder, "assets")
        self._assets = a
        self._opts = ort.SessionOptions()
        if config.threads:
            self._opts.intra_op_num_threads = config.threads
        self.models = {"preprocessor": torch.jit.load(os.path.join(a, "preprocessor.ts"), map_location=self.d)}
        for n in SHARED:
            self.models[n] = self._session(n)
        with open(os.path.join(a, "vocab.json"), encoding="utf-8") as r:
            self.vocab = json.load(r)
        with open(os.path.join(a, "language_masks.json"), encoding="utf-8") as r:
            self.language_masks = json.load(r)

    def _session(self, name: str):
        return ort.InferenceSession(os.path.join(self._assets, f"{name}.onnx"), self._opts,
                                    providers=["CPUExecutionProvider"])

    def post_net(self, lang: str):
        key = f"joint_post_net_{lang}"
        if key not in self.models:
            self.models[key] = self._session(key)
        return self.models[key]

    def encode(self, wav):
        audio_signal, length = self.models["preprocessor"](input_signal=wav.to(self.d),
                                                           length=torch.tensor([wav.shape[-1]]).to(self.d))
        outputs, encoded_lengths = self.models["encoder"].run(
            ["outputs", "encoded_lengths"], {"audio_signal": audio_signal.cpu().numpy(), "length": length.cpu().numpy()})
        return outputs, encoded_lengths

    def _ctc_decode(self, encoder_outputs, encoded_lengths, lang):
        logprobs = self.models["ctc_decoder"].run(["logprobs"], {"encoder_output": encoder_outputs})[0]
        logprobs = torch.from_numpy(logprobs[:, :, self.language_masks[lang]]).log_softmax(dim=-1)
        indices = torch.argmax(logprobs[0], dim=-1)
        collapsed = torch.unique_consecutive(indices, dim=-1)
        return "".join([self.vocab[lang][x] for x in collapsed if x != self.config.BLANK_ID]).replace("▁", " ").strip()

    def _rnnt_decode(self, encoder_outputs, encoded_lengths, lang):
        joint_enc = self.models["joint_enc"].run(["output"], {"input": encoder_outputs.transpose(0, 2, 1)})[0]
        joint_enc = torch.from_numpy(joint_enc)
        post = self.post_net(lang)
        hyp = [self.config.SOS]
        prev_dec_state = (np.zeros((self.config.PRED_RNN_LAYERS, 1, self.config.PRED_RNN_HIDDEN_DIM), dtype=np.float32),
                          np.zeros((self.config.PRED_RNN_LAYERS, 1, self.config.PRED_RNN_HIDDEN_DIM), dtype=np.float32))
        for t in range(joint_enc.size(1)):
            f = joint_enc[:, t, :].unsqueeze(1)
            not_blank = True
            symbols_added = 0
            while not_blank and (self.config.RNNT_MAX_SYMBOLS is None or symbols_added < self.config.RNNT_MAX_SYMBOLS):
                g, _, dec_state_0, dec_state_1 = self.models["rnnt_decoder"].run(
                    ["outputs", "prednet_lengths", "states", "162"],
                    {"targets": np.array([[hyp[-1]]], dtype=np.int32),
                     "target_length": np.array([1], dtype=np.int32),
                     "states.1": prev_dec_state[0],
                     "onnx::Slice_3": prev_dec_state[1]})
                g = self.models["joint_pred"].run(["output"], {"input": g.transpose(0, 2, 1)})[0]
                joint_out = f + g
                joint_out = self.models["joint_pre_net"].run(["output"], {"input": joint_out.numpy()})[0]
                logits = post.run(["output"], {"input": joint_out})[0]
                pred_token = torch.from_numpy(logits).log_softmax(dim=-1).argmax(dim=-1).item()
                if pred_token == self.config.BLANK_ID:
                    not_blank = False
                else:
                    hyp.append(pred_token)
                    prev_dec_state = (dec_state_0, dec_state_1)
                symbols_added += 1
        return "".join([self.vocab[lang][x] for x in hyp if x != self.config.SOS]).replace("▁", " ").strip()
