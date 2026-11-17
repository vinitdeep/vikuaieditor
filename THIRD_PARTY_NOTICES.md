# Third-party notices - Viku (Sermon Reel Studio)

Generated from the engine (`GET /licences`, `uv run python -m viku.licences`); do not edit by hand.
Viku's own code is not covered here. Each component below keeps its own licence; full licence texts
are installed next to downloaded tools and models (LICENSE*.txt) or available at the linked URL.

## Runtime

### CPython 3.11.15
- Licence: PSF-2.0 - https://docs.python.org/3/license.html
- Delivered: installer (uv-managed python-build-standalone)
- Notice: Python (c) Python Software Foundation - PSF License Agreement. Build: https://github.com/astral-sh/python-build-standalone (its bundled libraries carry their own permissive licences, listed in the distribution).

### faster-whisper / CTranslate2
- Licence: MIT - https://github.com/SYSTRAN/faster-whisper
- Delivered: installer (Python packages faster-whisper, ctranslate2)
- Notice: faster-whisper (c) SYSTRAN - MIT; CTranslate2 (c) OpenNMT / SYSTRAN - MIT.

### uv (Astral)
- Licence: MIT OR Apache-2.0 - https://github.com/astral-sh/uv
- Delivered: installer (bundled uv.exe)

## Tools (downloaded on first run)

### DeepFilterNet 3 (deep-filter CLI 0.5.6)
- Licence: MIT OR Apache-2.0 - https://github.com/Rikorose/DeepFilterNet#license
- Source: https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe
- Corresponding source: https://github.com/Rikorose/DeepFilterNet
- Delivered: downloaded on first run
- Notice: DeepFilterNet (c) Hendrik Schroter - MIT OR Apache-2.0 - https://github.com/Rikorose/DeepFilterNet

### FFmpeg 9.0.2 (gyan.dev essentials build)
- Licence: GPL-3.0-or-later (built with --enable-gpl --enable-version3) - https://ffmpeg.org/legal.html
- Source: https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip
- Corresponding source: https://github.com/GyanD/codexffmpeg (build scripts) - FFmpeg source: https://ffmpeg.org/download.html#releases
- Delivered: downloaded on first run
- Notice: FFmpeg (c) the FFmpeg developers, https://ffmpeg.org. This Windows build by Gyan Doshi (gyan.dev, 'essentials') is configured with --enable-gpl --enable-version3 and therefore licensed GPL-3.0-or-later as a whole (libx264 GPL-2.0+, libass ISC, HarfBuzz MIT, FreeType FTL, FriBidi LGPL-2.1+). Viku runs it as a separate program and does not link it. The build's LICENSE file is installed next to ffmpeg.exe.

## Models

### IndicConformer 600M multilingual (AI4Bharat) rev 2a77d305
- Licence: MIT - https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual
- Source: https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual/resolve/2a77d305038dfc502fd9464e7d028b90381976cb/assets/Constant_1970_attr__value
- Delivered: downloaded on first run
- Notice: IndicConformer 600M multilingual (c) AI4Bharat, IIT Madras - MIT License. Inference code vendored in viku/runners/indic_model.py (MIT). Gated download: the user accepts AI4Bharat's terms on Hugging Face.

### multilingual-e5-small (ONNX)
- Licence: MIT - https://huggingface.co/intfloat/multilingual-e5-small
- Source: https://huggingface.co/intfloat/multilingual-e5-small/resolve/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx/model.onnx
- Delivered: downloaded on first run
- Notice: multilingual-e5-small (c) Microsoft / Liang Wang et al. (intfloat) - MIT License.

### U-2-Net human segmentation
- Licence: Apache-2.0 (U-2-Net) / MIT (rembg export) - https://github.com/xuebinqin/U-2-Net
- Source: https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx
- Delivered: downloaded on first run
- Notice: U-2-Net human segmentation (Qin et al. 2020) - Apache License 2.0 - https://github.com/xuebinqin/U-2-Net ONNX export: rembg by Daniel Gatis - MIT License - https://github.com/danielgatis/rembg

### Whisper base.en (faster-whisper / CTranslate2)
- Licence: MIT - https://huggingface.co/Systran/faster-whisper-base.en
- Source: https://huggingface.co/Systran/faster-whisper-base.en/resolve/3d3d5dee26484f91867d81cb899cfcf72b96be6c/config.json
- Delivered: downloaded on first run
- Notice: Whisper (c) OpenAI - MIT License; CTranslate2 conversion by SYSTRAN (faster-whisper) - MIT License.

### Whisper small multilingual (faster-whisper)
- Licence: MIT - https://huggingface.co/Systran/faster-whisper-small
- Source: https://huggingface.co/Systran/faster-whisper-small/resolve/536b0662742c02347bc0e980a01041f333bce120/config.json
- Delivered: downloaded on first run
- Notice: Whisper (c) OpenAI - MIT License; CTranslate2 conversion by SYSTRAN (faster-whisper) - MIT License.

### YuNet face detector (OpenCV Zoo) 2023mar
- Licence: MIT - https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
- Delivered: bundled with the engine
- Notice: YuNet face detector (c) Shiqi Yu, Wei Wu et al. - from OpenCV Zoo, MIT License.

## Fonts

### Noto Sans Oriya / Devanagari / Latin notofonts.github.io @983116f
- Licence: SIL Open Font License 1.1 - https://openfontlicense.org
- Source: https://raw.githubusercontent.com/notofonts/notofonts.github.io/983116fbb1e1c231cf33f1f4ec0f9456055fe1e1/fonts/NotoSansOriya/hinted/ttf/NotoSansOriya-Bold.ttf
- Delivered: downloaded on first run
- Notice: Noto Sans, Noto Sans Oriya, Noto Sans Devanagari (c) The Noto Project Authors (https://github.com/notofonts) - SIL Open Font License 1.1. The OFL text is installed as fonts/LICENSE-OFL.txt.

## Bible texts

### Indian Revised Version (IRV) Hindi hin2017
- Licence: CC BY-SA 4.0 - https://creativecommons.org/licenses/by-sa/4.0/
- Attribution (exact): "Indian Revised Version (IRV) Hindi © 2017, 2018, 2019 Bridge Connectivity Solutions, CC BY-SA 4.0"
- Source: https://ebible.org/Scriptures/hin2017_usfm.zip
- Delivered: downloaded on first run (eBible.org USFM)
- Notice: Reels quoting this text must carry the attribution above (the verse card / description); adapted verse text is shared under CC BY-SA 4.0.

### Indian Revised Version (IRV) Odia ory
- Licence: CC BY-SA 4.0 - https://creativecommons.org/licenses/by-sa/4.0/
- Attribution (exact): "Indian Revised Version (IRV) Odia © 2017, 2019, 2021 Bridge Connectivity Solutions, CC BY-SA 4.0"
- Source: https://ebible.org/Scriptures/ory_usfm.zip
- Delivered: downloaded on first run (eBible.org USFM)
- Notice: Reels quoting this text must carry the attribution above (the verse card / description); adapted verse text is shared under CC BY-SA 4.0.

### World English Bible (WEB) eng-web
- Licence: Public domain - https://worldenglish.bible/
- Attribution (exact): "World English Bible (WEB), public domain"
- Source: https://ebible.org/Scriptures/eng-web_usfm.zip
- Delivered: downloaded on first run (eBible.org USFM)
- Notice: The name "World English Bible" is a trademark; the text is public domain.

## Viku content (bundled / generated)

### Viku generated music
- Licence: Royalty-free - generated on your PC by Viku's music generator; free to use in any video
- Delivered: made on first run (5 default moods) and on demand (Library > Music > Generate music); no recordings, samples or licensed tracks are shipped
- Notice: Procedural synthesis (viku/music_gen.py). Tracks from HeyGen or your own files keep their own licences.

### Viku starter illustrations
- Licence: AI-generated (Google Gemini / AI Studio) by the Viku project, free to use in Viku videos
- Delivered: bundled with the installer (119 images, 1080x1920 JPEG), imported into an empty library on first run
- Notice: Created for Viku's sermon reels with Google Gemini / AI Studio image generation. Free to use in videos made with Viku; Google's Generative AI terms apply to the generation.

## Python packages (engine environment)

| Package | Version | Licence | Project |
|---|---|---|---|
| annotated-doc | 0.0.6 | MIT | https://github.com/fastapi/annotated-doc |
| annotated-types | 0.8.0 | MIT | https://github.com/annotated-types/annotated-types |
| anyio | 4.16.0 | MIT | https://github.com/agronholm/anyio |
| av | 18.1.0 | BSD-3-Clause | https://github.com/PyAV-Org/PyAV |
| cffi | 2.1.1 | MIT-0 | https://github.com/python-cffi/cffi |
| click | 8.5.1 | BSD-3-Clause | https://github.com/pallets/click/ |
| colorama | 0.4.6 | BSD-3-Clause | https://github.com/tartley/colorama |
| ctranslate2 | 4.9.0 | MIT | https://opennmt.net |
| fastapi | 0.163.1 | MIT | https://github.com/fastapi/fastapi |
| faster-whisper | 1.2.1 | MIT | https://github.com/SYSTRAN/faster-whisper |
| filelock | 4.2.10 | MIT | https://github.com/tox-dev/filelock |
| flatbuffers | 25.12.19 | Apache-2.0 | https://google.github.io/flatbuffers/ |
| fsspec | 2026.9.0 | BSD-3-Clause | https://github.com/fsspec/filesystem_spec |
| h11 | 0.16.0 | MIT | https://github.com/python-hyper/h11 |
| hf-xet | 1.8.0 | Apache-2.0 | https://github.com/huggingface/xet-core.git |
| httpcore2 | 2.16.2 | BSD-3-Clause | https://github.com/pydantic/httpx2/blob/main/src/httpcore2 |
| httpx2 | 2.16.2 | BSD-3-Clause | https://github.com/pydantic/httpx2 |
| huggingface-hub | 2.4.0 | Apache-2.0 | https://github.com/huggingface/huggingface_hub |
| idna | 3.20 | BSD-3-Clause | https://github.com/kjd/idna |
| jinja2 | 3.1.6 | BSD-3-Clause | https://github.com/pallets/jinja/ |
| markupsafe | 3.0.4 | BSD-3-Clause | https://github.com/pallets/markupsafe/ |
| mpmath | 1.3.0 | BSD-3-Clause | http://mpmath.org/ |
| networkx | 3.6.1 | BSD-3-Clause | https://github.com/networkx/networkx |
| numpy | 2.4.6 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | https://github.com/numpy/numpy |
| onnxruntime | 1.32.0 | MIT | https://onnxruntime.ai |
| opencv-python-headless | 5.0.0.93 | Apache-2.0 (OpenCV; the wheel bundles FFmpeg libraries under LGPL-2.1) | https://github.com/opencv/opencv-python |
| opentelemetry-api | 1.45.2 | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-python |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause | https://github.com/pypa/packaging |
| pillow | 13.0.0 | MIT-CMU | https://github.com/python-pillow/Pillow |
| protobuf | 7.36.2 | BSD-3-Clause | https://developers.google.com/protocol-buffers/ |
| pycparser | 3.12 | BSD-3-Clause | https://github.com/eliben/pycparser |
| pydantic | 2.14.3 | MIT | https://github.com/pydantic/pydantic |
| pydantic-core | 2.50.4 | MIT | https://github.com/pydantic/pydantic |
| pyyaml | 6.0.3 | MIT | https://pyyaml.org/ |
| setuptools | 84.2.1 | MIT | https://github.com/pypa/setuptools |
| soundfile | 0.14.0 | BSD-3-Clause | https://github.com/bastibe/python-soundfile |
| starlette | 1.10.0 | BSD-3-Clause | https://github.com/Kludex/starlette |
| sympy | 1.14.0 | BSD-3-Clause | https://sympy.org |
| tokenizers | 0.23.3 | Apache-2.0 | https://github.com/huggingface/tokenizers |
| torch | 2.15.0+cpu | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND ISC AND MIT AND Zlib | https://github.com/pytorch/pytorch |
| tqdm | 4.70.1 | MPL-2.0 AND MIT | https://github.com/tqdm/tqdm |
| truststore | 0.10.5 | MIT | https://github.com/sethmlarson/truststore |
| typing-extensions | 4.16.0 | PSF-2.0 | https://github.com/python/typing_extensions |
| typing-inspection | 0.4.5 | MIT | https://github.com/pydantic/typing-inspection |
| uvicorn | 0.54.0 | BSD-3-Clause | https://github.com/Kludex/uvicorn |
