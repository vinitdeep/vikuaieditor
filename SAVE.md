# Viku — SAVE (current state)

Contract: `ARCHITECTURE.md`. Update this file every session.

## Engine
**State (2026-11-17): Phase 1 working end-to-end through the HTTP API, plus the cheap parts of Phases 2/3.**
Verified on the real sermon (`Downloads\ମୂଳଦୁଆ ପୂର୍ବରୁ _ Before the Foundation ... .mp4`, project `20261117-045435-6d0d`
in `%APPDATA%\Viku\projects`, language `auto`):
- analyze ranges 7150–7300 and 5160–5480: wav16 + peaks + 2042 pauses (whole file), 540p proxies (1 s keyframes), shot cuts,
  IndicConformer transcript with Odia/Hindi auto language switching (RNNT + CTC alt + confidence).
- Hindi reel `~1` (known-good segments 5167.70–5185.50, 5415.45–5442.55, 5444.20–5447.25, 5474.90–5478.60) and Odia reel `~2`
  (7224.65–7239.45, 7182.55–7195.90, 8055.40–8071.20) rendered via `POST /reels/{id}/render`: 1080×1920, 51.6 s / 44.0 s,
  −14.2 / −13.9 LUFS, true peak −1.4 (before the TP-margin fix) / −1.8 dBTP; frames checked (captions in Noto, punch-ins, cutaways, dissolves).
- `/automate` on 7150–7300 (count 1) → reel `~3` 40.6 s, −14.0 LUFS, −1.9 dBTP. `/suggest` top-5 overlaps the known-good reels.
- Bible (ory / hin2017 / eng-web) downloaded + FTS; 119 seed illustrations imported; 8 seed bgm + 1 HeyGen track; feedback/learn,
  captions/fix, waveform, /media Range (206), SSE events and job cancel all exercised.

**Run**: `cd engine && uv sync && uv run viku-engine` → http://127.0.0.1:8765 (data in `%APPDATA%\Viku`, `VIKU_DATA` overrides).
Details: `engine/README.md`.

**Known gaps / next**
- Cutaway auto-pick is keyword-only (concepts.json → library tags): 3–4 cutaways per reel, below the 50–60 % target; needs the
  Phase 3 embedding model (`brain/embed.py` hook) and new images per reel (Gemini/AI Studio capture is the app's job).
- Verse cards only for explicit references ("Romans 10:10", "ରୋମୀୟ ୧୦ ଅଧ୍ୟାୟ ୧୦"); paraphrased verses need the editor / semantic match.
- Clip-finder weights are hand-set; `/learn` switches to the logistic-regression ranker after ≥ 10 keep/reject labels.
  The 662 labelled windows + e5 embeddings in `data/brain_seed/` (another agent, commit cdeddc9) are NOT yet fed to the ranker
  (needs audio features for those windows + the e5 ONNX model behind `brain/embed.py`); its caption corrections ARE used. No pitch-variance feature yet.
- Thumbnail = frame grab only (style templates + cut-out = Phase 2 designer). `/auth/heygen/login` is implemented but untested
  (the user was already signed in). No local LLM titles.
- Wide-crop decision follows static_tracks.py (2–98 % spread > 250 px); a stray second face can widen a still shot.
- Full-sermon analyze (2h26m) not timed yet; ASR is CPU-only (~1 s per 6 s chunk → roughly 25–40 min for a full sermon).
