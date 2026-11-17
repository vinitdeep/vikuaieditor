# Viku — SAVE (current state)

Contract: `ARCHITECTURE.md`. Update this file every session.

## Engine
**State (2026-11-17, session 4): gated download, licences, fill fix, enemy-aware titles, tests.** Commits 4618800
(HF token / mirror / error codes), 4f24268 (licences), 57ea713 (fill + titles), e61b9bb (tests + title fixes), + docs.
- `POST /models/install {ids, hf_token?, source_dir?, mirror_url?}`: token stored with DPAPI (`viku/vault.py`, ctypes;
  `settings.hf_token_dpapi`, never in GET /settings, never logged), sent as Bearer to huggingface.co only;
  `settings.models_mirror_url` replaces huggingface.co for every HF item. Job `error_code`: `hf_auth_required`
  (+ `error_info.accept_url` = the IndicConformer model page), `network`, `checksum`, `bad_request`. `GET /models`
  items: `needs_token`, `accept_url`, `token_set`. Verified on a fresh data dir: anonymous -> hf_auth_required, bogus
  token -> same (token_sent true), local wrong-file mirror -> checksum, dead mirror -> network, source_dir -> 2.56 GB
  installed + verified with no token.
- `GET /licences` (60 components) + generated `THIRD_PARTY_NOTICES.md` (`uv run python -m viku.licences`).
- Wide-shot fill now from the full frame (blur, cover, 0.55, +sat, luma floor) + source letterbox rows trimmed:
  re-rendered ~2 -> top band luma ~50 (was ~0 / black), 1319 frames, -13.9 LUFS / -1.9 dBTP.
- Titles never make the enemy the subject unless the line states his defeat. Before -> after: ~2 "ନିଜକୁ ବିଜୟୀ ମନେ
  କରିଥିଲା!" -> "ଚୂଡ଼ାନ୍ତ ପରାଜୟ ସମ୍ଭବ କଲା!"; ~3 "ଲୁସିଫର୍ ଆପଣଙ୍କ ଜୀବନରେ ଆଣିଥାଏ!" -> "ଶୟତାନ ପରାଜିତ!" (theme fallback);
  ~4 "ନିଜକୁ ବିଜୟୀ ମନେ କରିଥିଲା!" -> "ଆସିକରି ଯୀଶୁଙ୍କୁ କଣ କହୁଛି?"; ~1, ~5 unchanged.
- Robustness on new ranges, language auto: project 20261117-063755-fee2, 7850-8000 s: analyze 64 s (24 or + 15 hi
  cues), suggest 6 s, autobuild 28 s, render 78 s -> 1080x1920, 875 frames / 29.17 s, -14.2 LUFS / -1.9 dBTP, 56 %
  cutaways, no crash. `/automate` count 2 on 3600-3900 (project 20261117-064118-4f96) in 420 s: Hindi 32.2 s
  (-14.1 / -1.8) + Odia 28.3 s with a Genesis 1:1 card (-14.0 / -1.9), both 1080x1920, 51-52 % cutaways.
- `cd engine && uv run pytest` -> 41 passed in < 1 s (offline).

- Follow-up (no canned claims): theme titles removed; fallback = strongest own line / verse ref / best span +
  `needs_editor`; enemy subject carried over the 2 previous captions unless a new subject appears. Titles before ->
  after: 6d0d ~1, ~2, ~4, ~5 unchanged; ~3 "ଶୟତାନ ପରାଜିତ!" -> "ଆପ ସୋଚ ଲିଜେ କି ଭ?" (needs_editor: every
  usable line is Lucifer's, ASR garbage otherwise); automate 4f96 ~1 "शैतान हार चुका है!" -> "सो मु कौन कह?",
  ~2 "ନା ଅସୁନ୍ଦର କରିବେ" -> "ଈଶ୍ୱରଙ୍କର ଆକାଶମଣ୍ଡଳ ଓ ପୃଥିବୀ ସୃଷ୍ଟି"; fee2 ~1 "शैतान हार चुका है!" -> "बेटी जो बोलते हैं".
  `uv run pytest` 43 passed.
- ASR-quality gate for title lines (agreement >= 0.8, >= 3 words, >= 70 % known, script = language); nothing passes ->
  verse ref or "<project> · Reel N" with `reel.title_flag: "review"`. Before -> after: 6d0d ~1/~2/~4/~5 unchanged;
  ~3 "ଆପ ସୋଚ ଲିଜେ କି ଭ?" -> "Before the Foundation · Reel 3" (review); 4f96 ~1 "सो मु कौन कह?" -> "गिराया गया है";
  ~2 and fee2 ~1 unchanged. `/suggest` titles use the same gate: fallback = quoted verse (explicit ref, or by meaning
  when the Bible index exists) else "<project> · Clip N", `title_flag: "review"` on the suggestion. Tested on
  :8799 (temp data dir): 7850-8000 -> 3 hook titles + "robustness auto 7850 · Clip 4" (review). 46 tests pass.

**Gaps / next (session 4)**
- Hook titles are still heuristic: an implicit enemy subject further back than 2 captions, or after a line naming
  Jesus, is missed (~4 "what is he saying to Jesus?"); weak / mixed-language reels get weak own-word titles; titles produced by the
  running engine before these fixes (automate reels above) are not rewritten until the next autobuild.
- No church mirror exists yet - decide on hosting one (MIT permits) or ship the token flow; the app's setup screen
  must show `accept_url` on `hf_auth_required`.
- `THIRD_PARTY_NOTICES.md` must be regenerated when dependencies change; music seed / library seed content (the
  user's own generated assets) is not listed.

**State (2026-11-17, session 3): engine is self-contained - no dependence on personal folders.** Commits 14c921a
(manager, ASR/denoise in engine env, bootstrap, hook titles), 019a97f (Odia/Hindi concept matching), + docs.
- `GET /models`, `POST /models/install {ids, source_dir}`, `POST /models/remove`; `/health.setup_needed`. Tested here:
  ffmpeg + deep-filter + whisper-base.en downloaded (289 MB in 27 s), whisper-small cancelled at 185 MB and resumed
  (then removed), IndicConformer installed from the old folder via `source_dir` (2.56 GB, SHA-verified).
- On THIS PC settings now have `legacy_tools: false`, `allow_system_tools: false` (so only manager tools are used) and
  the credit line saved explicitly (defaults are empty now). Old venvs are no longer used.
- Re-render of reel `~2` with only manager tools (deep-filter CLI, managed ffmpeg, IndicConformer in engine env):
  1080x1920, 30 fps, 1319 frames, 43.97 s, -13.9 LUFS / -1.9 dBTP, 52.9 % cutaways, final-defeat line -> angels battle.
- Bootstrap verified into a fresh `%TEMP%\viku-bootstrap-test` (46 packages ~1 min, rerun 4 s, engine came up on
  :8799 with an empty data dir and installed deep-filter + fonts from there); test dir removed.
- Hook titles: reel ~5 "मैं क्या कर सकूँगा?" (Phil 4:13 gist), ~4 "ନିଜକୁ ବିଜୟୀ ମନେ କରିଥିଲା!"; manual titles kept.

**Gaps / next (session 3)**
- IndicConformer is gated on HF: a clean install needs an HF token, a mirror (`model_mirrors`) or `source_dir`. Decide on
  hosting a mirror (MIT permits) before shipping; the app needs a Models/first-run screen calling `/models/install`.
- `allow_system_tools` defaults to true (a good PATH ffmpeg is used if present); the bundled uv.exe must ship with the
  installer (Phase 4); bootstrap downloads ~350 MB of wheels (torch CPU is most of it).
- Hook titles are heuristic: lexically "victorious" lines can be spoken by the enemy (~2/~4 pick Satan's "considered
  himself victorious"); English gist is a theme table (`hooks.json`), not a translation. Ollama path untested (not
  installed here).
- Whisper small forced to English dropped a sentence on a TTS clip, so base.en is preferred.

**Earlier state (2026-11-17, session 2): Phases 1-3 engine work done and verified on the real sermon** (`Downloads\ମୂଳଦୁଆ ପୂର୍ବରୁ _ Before the Foundation ... .mp4`,
project `20261117-045435-6d0d` in `%APPDATA%\Viku\projects`, ranges 7150-7300 + 5160-5480 analysed). Commits 16c8c3b, 841e572, fd6d726.
- **Embeddings live** (`brain/embed.py`): multilingual-e5-small ONNX on CPU, model copied into `%APPDATA%\Viku\models\embed` (HF download
  fallback), sqlite cache by text hash; load 1.4 s.
- **Seed-trained ranker** (`brain/ranker.py`, `ranker_seed.json`, `python -m viku.brain.train_seed`): engineered features + e5 centroid
  contrast + 8-d PCA. Blocked 5-min-block CV **AUC 0.858** (cross-sermon 0.80 / 0.82) vs hand-weight baseline **0.661**. `/learn` = seed +
  feedback (x5). `/suggest` reasons = top contributions; windows ending on a fragment / reference announcement are demoted. Top pick for
  7150-7300 = the Hindi "मेरे परमेश्वर के जरिए से सब कुछ कर सकूँगा" window (the user's favourite hi-1 passage).
- **Cutaway planner** (`brain/cutaways.py`): 50-60 % coverage target, house rules checked by `cutaways.check()`; image by hub-corrected e5
  similarity + concept words + same set; no match -> `need` generation request (`GET /reels/{id}/needs`, `POST /reels/{id}/cutaways/{i}/image`).
- **Verses by meaning** (`bible.py` emb index ~7-8 min per translation, `brain/scripture.py`): John 15:5 (reel ~1), Romans 10:10 (~2),
  Philippians 4:13 (~5), none on ~3, no false hits over 2,981 caption windows. Cards on cutaways, `top_y` moved off YuNet faces.
- **Thumbnails** (`media/thumbs.py`, 12 styles; `cutout.py` U-2-Net human seg ONNX, Apache-2.0, in `%APPDATA%\Viku\models\cutout`):
  Chrome headless works here; Pillow+libass fallback tested (Pillow has no raqm on this PC). Auto pose + auto style.
- **Re-rendered** (all 1080x1920): ~1 Hindi 51.6 s: 7 cutaways planned = 54.8 %, 4 library + 1 attached via the endpoint = 37.6 % filled,
  2 open generation requests; -14.3 LUFS / -1.8 dBTP. ~2 Odia 44.0 s: 6 cutaways, 52.9 % filled, Romans 10:10 card; -13.9 / -1.8.
  `/automate` 7150-7300 -> reel ~5 (22.6 s, Phil 4:13 card, 43 % coverage, -14.5 / -1.9, 169 s end to end); reel ~4 = an earlier automate run
  before the dangling-end filter (ended on "ତାହେଲେ ମୁଁ"). Frames checked (captions single-line, cards clear of faces, dissolves).
  A true-peak safeguard re-encodes the audio if AAC overshoots -1.5 dBTP (not triggered in these renders).

**Run**: `cd engine && uv sync && uv run viku-engine` → http://127.0.0.1:8765 (`VIKU_PORT` overrides; data in `%APPDATA%\Viku`, `VIKU_DATA` overrides).
Details: `engine/README.md`.

**Known gaps / next**
- Odia caption->image matching is weaker than Hindi (e5's Odia; ASR code-mixing): some Odia picks are loose (e.g. "kids on phones" for
  "final defeat"); Odia threshold is +0.4 stricter. Library descriptions are slug words only - richer `desc` (e.g. the generation prompt's
  SCENE, which attach stores) improves matching. Short reels (< 25 s) land at ~43 % coverage because hook + closing line are protected.
- Generation requests embed the caption in its own language in the SCENE (no offline translation); the app's AI Studio window must fill them.
- Seed ranker: audio features exist only for the btf sermon (Salvation has no audio), so energy weights are ~0; the merged lexicon came from
  reading these same sermons, so the engineered-feature CV is somewhat optimistic. More `/learn` labels from other sermons will help.
- Paraphrase cards only for ~210 commonly preached verses; uncommon paraphrases (e.g. Matthew 4:9) need the editor. Spoken refs with number
  words ("ମାଥ ଚାର ଅଧ୍ୟ ଚାର") are not parsed.
- Titles are still caption fragments (`pick_title`); thumbnails transliterate them (Hinglish) - the editor should shorten titles.
- Thumbnail cut-out: wide gestures get clipped by the crop edge; background people in the illustration can sit behind his head.
- Bible index takes ~7-8 min per translation the first time (download job shows progress); the first /bible/similar on a fresh install waits for it.
- Full-sermon analyze (2h26m) still not timed; ASR CPU-only.

## App
**State (2026-11-17): desktop UI complete for Phases 1–2 screens; tested with mock data AND against the live engine.**
`app/` = Electron 45 + React 19 + TS strict + Vite 8 (electron-vite). Build, typecheck and lint clean. Details: `app/README.md`.
- Manual editor: Browser (Media / Transcript select→Make reel / Suggestions keep-reject→/feedback / Library / Bible),
  9:16 viewer with house-style overlay preview + Source 16:9 crop box, context inspector (Reel, Clip, Caption with
  /captions/fix flags, Verse, Cutaway incl. Gemini prompt, Audio, Thumbnail with real pose frame), magnetic timeline
  (7 tracks, blade/trim/select, reorder, ripple delete, snapping, skimming, undo/redo, drag from library), autosave (PUT).
- Automate wizard + stage progress + results; Activity drawer; Settings; Export dialog; Sign-in window (AI Studio
  WebContentsView with download + CDP capture and prompt queue, HeyGen device code, eBible download).
- Live-verified: project/reel load, crops px↔0..1, multi-range proxy playback, waveform, suggest job over SSE → 8 candidates,
  lossless project round-trip (no engine field dropped), engine auto-spawn on start + kill on quit.
- Run: `cd app && npm install && npm run dev`. Screenshots: `npm run build && npm run screenshots` (`-- --live` for the engine)
  → `app/screenshots/`. Mock media for screenshots: `npm run mock:media` (gitignored `app/public/mock/`).
- 2026-11-17 (later): cutaway clips show readable library names ("fallen angel") over their thumbnail; empty cutaways
  (`need`) are dashed gold "Needs image" clips with a one-click ✦ Generate → prompt queued in the Sign-in window → capture
  attached via `POST /reels/{id}/cutaways/{i}/image` (verified with a simulated capture in mock; route present on the engine).
  Automate: sticky pipeline card, finished run collapses to a summary, results = responsive 9:16 card grid (engine thumbnail,
  lang badge, score, inline MP4 preview, Open in Manual / Re-render / Export / Reveal). Library: `viku-thumb://` cached
  320 px JPEGs (~30 KB instead of 8 MB, `%APPDATA%\Viku\thumbs`) + virtualised grid (15 of 119 cells mounted).
  First-run onboarding (folders, engine/models from /health, sign-ins, church + credit line), Viku logo + `build/icon.ico`,
  `?` shortcuts sheet (every key verified by Playwright, incl. new Ctrl+S, I/O, +/−), engine-down banner with Start engine,
  skeletons / empty states / error toasts. Screenshots: `app/screenshots/00a–00f` (onboarding), `04b`, `13`, `13b`, `17`,
  `18`, `19` + `live-*`.
- Next: installer (Phase 4, `build/icon.ico` ready), run one real signed-in AI Studio capture → attach on the live engine,
  persist queued generation requests across reloads, thumbnail designer style picker once `/thumbnails/styles` settles.
