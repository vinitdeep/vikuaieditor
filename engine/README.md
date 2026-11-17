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
models come from the model manager (below). First start imports the bundled starter illustrations into an empty
library (`VIKU_STARTER`, else the repo's `data/starter`), generates the 5 default music beds into an empty music
library (job `music_defaults`, ~40 s), synthesizes the SFX and fetches the Noto fonts. `VIKU_DEV=1` (dev machine
only) also seeds from the original reel folders / the developer's licensed HeyGen beds - never on other PCs.

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
POST /library/import {"seed": true}       # (offline) re-import the bundled starter pack (119 illustrations)
POST /music/generate {"mood": "victorious", "seed": 7}   # (offline) a new royalty-free bed
POST /music/heygen {"intent": "..."}      # optional, needs `npx hyperframes auth login --device`
```

## Model & tool manager (`viku/models.py`, `viku/manifests/`)
`GET /models` -> `[{id, name, purpose, size_mb, licence, licence_url, required, installed, source, path, gated,
needs_token, accept_url, token_set, partial_mb}]`; `POST /models/install {ids?, source_dir?, hf_token?, mirror_url?}`
-> job (byte progress in `message` / `result`); `POST /models/remove {ids}`. A failed install job carries
`error_code` + `error_info` (also on the SSE event):

| error_code | when | error_info |
|---|---|---|
| `hf_auth_required` | huggingface.co answered 401 / 403 (no token, bad token, or terms not accepted) | `accept_url` (https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual - open it, accept the terms), `http_status`, `token_sent` |
| `network` | connection refused / DNS / timeout after 4 retries, or a 4xx/5xx from a mirror / GitHub | `host`, `http_status?` |
| `checksum` | the bytes do not match the pinned SHA-256 (corrupt download or a mirror serving another file) | `file`, `expected_sha256` |
| `bad_request` | `mirror_url` not http(s), `source_dir` not a folder | |

**HF token**: `hf_token` (in `/models/install` or `POST /settings`) is stored with Windows DPAPI (`viku/vault.py`,
ctypes `CryptProtectData`, current-user scope) as `settings.hf_token_dpapi` - never plaintext on disk (an old plaintext
`hf_token` is migrated on load), never returned by `GET /settings` (which shows `hf_token_set: bool`), never logged or
put in job meta. `{"hf_token": null}` clears it; `""` leaves it unchanged. It is sent as `Authorization: Bearer` only to
`huggingface.co` (dropped on the CDN redirect). Env `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` still work.
**Mirror**: `settings.models_mirror_url` (or `mirror_url` per install, saved after a successful install) replaces
`https://huggingface.co/` for every HF item: `<mirror>/<repo>/resolve/<revision>/<path>` - a church can host a copy
of the pinned files (static file server, same layout). `model_mirrors {id: base}` still overrides one item.
Verified (fresh data dir, port 8765): anonymous -> `hf_auth_required` + accept_url; a bogus token -> same with
`token_sent: true`; a local mirror serving a wrong file -> `checksum`; a dead mirror -> `network`; `source_dir` ->
IndicConformer installed (2.56 GB, SHA-verified) without any token. Every file is pinned (release tag / HF revision + size + SHA-256). Downloads go to
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
token (`hf_token`, stored DPAPI-encrypted - see above); or a mirror (`models_mirror_url`; MIT allows
redistribution); or installs from a folder. HF masks its LFS hashes for anonymous callers,
so the manifest SHA-256s come from the working copy that produced the verified transcripts (all sizes and every
non-LFS git blob hash match HF). Re-pin any model with `scripts/make_manifest.py <repo> <revision> <out.json>`.

Tool resolution: `ffmpeg()` / `ffprobe()` = settings `paths.ffmpeg` -> managed copy -> PATH ffmpeg when
`allow_system_tools` and it is >= 6 with libass + libx264. `settings.legacy_tools` (default false) re-enables the
original dev machine's venvs (`config.legacy_paths()`) as a last resort. `/health` -> `setup_needed`,
`setup_missing` (required ids, plus `asr-runtime` when torch is missing), `models {id: {installed, source, required}}`,
`llm` (Ollama), `details.ffmpeg / ffmpeg_source / denoise_engine / asr_en_engine / asr_runtime`.

## Licences (`viku/licences.py`)
`GET /licences` -> `{generated, count, components:[{id, kind: runtime|tool|model|font|data|python, name, version,
licence, url, download?, source?, delivered, attribution?, notice?}]}`: CPython / uv / faster-whisper+CTranslate2,
ffmpeg (GPL-3.0 build + source pointers), deep-filter, IndicConformer (MIT), e5, Whisper, U-2-Net, YuNet, Noto (OFL),
the three Bible texts with the exact attribution strings printed on verse cards, and every Python package of the
shipped env (closure of the main + `asr` dependencies in uv.lock - dev-only packages excluded - licence from the
installed metadata, hand overrides in `LICENCE_OVERRIDES`). The repo's `THIRD_PARTY_NOTICES.md` is generated from the
same data: `uv run python -m viku.licences` (rerun after changing dependencies or manifests).

## Tests
`uv run pytest` (offline, ~seconds; a temp `VIKU_DATA`, no models, no network, e5 stubbed off): USFM parse + verse
lookup (tiny in-memory eBible zip), jump-cut segment remap (`reel.segment_offsets / src_to_reel / reel_to_src`),
caption fixer (dictionary fix, RNNT/CTC flag, learned edit), ranker scoring with the seed model, cutaway planner house
rules (`cutaways.check`: hook, closing line, gaps >= 0.75 s, lengths, pans, alternating zoom), hook titles (enemy
rule, theme fallback), the true-peak loudness guard (`reel.tp_guard_gain`), HF token storage / mirror URLs / error
codes, the licence inventory, the starter pack (index complete, <= 60 MB, import into an empty library, dev-only
seeds), the music generator (5 moods, -14 LUFS +- 1, no clipping, deterministic, seamless loop, no bell-like energy, a
synthetic bell IS detected, generate job tags + mood pick) and the /automate stored-title result.

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
Long work returns `{"job", "kind", "state"}`. Progress: `GET /events` (SSE, `data: {"job","kind","progress","message","state","result","error","error_code","error_info"}`;
`error_code` is a stable reason for the app, e.g. `hf_auth_required`, `network`, `checksum`, `cancelled`),
or poll `GET /jobs/{id}`; cancel with `POST /jobs/{id}/cancel` (kills its ffmpeg / runner subprocesses). Two jobs run at a time.

## Pipeline (ports of the illustrating-sermon-reels skill scripts)
- `media/analyze.py` - whole-file 16 kHz wav, peaks (100/s), pauses (>= 0.25 s); per `range`: 540p proxy (keyframe every 1 s,
  `proxy_offset` = range start), shot cuts (frame difference), transcription (energy segmenter, max 6 s cues).
- `media/reel.py` - jump-cut join (frame-snapped, 12 ms fades) -> `framing.py` fixed crop per shot/segment (YuNet only chooses;
  still -> 405 px 9:16, walking -> wider crop over a blurred fill built from the FULL source frame: blur first,
  cover-scaled 9:16 around the speaker, x0.55 brightness, +15 % saturation, rows darker than the frame's mean colour
  lifted toward it so the bands are never near-black, and the source's own black letterbox rows trimmed off the
  foreground; segments alternate z 1.0/1.12) -> DeepFilterNet -> caption re-ASR
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
  repeats, death words, people "losing") -> title <= 6 words + "?" (question word) or "!" (lexical hit); sub = theme
  gist (+ " · " verse ref). **The enemy is never the hero**: a span naming Satan / Lucifer / devil / "spirit of
  depression" or an enemy action ("हराना चाहता", "ହରାଇବାକୁ ଚାହିଁ" = wants to defeat) gets -3; a span whose line, or
  one of the 2 captions before it with no explicit new subject in between (`subjects`: nominative pronouns / people
  words / divine names as whole tokens), names him and that has no subject of its own -2.5 - unless the line states
  his defeat (`enemy_defeat`:
  ପରାଜୟ / ପରାଜିତ / ହାରି..., हार / पराजित / हरा दिया..., defeated). A clause ends only before a conjunction
  (`conjunctions`), not a postposition. **Titles never claim what the reel doesn't say**: best span < 3.5 -> the
  reel's strongest short line in its own words (`fallback_line`: line-final 3-6 word windows, conf >= 0.75, no enemy
  lines, needs a content word), else the quoted verse's native reference, else "<project> · Reel N" - those two
  with `title_flag: "review"` (stored on the reel by autobuild for the app to highlight). **ASR-quality gate**: a
  caption line can give a title only with >= 3 words, its script = the reel language, word-level RNNT/CTC agreement
  >= 0.8 where a CTC text exists (soft match: a substituted word counts its character similarity when >= 0.6;
  nukta / chandrabindu variants equal) and >= 70 % known words (lexicons + concepts + the offline Bible's words +
  words said >= 3x in the sermon transcript; skipped when no Bible / transcript exists). No canned
  theme titles; the theme sub "The enemy is defeated" only when the reel names him AND states a defeat (not people
  "losing"). Reels ~1..~5 before -> after (session 4, first pass; second pass in SAVE.md): ~2 "ନିଜକୁ ବିଜୟୀ ମନେ କରିଥିଲା!" (Satan "considered himself
  victorious") -> "ଚୂଡ଼ାନ୍ତ ପରାଜୟ ସମ୍ଭବ କଲା!" (made the final defeat possible); ~3 "ଲୁସିଫର୍ ଆପଣଙ୍କ ଜୀବନରେ ଆଣିଥାଏ!"
  (what Lucifer brings into your life) -> "ଶୟତାନ ପରାଜିତ!" (fallback); ~4 "ନିଜକୁ ବିଜୟୀ ମନେ କରିଥିଲା!" -> "ଆସିକରି
  ଯୀଶୁଙ୍କୁ କଣ କହୁଛି?"; ~1 / ~5 unchanged. Used by `/suggest` and by autobuild while `title_auto` / `sub_auto` (an edited title via PUT clears them).
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

## Starter illustrations (`data/starter`, `scripts/build_starter.py`)
`uv run python scripts/build_starter.py` (dev machine) converts the project's own AI illustrations (Before the
Foundation + Salvation reel folders) to 1080x1920 (centre-crop to exactly 9:16) baseline JPEG q85 without metadata and
writes `index.json` with `library.tags_for` / `library.describe` tags + desc, `set` = source folder, id = sha1 of the
JPEG (the library's id scheme). 119 images, 34.8 MB. `library.import_starter()` copies them in (idempotent),
`library.starter_status()` -> `GET /starter`. Licence: AI-generated (Google Gemini / AI Studio) by the Viku project,
free to use in Viku videos.

## Music generator (`viku/music_gen.py`, `viku/music.py`)
`music_gen.generate(mood, seed=1, duration=90)` -> float32 (n, 2) at 48 kHz + info `{lufs, true_peak, key, bpm, bars}`.
numpy only. Voices are band-limited wavetables (harmonic k of the timbre x 3rd-order low-pass weight at k*f0, capped at
2 kHz), two per note (dark / bright) cross-faded by a slow brightness curve (a filter sweep without per-sample IIR);
pads 2-3 detuned voices spread in stereo, strings with delayed vibrato, a felt piano (fast brightness decay, never above
C5), a soft 8th-note pluck pulse, a low pitch-dropping boom. Harmony: I-V-vi-IV / vi-IV-I-V / I-IV-vi-V / I-IV-I-V /
I-vi-IV-I with add9 colour and nearest-voicing voice leading; bar length rounded to a 2^a3^b5^c sample count so the
whole-loop FFTs are fast. Everything lives on a circular timeline (notes, release tails, FFT reverb) so the file loops
without a seam. Master: 35 Hz HP + 5 kHz LP, BS.1770-4 gated loudness -> -14 LUFS, 4x-oversampled true peak <= -1.5 dBTP
(gain only), 16-bit FLAC with TPDF dither.

| mood | sound | progression / tempo |
|---|---|---|
| hopeful | felt-piano broken chords over a saw pad, bass enters later | I-V-vi-IV or I-IV-vi-V, ~75 bpm |
| victorious | 3-voice string-pad swells + low warm pad, bass, boom on 2-bar downbeats | vi-IV-I-V or I-V-vi-IV, ~85 bpm, 2 bars/chord |
| reflective | sine pads, warm low pad, root+fifth drone, long reverb | vi-IV-I-V or I-IV-I-V, ~64 bpm |
| prayerful | warm 3-voice pad, drone, soft bass | I-IV-I-V or I-vi-IV-I, ~64 bpm |
| uplifting | 8th-note pluck pulse, saw pad, bass, light boom | I-V-vi-IV or I-IV-vi-V, 96 bpm |

Measured (90 s, seed 1): -14.0 LUFS (victorious -14.2, true-peak-limited), true peak -1.5 to -3.4 dBTP (ffmpeg ebur128
agrees), energy above 2 kHz -52 to -78 dB, 0 fast-attack tonal > 2 kHz events (a synthetic bell overlay scores one per
strike), loop seam < 0.6 x a normal sample step; ~5-9 s each on this PC. `music.generate` (job) writes
`<data>/music/viku_<mood>_s<seed>.flac` + music.json `{tags: ["viku generated", mood], source: "viku", mood, seed,
lufs, true_peak}`; `preview` -> `<data>/music_previews` (one at a time) and `POST /music/keep`. `music.pick(mood, key)`:
that mood's generated beds, then tracks tagged with it, else any (deterministic by reel id). Samples of each mood:
`data/starter/music_samples/` (gitignored; regenerate with `music_gen.generate` + `music_gen.write`).

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
GET  /models   POST /models/install {"ids":[...], "source_dir", "hf_token", "mirror_url"}   POST /models/remove {"ids":[...]}
GET  /licences
POST /reels/{id}/describe {"use_llm": false}
```
