# Viku engine

Python 3.11 FastAPI engine for Viku (sermon video -> 1080x1920 reels, Odia / Hindi / English).
The HTTP contract is `../ARCHITECTURE.md`; this file covers setup and the engine-specific details.

## Setup + run
```
cd engine
uv sync                      # creates .venv (fastapi, uvicorn, numpy, opencv-python-headless, soundfile)
uv run viku-engine           # http://127.0.0.1:8765   (VIKU_PORT / VIKU_HOST override)
```
Needs `ffmpeg`/`ffprobe` on PATH (a full build: libass, `whisper`, `loudnorm`, `ebur128`).
Data dir: `%APPDATA%\Viku` (override with env `VIKU_DATA`). First start synthesizes the SFX, copies the seed
music and downloads the Noto fonts (OFL) into `<data>/fonts`.

One-time content (online):
```
POST /bible/download                      # eBible ory / hin2017 / eng-web -> <data>/bible/*.sqlite
POST /library/import {"seed": true}       # the 119 Before-the-Foundation + Salvation illustrations
POST /music/heygen {"intent": "..."}      # optional, needs `npx hyperframes auth login --device`
```

## Heavy models live in their own envs (subprocess runners)
| Part | Default (auto-detected, `/settings` -> `paths.*`) | Runner |
|---|---|---|
| Odia/Hindi ASR | `Documents\Claude\Projects\IndicConformerASR\.venv\Scripts\python.exe` + `models\indic-conformer-600m` | `viku/runners/indic_runner.py` - loads once, encodes each chunk once, RNNT text + CTC text + confidence (+ language id for `auto`) |
| English ASR | ffmpeg `whisper` filter + `~/.cache/whisper/ggml-base.en.bin` | in-process ffmpeg calls |
| Speech enhancement | `Documents\Claude\Projects\AI Video Editing\.dfnet\Scripts\python.exe` (DeepFilterNet 3) | `viku/runners/dfn_runner.py`; fallback `highpass+afftdn` (reported in `/health` `details.denoise_engine`) |
| Face pass (crop choice only) | `viku/assets/yunet.onnx` (OpenCV) | in-process |

`language: "auto"`: per ASR chunk, score = mean max CTC posterior under the language's token mask + 2 x posterior mass
on that language's tokens, for `or` and `hi`; the decision is smoothed (duration-weighted vote over +-3 neighbouring chunks,
because preachers switch language in blocks) and chunks that flip are re-decoded with the smoothed language.

## Jobs + events
Long work returns `{"job", "kind", "state"}`. Progress: `GET /events` (SSE, `data: {"job","kind","progress","message","state","result","error"}`),
or poll `GET /jobs/{id}`; cancel with `POST /jobs/{id}/cancel` (kills its ffmpeg / runner subprocesses). Two jobs run at a time.

## Pipeline (ports of the illustrating-sermon-reels skill scripts)
- `media/analyze.py` - whole-file 16 kHz wav, peaks (100/s), pauses (>= 0.25 s); per `range`: 540p proxy (keyframe every 1 s,
  `proxy_offset` = range start), shot cuts (frame difference), transcription (energy segmenter, max 6 s cues).
- `media/reel.py` - jump-cut join (frame-snapped, 12 ms fades) -> `framing.py` fixed crop per shot/segment (YuNet only chooses;
  still -> 405 px 9:16, walking -> wider crop over blurred fill; segments alternate z 1.0/1.12) -> DeepFilterNet -> caption re-ASR
  per segment (max 3.5 s, no cue crosses a join) -> cutaways + verse cards + music + SFX -> render: graded base, cross-zoom
  dissolves (0.7 s), shade, ASS (libass, `fontsdir=<data>/fonts`), voice + music bed (-19 dB, side-chain ducked, crossfade loop)
  + impact/swell SFX (never bell/chime/shimmer), two-pass loudnorm to -14 LUFS / TP -2 (=> <= -1.5 dBTP after AAC).
  Render QC (size, duration, ebur128 LUFS + true peak) is stored in `reel.exports[]`.
- `media/ass.py` - Noto Sans Oriya / Devanagari / Noto Sans styles; Latin runs inside Indic text switch to Noto Sans inline.

## Viku Brain v1 (`viku/brain/`)
- `clipfinder.py` windows (cues joined at pauses, 20-60 s, ending on a >= 0.4 s pause), features (energy, variance, speech rate,
  direct address, victory/enemy lexicon, scripture, ends-on-hope / negative, call-and-response share, ASR confidence, duration fit,
  semantic=0), z-scored, weighted by `weights.json`, non-max suppression; reasons + title per candidate.
- `planner.py` jump-cut planner (drops filler / repeats / call-and-response, cuts only in pauses >= 0.25 s, caps 60 s).
- `captions.py` dictionary fixes (+ `data/brain_seed/caption_corrections.jsonl`: safe pairs applied, unsafe ones flagged
  `seed_suggest`) + learned correction memory + RNNT/CTC disagreement + near-vocabulary flags.
- `cutaways.py` concept map (`concepts.json`, or/hi/en words -> English tags) + library search; `scripture.py` explicit
  references -> offline Bible -> cards during cutaways only.
- `feedback.py` `/feedback` JSONL; `/learn` = numpy logistic regression once >= 10 keep/reject labels exist
  (`<data>/models/brain/ranker.json`), rebuilds the correction memory.
- `embed.py` the Phase 3 hook (`available`, `embed_texts`, `similarity_to_favourites`) - neutral until a model is added.
- Lexicons / weights / dictionary are plain JSON next to the code - edit and restart.

## Quick API tour
```
POST /projects {"name","video_path","language":"or|hi|en|auto"}
POST /projects/{id}/analyze {"range":[7150,7300]}          # omit range = whole sermon
POST /projects/{id}/suggest {"count":5}
POST /projects/{id}/reels {"segments":[[s,e],...],"title","sub"}  -> reel id "<project>~<n>"
POST /reels/{id}/autobuild   POST /reels/{id}/render          # render autobuilds a draft first
POST /automate {"video_path" | "project_id", "language", "count", "range"}
GET  /bible/verse?ref=Romans 10:10&lang=or    GET /bible/search?q=...&lang=hi
GET  /library/search?q=fallen angel           GET /music
POST /captions/fix {"text","lang","alt"}      POST /feedback {"reel_id","kind","before","after"}   POST /learn
```
