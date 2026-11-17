# Viku — SAVE (current state)

Contract: `ARCHITECTURE.md`. Update this file every session.

## Engine
**State (2026-11-17, session 2): Phases 1-3 engine work done and verified on the real sermon** (`Downloads\ମୂଳଦୁଆ ପୂର୍ବରୁ _ Before the Foundation ... .mp4`,
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
