# Viku engine

Python 3.11 FastAPI engine for Viku (sermon video -> 1080x1920 reels, Odia / Hindi / English).
The HTTP contract is `../ARCHITECTURE.md`; this file covers setup and the engine-specific details.

## Setup + run
```
cd engine
uv sync                      # .venv incl. the `asr` group (torch CPU from download.pytorch.org/whl/cpu, faster-whisper)
uv run viku-engine           # http://127.0.0.1:8765   (VIKU_PORT / VIKU_HOST override)
```
Data dir: `%APPDATA%\Viku` (override with env `VIKU_DATA`). Nothing is read from anyone's personal folders: tools and
models come from the model manager (below). First start synthesizes the SFX, copies the seed music and fetches the
Noto fonts.

**Installer / clean PC**: `scripts/bootstrap.ps1 -Uv <bundled uv.exe> -InstallDir <dir> [-DataDir <dir>] [-Port 8765]
[-NoStart] [-CleanCache]` copies the engine into `<dir>\engine`, installs uv-managed CPython 3.11 into `<dir>\python`
(`UV_PYTHON_INSTALL_DIR`, `UV_PYTHON_PREFERENCE=only-managed`, cache in `<dir>\uv-cache`), runs
`uv sync --frozen --no-dev --group asr`, smoke-tests the imports and starts the engine. It prints
`PROGRESS <0-100> <message>` lines and ends with `READY <url>` or `ERROR <message>`. Idempotent (a uv.lock hash stamp
skips the sync - a rerun takes ~4 s; a running engine is reused). Verified into a fresh `%TEMP%` dir: 46 packages in
~1 min on this PC; venv 906 MB + python 70 MB (+ 883 MB uv cache, removed with `-CleanCache`).

One-time content (online):
```
POST /models/install {}                    # every required tool/model that is missing (job, byte progress)
POST /bible/download                      # eBible ory / hin2017 / eng-web -> <data>/bible/*.sqlite
POST /library/import {"seed": true}       # the 119 Before-the-Foundation + Salvation illustrations
POST /music/heygen {"intent": "..."}      # optional, needs `npx hyperframes auth login --device`
```

## Model & tool manager (`viku/models.py`, `viku/manifests/`)
`GET /models` -> `[{id, name, purpose, size_mb, licence, licence_url, required, installed, source, path, gated,
partial_mb}]`; `POST /models/install {ids?, source_dir?}` -> job (byte progress in `message` / `result`);
`POST /models/remove {ids}`. Every file is pinned (release tag / HF revision + size + SHA-256). Downloads go to
`<data>/downloads/<id>/*.part`, resume with HTTP Range after a cancel / network drop (tested: cancelled at 185 MB,
resumed from there), are SHA-256 verified, then moved into place with `os.replace`. `source_dir` installs from a local
folder (USB stick / another PC), still verified. The Authorization header is never forwarded to redirect hosts.

| id | download | licence | required | installs to |
|---|---|---|---|---|
| ffmpeg (gyan.dev 9.0.2 essentials: libass + harfbuzz, x264) | 115 MB zip | GPL-3.0 | yes | `<data>/tools/ffmpeg/` |
| deep-filter (DeepFilterNet 3 Rust CLI 0.5.6) | 27 MB | MIT / Apache-2.0 | yes | `<data>/tools/deep-filter/` |
| indic-conformer (ai4bharat 600M multilingual @2a77d305) | 2,556 MB | MIT | yes | `<data>/models/indic-conformer-600m/` |
| e5-small (multilingual-e5-small ONNX) | 487 MB | MIT | yes | `<data>/models/embed/multilingual-e5-small/` |
| fonts (Noto Sans Oriya / Devanagari / Latin) | 2 MB | OFL-1.1 | yes | `<data>/fonts/` |
| yunet (OpenCV Zoo) | bundled | MIT | yes | `viku/assets/` |
| whisper-base-en (faster-whisper) | 148 MB | MIT | no | `<data>/models/whisper/base.en/` |
| whisper-small (faster-whisper) | 486 MB | MIT | no | `<data>/models/whisper/small/` |
| u2net-human-seg (thumbnail cut-out) | 176 MB | Apache-2.0 / MIT | no | `<data>/models/cutout/` |

Required total ~3.2 GB download (+ ~0.35 GB of Python packages via bootstrap). **IndicConformer is a gated Hugging
Face repo** (anonymous download = HTTP 401): the user needs a free HF account, "agree" on the model page and a read
token in settings `hf_token` (or env `HF_TOKEN`); or the app sets `settings.model_mirrors["indic-conformer"]` to a
mirror base URL (MIT allows redistribution); or installs from a folder. HF masks its LFS hashes for anonymous callers,
so the manifest SHA-256s come from the working copy that produced the verified transcripts (all sizes and every
non-LFS git blob hash match HF). Re-pin any model with `scripts/make_manifest.py <repo> <revision> <out.json>`.

Tool resolution: `ffmpeg()` / `ffprobe()` = settings `paths.ffmpeg` -> managed copy -> PATH ffmpeg when
`allow_system_tools` and it is >= 6 with libass + libx264. `settings.legacy_tools` (default false) re-enables the
original dev machine's venvs (`config.legacy_paths()`) as a last resort. `/health` -> `setup_needed`,
`setup_missing` (required ids, plus `asr-runtime` when torch is missing), `models {id: {installed, source, required}}`,
`llm` (Ollama), `details.ffmpeg / ffmpeg_source / denoise_engine / asr_en_engine / asr_runtime`.

## Speech models
| Part | Engine | Notes |
|---|---|---|
| Odia/Hindi ASR | `viku/runners/indic_runner.py` + vendored `indic_model.py` (AI4Bharat MIT code, no transformers), subprocess of the engine's own python (`asr` group) | loads once, encodes each chunk once, RNNT text + CTC text + confidence (+ language id for `auto`). Identical output (text, CTC, language, confidence) to the old IndicConformerASR venv on 30 s Odia, Hindi and `auto` samples. `paths.indic_python` / `paths.indic_dir` override |
| English ASR | `viku/runners/whisper_runner.py`: faster-whisper int8 CPU, base.en preferred, small if it is the only one | fallback: ffmpeg `whisper` filter + ggml (`paths.whisper_model`) when the ffmpeg build has it. Test clip (TTS, 9 s): base.en exact in 2.0 s; small (forced en) dropped the first sentence |
| Speech enhancement | `deep-filter -D` (48 kHz mono in; output padded back to the input length) | same DeepFilterNet3 model as the Python package: on reel ~2 CLI vs venv output correlate 0.99999 at lag 0; frame noise floor (p10) raw -50.0 / venv -52.3 / CLI -51.8 dB, quiet-frame spectrum within 0.2 dB per band. Fallbacks: `paths.dfnet_python` venv (`dfn_runner.py`), then ffmpeg `highpass+afftdn` |
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

## Viku Brain (`viku/brain/`)
- `embed.py` **multilingual-e5-small** (MIT) on onnxruntime CPU + `tokenizers`; model in `<data>/models/embed/multilingual-e5-small/`
  (copied from the repo's `models/embed/.../onnx/` on first use, else downloaded from Hugging Face). "query: " / "passage: "
  prefixes, masked mean pool + L2 -> 384-d; length-sorted batches; every embedding cached by sha1(prefix+text) in
  `<data>/models/embed/cache.sqlite`. Session load ~1.4 s, a sermon window ~10-70 ms.
- `ranker.py` clip ranker = logistic regression over engineered features (energy, energy_var, pace, direct address,
  victory, enemy, scripture, admin notice, ends on hope / negative, call-and-response, ASR confidence, duration fit;
  lexicons counted per cue in the cue's own language) + embedding features (cosine to the kept-minus-rejected centroids
  and an 8-d PCA projection). Columns are z-scored inside the sermon (shrunk toward the seed's stats when there are few
  windows). Shipped model: `ranker_seed.json` (+ `ranker_seed_rows.npz` for retraining), built by
  `uv run python -m viku.brain.train_seed` from `data/brain_seed` (662 labelled windows of two sermons; Before-the-Foundation
  audio from the test project). Honest CV, 5-min blocks held out: **AUC 0.858** (cross-sermon 0.80 / 0.82) vs the old
  hand weights 0.661 (0.732 even with the merged lexicon). `/suggest` reasons = the top positive contributions
  (embedding columns summed as "sounds like reels you liked").
- `/learn` (`feedback.py`) refits on the seed rows + every keep/reject (weight x5, features recomputed when a record
  predates v2) -> `<data>/models/brain/ranker.json` (takes precedence over the seed model); rebuilds caption memory.
- `clipfinder.py` windows (cues joined at pauses, 20-60 s, ending on >= 0.4 s pause) -> ranker -> non-max suppression ->
  `planner.py` jump cuts. `features_v1` is kept only as the CV baseline.
- `hooks.py` + `hooks.json` hook writer: every 2-6 word span of every caption is scored (victory / hope / strong words /
  direct address / theme / question; finished clause = line end or before a conjunction; closing line; e5 "sounds like
  kept reels"; penalties for dangling conjunctions / postpositions, fillers, admin notices, refs / digits, code-mixing,
  repeats, death words) -> title <= 6 words + "?" (question word) or "!" (lexical hit); sub = theme gist (+ " · "
  verse ref). Used by `/suggest` and by autobuild while `title_auto` / `sub_auto` (an edited title via PUT clears them).
  `POST /reels/{id}/describe {use_llm}` drafts title / sub / description / hashtags offline, or with a local Ollama
  model when one runs (`/health llm`; settings `ollama_url`, `ollama_model`); stored as `reel.describe`.
- `cutaways.py` cutaway planner (SKILL "Choosing cutaways"): cut points snapped into the reel's voice pauses; speaker
  kept for the 0-4 s hook, the closing line and up to 3 emphasis lines / rhetorical questions; 3-5 s spans (a 2.5-5.5 s
  pass only when still under 50 %); gaps >= 0.75 s or a shared cut; lazy greedy to 50-60 % coverage, ~8 per 50 s;
  alternating push-in / pull-out, |pan| <= 80. Image = hub-corrected e5 similarity of the span's captions (and the
  line before) to each library image's description + concept bonus + same-set bonus, no repeats. `concepts.json` maps
  ~900 spoken Odia / Hindi / English words (stems + ASR spellings; 415 or + 498 hi) to English library tags; an image
  showing a named concept gets +1.6 (+0.4 per extra concept), off-concept images -0.8 when the library can show the
  concept. On 30 hand-checked Odia / Hindi caption lines top-1 relevance went 15/30 -> 26/30 (accepted-but-wrong 10 -> 3);
  "ଚୂଡ଼ାନ୍ତ ପରାଜୟ" (final defeat) now gets angels battle / fallen angel instead of "youth lost".
  Below `settings.cutaway_match_threshold` (1.3, +0.4 for Odia) the cutaway gets `img: null` and a generation request
  `need: {prompt, slug, scene, text, tags, grade}` (prompt = "VERTICAL 9:16 portrait. Photorealistic cinematic still,
  India, <grade>, ... SCENE: ..."); renders keep the speaker there until `POST /reels/{id}/cutaways/{i}/image` attaches
  a picture (copied into the library with tags, desc = scene, set = the reel).
- `scripture.py` + `bible.py` verse cards. Every verse of the 3 translations is embedded once ("passage: ", float16) into
  `<data>/bible/<code>.emb.npy` + `.emb.refs.json` (31.1k verses, 24 MB each, ~7-8 min per translation on this 12-thread
  CPU; built at `/bible/download`, or lazily on first use). Caption windows (1-3 captions) are matched by meaning AND
  wording: candidates = top-30 by cosine + top-15 by shared rare words + ~210 commonly preached verses
  (`famous_verses.py`); a **quote** needs cos >= 0.80 with >= 40 % of the verse's content words (>= 4, rare-word IDF
  >= 16) and a 2-word run; a **paraphrase** (famous verses only) cos >= 0.78 + 4-word run or cos >= 0.855 + 3-word run.
  Meaning alone is not enough (Hindi windows all sit at cos 0.83-0.88). Explicit refs still work. Verified: John 15:5
  (Hindi paraphrase), Romans 10:10 (Odia quote), Philippians 4:13 (Hindi paraphrase), nothing on reel ~3, no false hits in
  2,981 caption windows of the test sermon. The card goes on a filled cutaway overlapping the quote (>= 1 s) or the next
  one within 8 s, `top_y` 520 moved up/down off any face YuNet finds in the illustration across its zoom.
  `GET /bible/similar` ranks by the same meaning + wording score (`quote` says whether the detector would accept it).
- `/suggest` also demotes (x0.6) windows that end on a fragment: a conjunction ("ତାହେଲେ", "तो", "but"...), a < 0.9 s
  last cue, or a reference announcement ("Matthew 4, verse 4 ...") - the house rule is to end on a finished line.
- `captions.py` dictionary + learned corrections + RNNT/CTC flags; `planner.py` jump cuts; lexicons / concepts / weights
  are plain JSON next to the code.

## Library (`viku/library.py`)
`<data>/library/library.sqlite` images with tags (folder + slug words + user tags), `set` (source folder) and optional
`desc`; the embedding text is `desc` or the slug words. `/library/search` = keyword score + e5 similarity.

## Thumbnails (`media/thumbs.py`, `cutout.py`, `translit.py`)
12 styles ported from make_thumbs.py (golden-hour, spotlight, split-panel, bold-outline, letterbox, poster, storybook,
gallery, victory-ribbon, prayer-halo, rays-slab, vine-poster); Noto fonts; Odia text for Odia reels, Hinglish
(transliterated title) for Hindi, English for English; verse pill from the reel's card. Background = the reel's first
filled cutaway. Pastor cut-out offline with U-2-Net human segmentation (`u2net_human_seg.onnx` from rembg's releases,
U-2-Net Apache-2.0 / rembg MIT, downloaded once into `<data>/models/cutout/` with a LICENSE.txt) + SKILL fixes
(largest component, jacket holes filled from the original frame, teal hair cast desaturated, podium cut).
Auto pose = speaker-only times scored by YuNet confidence x face size x frontal symmetry x eyes open x sharpness;
auto style = not the previous reel's. Renderer: headless Chrome/Edge (HTML) or, without a browser
(`renderer: "pillow"` / env `VIKU_THUMB_RENDERER=pillow`), Pillow composite + text through ffmpeg libass (this PC's
Pillow has no raqm/fribidi, so Pillow alone cannot shape Odia). Render writes the thumbnail next to the mp4.

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
GET  /bible/similar?text=...&lang=hi          GET /reels/{id}/needs     POST /reels/{id}/cutaways/{i}/image {"path","tags"}
POST /reels/{id}/thumbnail {"style","pose_t","title","sub","verse","renderer"}   GET /thumbnails/styles
GET  /models   POST /models/install {"ids":[...], "source_dir"}   POST /models/remove {"ids":[...]}
POST /reels/{id}/describe {"use_llm": false}
```
