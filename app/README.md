# Viku — desktop UI

Electron 45 + React 19 + TypeScript (strict) + Vite 8 (electron-vite 6). Zustand + Immer for state (undoable reel
document), lucide-react icons, bundled fonts (Inter for UI, Noto Sans Oriya / Devanagari for script text — no CDN).
Talks to the Python engine (`../engine`, http://127.0.0.1:8765) through a typed API client — contract in
`../ARCHITECTURE.md`.

## Run

```bash
npm install
npm run dev          # Electron + Vite HMR; starts the engine itself if GET /health fails
npm run build        # typecheck (main + renderer) + production bundle in out/
npm run lint         # eslint (typescript-eslint + react-hooks)
npm run preview      # run the built app
npm run mock:media   # optional: cut a 6-min 540p proxy, 12 illustrations and audio previews into public/mock/
npm run screenshots  # build first; drives the app with Playwright, writes screenshots/*.png (add -- --live for the engine)
```

Engine start: the main process probes `/health`; when it fails it runs the configured command
(default `uv run viku-engine` in `../engine`), waits up to 3 min, and kills the process tree on quit — only if it spawned it.
Settings → Engine & models edits the command/folder/URL, toggles auto-start and the data source.

## Data source (live vs mock)

`Settings → Engine & models → Data source`: **Auto** (live when the engine answers, otherwise mock; waits for an engine that
Electron is still starting), **Engine**, or **Mock data**. Mock is a full in-memory engine (`src/renderer/src/api/mock.ts`)
with Odia/Hindi/English sample content and simulated jobs, so every screen works offline. Overrides for tests:
`VIKU_QUERY="adapter=mock&debug=1"` (query passed to the renderer), `VIKU_NO_ENGINE=1` (never spawn),
`VIKU_USER_DATA=<dir>` (isolated profile), `VIKU_OPEN_SIGNIN=1`.

All engine JSON goes through the main process (`engine:request` IPC → `fetch`), so there is no CORS and no webSecurity change;
SSE `/events` is read in main and re-broadcast to every window; jobs that go quiet are polled via `GET /jobs/{id}`.
Media (`<video>`, `<img>`, audio) loads directly from `/media?path=` (Range).

### Engine shape notes (handled in `api/normalize.ts` / `api/http.ts`)
- Crops: the engine stores `cx`/`cw` in **source pixels**; the UI works in 0..1 of the source width and converts back on save.
- Proxies cover analysed ranges only (`proxies:[{path,start,end}]`); the viewer picks the proxy covering a source time and
  falls back to the original video.
- Every decoder spreads the raw object first, so unknown engine fields (`alt`, `conf`, `jumps`, `lib_id`, `why`, `peaks`, …)
  survive the whole-project `PUT` (verified: no field lost on round-trip). `thumbnail.pose_t: null` stays null.
- Settings: presets are a `{id: {...}}` map in the engine, a list in the UI (`settingsPatch` converts).
- Suggestions come from `project.suggestions` and the `suggest` job result. Render result `{path, thumbnail}`.
- Not in the contract but used if present: `POST /jobs/{id}/cancel`, `GET /jobs/{id}`, `GET /sfx` (falls back to empty).

## Layout

```
src/main/        index.ts (windows, IPC), engine.ts (spawn/health/SSE/proxy), signin.ts (AI Studio capture), prefs.ts
src/preload/     contextBridge → window.viku (typed: src/shared/ipc.ts)
src/renderer/
  index.html / signin.html     two entries (main editor, Sign-in window)
  src/api/                     types, client interface, http + mock adapters, normalizers, mock data
  src/state/                   app (UI/layout), editor (project + undo/redo + autosave), playback, jobs
  src/lib/                     reel math (magnetic restructure, blade, trim, crops), media sources, hotkeys, dnd, time
  src/components/              TopBar, browser/*, viewer/*, inspector/*, timeline/*, automate/*, shell/*, ThumbPreview
  src/signin/                  Sign-in window app
```

## Screens

- **Top bar**: logo, project / reel, Automate | Manual, sign-in chips (Gemini, HeyGen, eBible → open the Sign-in window),
  engine dot (opens Settings), Activity, Settings, Export.
- **Browser**: Media (projects, reels, import + analyze), Transcript (search, language badges, low-confidence dots,
  click = seek source, drag = select, Ctrl+drag = add range, Shift+click = extend, Preview / Make reel),
  Suggestions (score bar, reason chips, preview, Keep/Reject → `/feedback`, Learn), Library (illustrations grid,
  music with preview + HeyGen generate, SFX — all draggable onto tracks), Bible (IRV ory / hin2017 / WEB search, insert).
- **Viewer**: 9:16 reel with fixed crop + punch-in, blurred fill for wide crops, cutaway cross-zoom dissolve (0.7 s),
  title hook (0.2–4.2 s), lower-third captions (400 px from bottom), verse cards (upper half), credit line, safe zones;
  Source 16:9 with the draggable (horizontal-only) crop box; J/K/L shuttle, frame step, timecode, zoom.
- **Inspector**: Reel, Clip (in/out, crop cx/cw, punch-in), Caption (flagged words from `/captions/fix`, one-click fixes,
  edits sent as `caption_edit` feedback), Verse (lookup, top_y), Cutaway (image, Gemini prompt, z0→z1, pan),
  Audio (voice gain, music level/ducking, SFX), Thumbnail (style, pose frame from the real video, text).
- **Timeline**: Verse / Cutaways / Captions / Video / Voice (engine waveform) / Music (ducking line) / SFX. Ruler + scrub,
  zoom slider + Ctrl+wheel, snapping, skimming, jump-cut markers, 60 s marker. Tools: Select (A), Blade (B), Trim (T).
  Drag to move/trim items, drag segments to reorder, ripple delete, drop library items onto lanes.
- **Automate**: wizard (video, language, count, ≤ 60 s cap, illustrations/music/thumbnails) → per-stage progress mapped to the
  engine's job scopes → results gallery (Open in Manual, Re-render, Export).
- **Activity drawer**, **Settings** (general, folders, export presets, engine & offline models), **Export** dialog.
- **Sign-in window**: Google AI Studio in a `WebContentsView` (persistent partition `persist:gemini`, the user signs in;
  plain Chrome UA so Google allows it), prompt queue → Send next (largest textbox → insertText → Ctrl+Enter, clipboard + toast
  fallback), capture via `will-download` + CDP `Network.getResponseBody` (images ≥ 1024 px from googleusercontent, or base64
  inside RPC JSON), dedup by hash, filed in order under the planned name; HeyGen device-code login; eBible download job.

## Keyboard

Space play/pause · J/K/L shuttle · ←/→ frame (Shift = 1 s) · ↑/↓ previous/next edit · Home/End · A/B/T tools ·
Ctrl+B blade at playhead · Delete ripple-delete selection · Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) · Ctrl+= / Ctrl+− zoom ·
Shift+Z fit · S skimming · N snapping · Shift+S safe zones · 1 / 2 reel / source viewer · Ctrl+E export · Ctrl+, settings · Esc.

## Known gaps

- Library grid loads full-size PNGs (1536×2752, ~8 MB) from `/media` — an engine thumbnail size param would make it snappy.
- AI Studio prompt sending is heuristic by design; captured images are matched to prompts in order (verify names after a batch).
- Thumbnail styles other than `frame` are UI previews only until the engine's thumbnail designer lands (Phase 2).
- `music.duck_db` and `style.voice_gain_db` are UI fields the engine may ignore.
- No installer yet (Phase 4: electron-builder NSIS).
