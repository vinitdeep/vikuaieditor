# Viku — Sermon Reel Studio

Desktop app (Windows first) that turns a long sermon video into vertical reels (1080×1920) for church editors.
Languages: **Odia, Hindi, English**. Works **offline**; online features sit behind a Sign-in window.
Two modes: **Automate** (one click: sermon → finished reels + thumbnails) and **Manual** (Final-Cut-style editor).

Reference pipeline (proven, reuse its logic): `Documents\Claude\Projects\AI Video Editing\` and the skill
`~/.claude/skills/illustrating-sermon-reels` (SKILL.md + `scripts/` + `scripts/pipeline/`). Read SKILL.md first.

## Layout
```
Sermon Reel Studio/
  ARCHITECTURE.md   this file (the contract)
  SAVE.md           current state / how to run / what's next (update every session)
  app/              Electron + React + TypeScript + Vite UI ("Viku")
  engine/           Python 3.11 FastAPI engine (uv project), all media/AI work
  models/           downloaded models (gitignored) - see engine/viku/models.py
  data/             Bibles, illustration library, music library, sfx, fonts (gitignored where large)
```
Dev run: `engine`: `uv run viku-engine` (serves http://127.0.0.1:8765). `app`: `npm run dev` (Electron starts the engine itself if not running).

## House rules baked into the engine (from the user)
- Framing = **scale + crop only**, one fixed crop per camera shot (no auto-framing / tracking motion). Speaker walking across a wide shot → wider fixed crop scaled to width over a blurred fill. Jump-cut segments alternate a static punch-in z = 1.0 / 1.12.
- Speech enhancement (DeepFilterNet3) on every reel.
- Cutaway transitions: cross-zoom dissolve 0.7 s (outgoing pushes in + blurs, incoming settles). No slide/push.
- SFX: low impact under the title, soft air swell into cuts. **Never bell / chime / shimmer sounds.**
- Every reel ends on an encouraging line. Reels ≤ 60 s; shorter is fine.
- Captions: lower third (400 px from bottom), white bold with black outline; title hook 0.2–4.2 s top; verse cards upper half on cutaways only; credit line at bottom.
- Loudness −14 LUFS, true peak −1.5 dBTP. 1080×1920, 30 fps, H.264 CRF 18, AAC 192k.
- Fonts must be redistributable: **Noto Sans Oriya / Noto Sans Devanagari / Noto Sans** (OFL) shipped in `data/fonts` — never Nirmala UI.

## Engine HTTP API (JSON, base http://127.0.0.1:8765, all paths absolute Windows paths)
Long work runs as **jobs**; progress over `GET /events` (Server-Sent Events: `{"job":id,"kind","progress":0..1,"message","state":"running|done|error","result"}`).

| Method | Path | Purpose |
|---|---|---|
| GET | /health | `{ok, version, gpu, setup_needed, setup_missing[], offline_ready:{asr,denoise,embed,bible,library,ffmpeg}, models:{id:{installed,source,required}}, llm:{ollama,models,model}, details}` |
| GET | /models | tools + models `[{id, name, purpose, size_mb, licence, licence_url, required, installed, source, path, gated, needs_token, accept_url, token_set, partial_mb}]` |
| POST | /models/install | job: `{ids?, source_dir?, hf_token?, mirror_url?}` (default = missing required) - pinned URLs, resumable Range downloads, SHA-256 verify, atomic move; failure `error_code`: `hf_auth_required` (+ `error_info.accept_url`), `network`, `checksum`, `bad_request` |
| GET | /licences | `{generated, count, components:[{id, kind, name, version, licence, url, download?, source?, delivered, attribution?, notice?}]}` - same data as `THIRD_PARTY_NOTICES.md` |
| POST | /models/remove | `{ids}` → deletes the managed copies |
| POST | /reels/{id}/describe | `{use_llm}` → `{title, sub, description, hashtags, source, llm_error?}` (offline draft; local Ollama when running) |
| GET/POST | /settings | app settings (data dirs, credit line, default language, church name, export presets); secrets never returned (`hf_token_set: bool`); POST `hf_token` stores it DPAPI-encrypted, `null` clears |
| POST | /projects | create `{name, video_path, language: "or"\|"hi"\|"en"\|"auto"}` → project |
| GET | /projects, /projects/{id} | list / full project JSON |
| PUT | /projects/{id} | save edited project (whole JSON; engine validates) |
| POST | /projects/{id}/analyze | job: proxy (540p) + 16 kHz wav + waveform peaks + pauses + shot cuts + transcription (per-language) |
| GET | /projects/{id}/waveform?start&end&px | peaks for the timeline |
| GET | /media?path= | stream a local file (video proxy / images / audio) with Range support |
| POST | /projects/{id}/suggest | job: clip finder → ranked candidate reels `[{id,score,title,segments:[[s,e]],reasons[],language}]` |
| POST | /projects/{id}/reels | create reel from `{segments:[[s,e],...], title, sub}` (jump cut if >1 segment) |
| POST | /reels/{id}/autobuild | job: captions (re-ASR on joined audio), verse detection, cutaway plan + library picks, music pick, sfx |
| POST | /reels/{id}/framing | job: track the speaker for auto framing only → `crops` + `follow`, `framing:"follow"` (captions / cutaways / music untouched) |
| POST | /reels/{id}/render | job: final mp4 (and thumbnail) → `exports/` |
| POST | /reels/{id}/thumbnail | job: `{style, pose_t, title, sub, verse, renderer}` (all optional; auto pose + auto style) → thumbnail jpg |
| POST | /automate | job: `{video_path, language, count}` → analyze → suggest → build → render N reels |
| POST | /captions/fix | `{text, lang}` → `{text, flags:[{start,end,reason,suggest}]}` (dictionary + learned corrections) |
| POST | /feedback | `{reel_id, kind:"keep"\|"reject"\|"caption_edit", before, after}` → stored for learning |
| POST | /learn | job: retrain clip-finder ranker + correction memory from feedback |
| GET | /bible/search?q=&lang= ; /bible/verse?ref=&lang= | offline verse lookup (IRV ory, IRV hin2017, WEB eng) |
| GET | /bible/similar?text=&lang=&k= | verses closest in meaning (e5 embedding of every verse) → `[{ref, display_ref, text, score}]` |
| GET | /reels/{id}/needs | unfilled cutaway generation requests `[{index, t0, t1, prompt, slug, scene, text, tags, suggested_name}]` |
| POST | /reels/{id}/cutaways/{i}/image | `{path, tags?}` attach a captured image to cutaway i (copied into the library) → cutaway |
| GET | /thumbnails/styles | `[{id, label}]` thumbnail designer styles |
| POST | /bible/download | job: fetch eBible USFM zips once (online) |
| GET | /library/search?q= | illustration library search (tags + filename + embedding) |
| POST | /library/import | add images (folder/files) with tags |
| GET | /music | local music library list `[{name, path, duration, tags, source: local\|viku\|heygen, mood, seed}]`; POST /music/heygen {intent} → job (online, via `npx hyperframes media-use`) |
| POST | /music/generate | job: `{mood, seed?, duration?=90, preview?}` → offline procedural bed (`viku/music_gen.py`), FLAC 48 kHz stereo, −14 LUFS, seamless loop, tagged "viku generated" + mood; `preview` renders into `<data>/music_previews` |
| GET | /music/moods | `[{id, label, desc}]`: hopeful, victorious, reflective, prayerful, uplifting |
| POST / DELETE | /music/keep {path}, /music/{name} | move a preview into the library / delete a library track |
| GET | /starter | `{illustrations:{available, count, imported, size_mb, licence, path}, music:{generated, tracks, defaults_job}}` |
| GET | /auth/status | `{gemini_web:bool, heygen:bool, ebible:"downloaded"\|"missing"}` |
| POST | /auth/heygen/login | job: device-code login (returns code + URL to show) |

## Project JSON (single source of truth, saved in `<projects dir>/<id>/project.json`)
```json
{"id","name","video_path","duration","fps","language",
 "proxy","wav16","shots":[t,...],"pauses":[[s,e],...],
 "transcript":[{"start","end","text","lang","conf"}],
 "reels":[{"id","title","sub","language",
   "segments":[[s,e],...],                       // absolute source seconds, in play order
   "framing":"follow"|"fixed",                   // auto framing (crop pans with the speaker) | still crop per shot; missing = fixed
   "crops":[{"t0","t1","cx","cw","z","ax"}],     // reel seconds, per shot; cx/cw/ax in px of the 1280-wide framing frame
                                                 // follow: frame x = path(source t) + (cx - ax)  (cx - ax = editor nudge)
   "follow":[{"s","e","x":[...]}],               // follow paths by SOURCE seconds, x at 10 samples/s (1280-px), one per shot
   "captions":[{"t0","t1","text","flags":[]}],   // reel seconds
   "verses":[{"t0","t1","text","ref","top_y"}],
   "cutaways":[{"t0","t1","img","z0","z1","pan":[x,y]}],
   "music":{"path","gain_db":-19,"start":0},
   "sfx":[{"name","t","gain_db"}],
   "style":{"caption_font","caption_size","title_style"},
   "thumbnail":{"style","pose_t","title","sub","verse"},
   "status":"draft|built|rendered","exports":[]}]}
```

### Engine implementation notes (Phase 1, additive to the contract above)
- **Data dir**: everything the engine writes lives in `%APPDATA%\Viku` (env `VIKU_DATA` overrides), not in the repo's
  `data/` / `models/`: `settings.json`, `projects/<id>/`, `fonts/`, `bible/<code>.sqlite`, `library/`, `music/`, `sfx/`,
  `models/brain/{ranker,corrections}.json`, `feedback.jsonl`. `settings.projects_dir` / `exports_dir` can move projects/exports.
- **Reel ids** are `<project id>~<n>`; exports go to `<project>/exports/<n>-<slug>.mp4` (+ `.jpg`).
- **Extra endpoints**: `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel`, `GET /reels/{id}`, `POST /music/seed`.
- **Request options**: analyze `{range:[s,e], steps:{proxy,shots,asr}}`; suggest `{count, range}`; autobuild `{steps:{captions,cutaways,music}}`;
  automate `{video_path | project_id, language, count, range, render, max_seconds, pick, framing:"follow"|"fixed"}` (automate/build takes `framing` too); library import `{paths, tags, seed}`; bible download `{langs}`.
- **Project JSON additions**: `width, height, proxy_offset` (proxy of a range starts at that source second), `proxies[]`, `peaks` (npy path),
  `analyzed[[s,e]]`, `suggestions[]`; transcript items carry `alt` (CTC text); reels carry `duration, jumps, src, voice, enhance`,
  captions `{flags, alt, conf}`, cutaways `{lib_id, why}`, verses `{attribution}`, exports `{path, thumbnail, width, height, duration, lufs, true_peak}`.
- **Phase 2/3 additions (2026-11-17)**: cutaways carry `text` (captions they cover), `why` (match score / z / concept /
  desc) and, when the library has no good match, `img: null` + `need: {prompt, slug, scene, text, tags, grade}` (becomes
  `need_done` once an image is attached); verses carry `match: {kind: "explicit"|"semantic", score, caption}` and
  `top_y` (default 520, moved off faces); `thumbnail` stores `{style, pose_t, path, renderer, style_user, pose_user}`;
  exports add `cutaway_coverage` (filled share), `cutaway_needs`, `tp_fix_db` (when AAC overshoot forced an audio re-encode).
  Suggestions carry `reason_details [{feature, why, contribution}]` and `model: "seed"|"learned"`. Library import takes
  `desc` and `set`. Settings: `cutaway_match_threshold` (1.3).

### Session 4 additions (2026-11-17): gated download, licences, tests
- Jobs (GET /jobs/{id} and SSE) carry `error_code` + `error_info` (stable machine reasons; `cancelled` for a cancel); a
  synchronous JobError answers `{error, code, ...info}` with HTTP 400.
- Settings: `hf_token_dpapi` (Windows DPAPI blob, written only by the engine), `models_mirror_url` (base URL replacing
  `https://huggingface.co/` for every HF item: `<mirror>/<repo>/resolve/<rev>/<path>`). `hf_token` is write-only.
- `THIRD_PARTY_NOTICES.md` (repo root) is generated by `uv run python -m viku.licences`; the app's licences screen reads
  `GET /licences`.
- Wide-shot fill is built from the full source frame (never near-black); hook titles never make the enemy the subject
  unless the line states his defeat (theme title fallback when no caption span is a good hook).
- `engine/tests/` (pytest, offline): `cd engine && uv run pytest`.

### Session 3 additions (2026-11-17): self-contained install
- **Model & tool manager** (`engine/viku/models.py`, manifests in `engine/viku/manifests/`): ffmpeg 9.0.2 (gyan.dev
  essentials, GPL-3.0), deep-filter CLI 0.5.6 (DeepFilterNet3, MIT/Apache), IndicConformer 600M (MIT, gated HF repo:
  settings `hf_token` / `model_mirrors` / `source_dir`), e5-small, Noto fonts (required); Whisper base.en / small,
  U-2-Net (optional); YuNet bundled. Installs into `<data>/tools` and `<data>/models`; the engine finds ffmpeg only
  through the manager (settings path -> managed -> suitable PATH build if `allow_system_tools`). `legacy_tools`
  (default off) re-enables the dev machine's old venvs.
- **ASR in the engine env**: `uv` dependency group `asr` (torch CPU via the PyTorch CPU index, faster-whisper);
  IndicConformer inference code vendored (`runners/indic_model.py`, MIT); English = faster-whisper (ffmpeg-whisper
  fallback). Speech enhancement = deep-filter CLI (venv, then afftdn fallbacks).
- **Bootstrap** `engine/scripts/bootstrap.ps1 -Uv <uv.exe> -InstallDir <dir>`: uv-managed Python 3.11 + `uv sync --frozen
  --no-dev --group asr` inside the install dir, then starts the engine; `PROGRESS <0-100> <msg>` / `READY <url>` /
  `ERROR <msg>` lines for the app.
- **Titles**: hook writer (`brain/hooks.py`): title <= 6 words + !/?, sub = theme gist / verse ref; reels carry
  `title_auto`, `sub_auto` (PUT with a changed title clears them) and `describe` (last draft). Settings added:
  `allow_system_tools`, `legacy_tools`, `hf_token`, `model_mirrors`, `ollama_url`, `ollama_model`,
  `paths.{deep_filter, faster_whisper_model}`; `credit_line` / `church_name` default to empty.

### Session 5 additions (2026-11-17): starter content, offline music, v0.1.0
- **Starter illustrations** `data/starter/illustrations/` (119 of the project's own AI images, 1080×1920 JPEG q85, no
  metadata, 34.8 MB, `index.json` = `{version, licence, count, bytes, items:[{id, file, title, tags, desc, set, width,
  height, bytes}]}`, built by `engine/scripts/build_starter.py`). The installer ships it as extraResources
  (`resources/starter/illustrations`) and the app passes `VIKU_STARTER`; the engine (`config.starter_dir()`: env, else the
  repo's `data/starter`) imports it into an EMPTY library on first run. `/library/import {seed:true}` = the starter pack;
  the user-folder seeds (library + HeyGen music) run only with `VIKU_DEV=1`.
- **Music generator** `viku/music_gen.py`: numpy-only procedural beds - band-limited wavetable voices (dark/bright tables
  cross-faded by a slow filter curve), pads / strings / felt piano / pluck pulse / low boom, diatonic progressions with
  nearest-voicing voice leading, circular timeline (notes, tails and an FFT reverb wrap → seamless loop), 35 Hz HP + 5 kHz
  LP, BS.1770 −14 LUFS, true peak ≤ −1.5 dBTP; every partial ≤ 2 kHz (no bells/chimes/shimmer, clear of the speech presence
  band); `bell_check()` measures tonal > 2 kHz partials with fast attack. Deterministic by `(mood, seed, duration)`.
  Fresh install with no music → job `music_defaults` makes the 5 moods (seed 1, ~7 s each). Autobuild: `hooks` theme →
  mood (`music_gen.THEME_MOOD`) → `music.pick(mood)`; reels store `mood` + `theme`, `music.mood`.
- `/automate` result per reel: `title` / `sub` / `title_flag` / `mood` = the STORED reel after autobuild (the hook writer
  + ASR gate), `suggested_title` = the clip finder's.
- `/licences` kind `content`: "Viku starter illustrations" (AI-generated (Google Gemini / AI Studio) by the Viku project,
  free to use in Viku videos) + "Viku generated music" (royalty-free).

## Offline AI (clip finder + caption fixer) — "Viku Brain"
- Signals per transcript window (sentence-ish chunks joined at pauses, 20–60 s): voice energy & variance, speech rate, pitch variance (excitement), direct address ("ଆପଣ/ତୁମେ", "आप/तुम", "you"), encouragement/victory lexicon (or/hi/en, `engine/viku/brain/lexicon.json`), scripture mention regex (book names in 3 languages + "ଅଧ୍ୟାୟ/अध्याय/chapter"), ends-on-hope check (last 2 sentences), Hindi/Odia language id.
- Semantic score: multilingual sentence embedding (`intfloat/multilingual-e5-small`, ONNX/CPU) — cosine to the kept-minus-rejected centroids + an 8-d PCA projection.
- Ranker: logistic regression over the features, trained on the seed (the two Pastor Jacob sermons, 662 labelled windows) and shipped as `engine/viku/brain/ranker_seed.json` (blocked-CV AUC 0.858 vs 0.661 for the old hand weights); `/learn` refits on seed + editor keep/reject (x5) into `<data>/models/brain/ranker.json`.
- Jump-cut planner: inside a chosen window drop fillers/repeats/crowd call-and-response (short low-content segments, repeated n-grams), cut only in pauses ≥ 0.25 s.
- Caption fixer: RNNT vs CTC disagreement flags, Bible/church vocabulary per language, learned correction memory (`before→after` pairs from edits, applied when seen again).
- Optional: local LLM via Ollama (if installed) for titles/descriptions; never required.

## Online (Sign-in window, all optional)
- **Gemini / AI Studio (free, web)**: Electron `BrowserView` with a persistent partition; user signs in to Google themselves. Robust capture that does not depend on Google's page layout: (1) `session.on('will-download')` saves every downloaded image into the reel's folder; (2) a CDP `Network` listener on that view captures any image response ≥ 1024 px from `*.googleusercontent.com` / blob data as a fallback; (3) prompt injection uses a generic heuristic (largest visible textarea/contenteditable, `insertText`, then Ctrl+Enter) and, if that fails, the prompt is copied to the clipboard with a toast "paste & send". Each captured image is matched to the pending prompt in order and filed under its planned name.
- **HeyGen music**: device-code login through `npx hyperframes auth login --device`; music via `npx hyperframes media-use resolve --type bgm --intent ...`.
- **eBible**: no login; one-time download of USFM zips (`ory`, `hin2017`, `eng-web`), parsed into `data/bible/<code>.sqlite`.

## Phases
1. Engine core + UI shell: projects, analyze (proxy/wav/peaks/pauses/shots/ASR), transcript panel, select→reel, timeline display, render of a reel (jump cuts, fixed crops, enhancement, captions, verse cards, cutaways, music/sfx, loudness).
2. Library (illustrations/music/sfx), Bible offline, Sign-in window (AI Studio capture, HeyGen, eBible), thumbnail designer.
3. Viku Brain: features, embeddings, ranker trained on seed data, caption fixer, feedback/learn loop; Automate mode end-to-end.
4. Packaging: embedded Python runtime + models downloader on first run, electron-builder NSIS installer, licences screen.
