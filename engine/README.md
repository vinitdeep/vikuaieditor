# Viku engine

Python 3.11 FastAPI engine for Viku (sermon video -> 1080x1920 reels, Odia / Hindi / English).
The HTTP contract is `../ARCHITECTURE.md`; this file covers setup and the engine-specific details.

## Setup + run
```
cd engine
uv sync                      # creates .venv (fastapi, uvicorn, numpy, opencv-python-headless, soundfile,
                             #   onnxruntime, tokenizers, pillow)
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
- `cutaways.py` cutaway planner (SKILL "Choosing cutaways"): cut points snapped into the reel's voice pauses; speaker
  kept for the 0-4 s hook, the closing line and up to 3 emphasis lines / rhetorical questions; 3-5 s spans (a 2.5-5.5 s
  pass only when still under 50 %); gaps >= 0.75 s or a shared cut; lazy greedy to 50-60 % coverage, ~8 per 50 s;
  alternating push-in / pull-out, |pan| <= 80. Image = hub-corrected e5 similarity of the span's captions (and the
  line before) to each library image's description + concept-word bonus (`concepts.json`) + same-set bonus, no repeats.
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
```
