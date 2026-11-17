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
node scripts/make-icons.mjs  # re-render build/icon.svg -> build/icon.ico (16-256), build/icons/*.png, resources/icon.png (needs Chrome/Edge)
```

Engine start: the main process probes `/health`; when it fails it runs the configured command
(default `uv run viku-engine` in `../engine`), waits up to 3 min, and kills the process tree on quit — only if it spawned it.
Settings → Engine & models edits the command/folder/URL, toggles auto-start and the data source.

## Data source (live vs mock)

`Settings → Engine & models → Data source`: **Auto** (live when the engine answers, otherwise mock; waits for an engine that
Electron is still starting), **Engine**, or **Mock data**. Mock is a full in-memory engine (`src/renderer/src/api/mock.ts`)
with Odia/Hindi/English sample content and simulated jobs, so every screen works offline. Overrides for tests:
`VIKU_QUERY="adapter=mock&debug=1"` (query passed to the renderer), `VIKU_NO_ENGINE=1` (never spawn),
`VIKU_USER_DATA=<dir>` (isolated profile), `VIKU_OPEN_SIGNIN=1`; query flags `onboarding=1` (force the welcome guide),
`no-onboarding=1` (skip it on a fresh profile).

All engine JSON goes through the main process (`engine:request` IPC → `fetch`), so there is no CORS and no webSecurity change;
SSE `/events` is read in main and re-broadcast to every window; jobs that go quiet are polled via `GET /jobs/{id}`.
Media (`<video>`, `<img>`, audio) loads directly from `/media?path=` (Range). Grids and timelines never load the full
library PNGs (1536×2752, ~8 MB): `api.thumbUrl(path, w)` → `viku-thumb://img/?p=<path>&w=320`, a privileged scheme served by the
main process (`src/main/thumbs.ts`): Windows shell thumbnail (async) or nativeImage decode+resize, JPEG q84 cached in
`<userData>/thumbs` (= `%APPDATA%\Viku\thumbs`), key = path+size+mtime+width. ~30 KB per image; the engine's `/media` has no size param.

### Engine shape notes (handled in `api/normalize.ts` / `api/http.ts`)
- Crops: the engine stores `cx`/`cw` in **source pixels**; the UI works in 0..1 of the source width and converts back on save.
- Proxies cover analysed ranges only (`proxies:[{path,start,end}]`); the viewer picks the proxy covering a source time and
  falls back to the original video.
- Every decoder spreads the raw object first, so unknown engine fields (`alt`, `conf`, `jumps`, `lib_id`, `why`, `peaks`, …)
  survive the whole-project `PUT` (verified: no field lost on round-trip). `thumbnail.pose_t: null` stays null.
- Settings: presets are a `{id: {...}}` map in the engine, a list in the UI (`settingsPatch` converts).
- Suggestions come from `project.suggestions` and the `suggest` job result. Render result `{path, thumbnail}`.
- Not in the contract but used if present: `POST /jobs/{id}/cancel`, `GET /jobs/{id}`, `GET /sfx` (falls back to empty).
- Cutaways: `img: null` + `need {prompt, slug, scene, text, tags}` = waiting for a generated image (UI keeps `img: ''`);
  `why` is a tag list (old) or `{match, z, concept, desc}` / `{nearest}`; `pan` is in output **pixels** (old mock data used 0..1 —
  both handled). Clip names come from the library title (`/library/search?limit=5000` index by id/path → "fallen angel"), then `why.desc`.
- Generate in AI Studio (timeline ✦ button, Cutaways header badge = all, or the Cutaway inspector): the need's prompt is queued
  in the Sign-in window (`signin.queue`), the capture event (`promptId`) is matched by cutaway start time, the project is flushed,
  then `POST /reels/{id}/cutaways/{i}/image {path}` files it into the library and the returned cutaway replaces the local one.

## Layout

```
src/main/        index.ts (windows, IPC), engine.ts (spawn/start/health/SSE/proxy), signin.ts (AI Studio capture), prefs.ts,
                 thumbs.ts (viku-thumb:// cached thumbnails)
src/preload/     contextBridge → window.viku (typed: src/shared/ipc.ts)
src/renderer/
  index.html / signin.html     two entries (main editor, Sign-in window)
  src/api/                     types, client interface, http + mock adapters, normalizers, mock data
  src/state/                   app (UI/layout), editor (project + undo/redo + autosave), playback, jobs
  src/lib/                     reel math (magnetic restructure, blade, trim, crops), media sources, hotkeys, dnd, time,
                               cutaways (readable names, library index), gemini (AI Studio generate → attach)
  src/components/              TopBar, Logo, browser/*, viewer/*, inspector/*, timeline/*, automate/*,
                               shell/* (Onboarding, ShortcutsSheet, EngineBanner, Settings, Export…), ThumbPreview
build/           icon.svg (+ icon-small.svg) → icon.ico, icon.png, icons/NxN.png (scripts/make-icons.mjs)
  src/signin/                  Sign-in window app
```

## Screens

- **Identity**: the Viku mark (`components/Logo.tsx`, same drawing as `build/icon.svg`) — a gold #FFD24A V that doubles as a
  downward play triangle, in a graphite tile with two 9:16 viewfinder corners (dropped below 28 px). Window icon `resources/icon.png`,
  installer icon `build/icon.ico` (16–256 px).
- **First run**: onboarding (`shell/Onboarding.tsx`, shown once via `prefs.onboarded`, reopen in Settings → General): welcome →
  projects/exports folders → engine + models from `/health` (ready / missing + what each enables, Start engine) → optional
  sign-ins (AI Studio, HeyGen, eBible download job) → church name + credit line (live preview) + default language → done.
- **Top bar**: logo, project / reel, Automate | Manual, sign-in chips (Gemini, HeyGen, eBible → open the Sign-in window),
  engine dot (opens Settings), Activity, Keyboard (?), Settings, Export.
- **Engine banner** under the top bar when the engine is down (live) or the app fell back to sample data: Start engine
  (`engine:start` spawns even with auto-start off), Engine settings; "Switch to live data" once it is up. Hidden when the user picked Mock.
- **Browser**: Media (projects, reels, import + analyze), Transcript (search, language badges, low-confidence dots,
  click = seek source, drag = select, Ctrl+drag = add range, Shift+click = extend, Preview / Make reel),
  Suggestions (score bar, reason chips, preview, Keep/Reject → `/feedback`, Learn), Library (virtualised illustrations grid with
  cached thumbnails — only visible rows mount,
  music with preview + HeyGen generate, SFX — all draggable onto tracks), Bible (IRV ory / hin2017 / WEB search, insert).
- **Viewer**: 9:16 reel with fixed crop + punch-in, blurred fill for wide crops, cutaway cross-zoom dissolve (0.7 s),
  title hook (0.2–4.2 s), lower-third captions (400 px from bottom), verse cards (upper half), credit line, safe zones;
  Source 16:9 with the draggable (horizontal-only) crop box; J/K/L shuttle, frame step, timecode, zoom.
- **Inspector**: Reel, Clip (in/out, crop cx/cw, punch-in), Caption (flagged words from `/captions/fix`, one-click fixes,
  edits sent as `caption_edit` feedback), Verse (lookup, top_y), Cutaway (image, Gemini prompt, z0→z1, pan),
  Audio (voice gain, music level/ducking, SFX), Thumbnail (style, pose frame from the real video, text).
- **Timeline**: Verse / Cutaways (thumbnail + readable name; empty = dashed gold "Needs image" clip with a one-click ✦ Generate)
  / Captions / Video / Voice (engine waveform) / Music (ducking line) / SFX. Ruler + scrub,
  zoom slider + Ctrl+wheel, snapping, skimming, jump-cut markers, 60 s marker. Tools: Select (A), Blade (B), Trim (T).
  Drag to move/trim items, drag segments to reorder, ripple delete, drop library items onto lanes.
- **Automate**: wizard (video, language, count, ≤ 60 s cap, illustrations/music/thumbnails) → per-stage progress (sticky card)
  mapped to the engine's job scopes → a finished run collapses into a summary bar and the results gallery sits on top: responsive
  grid of 9:16 cards (engine thumbnail JPG filling the card, or the HTML template preview), language badge, Brain score, duration,
  hover Play = inline preview of the rendered MP4, Open in Manual, Re-render (per-card progress), Export…, Reveal file.
- **Empty / loading / error states** everywhere a list can be empty or slow (skeleton rows and grid, `Empty` with an action).
- **Activity drawer**, **Settings** (general, folders, export presets, engine & offline models), **Export** dialog.
- **Sign-in window**: Google AI Studio in a `WebContentsView` (persistent partition `persist:gemini`, the user signs in;
  plain Chrome UA so Google allows it), prompt queue → Send next (largest textbox → insertText → Ctrl+Enter, clipboard + toast
  fallback), capture via `will-download` + CDP `Network.getResponseBody` (images ≥ 1024 px from googleusercontent, or base64
  inside RPC JSON), dedup by hash, filed in order under the planned name; HeyGen device-code login; eBible download job.

## Keyboard

`?` opens the shortcuts sheet (`shell/ShortcutsSheet.tsx`; keep it in sync with `lib/hotkeys.ts`). All verified by driving the
built app (Playwright key presses → store state):
Space play/pause · J/K/L shuttle · ←/→ frame (Shift = 1 s) · ↑/↓ previous/next edit · Home/End · A/B/T tools ·
Ctrl+B blade at playhead · Delete ripple-delete selection · Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) · Ctrl+S save now · Ctrl+E export ·
I / O mark in / out on the transcript line under the source playhead (Shift+O adds a range) · + / − (and Ctrl+= / Ctrl+−) zoom ·
Shift+Z fit · S skimming · N snapping · Shift+S safe zones · 1 / 2 reel / source viewer · Ctrl+, settings · Esc.

## Known gaps

- AI Studio prompt sending is heuristic by design; captured images are matched to prompts in order (verify names after a batch).
- Thumbnail styles other than `frame` are UI previews only until the engine's thumbnail designer lands (Phase 2).
- The AI Studio → attach path is verified with a simulated capture event (mock) and the engine route exists; a real signed-in
  capture → `/cutaways/{i}/image` round trip on the live engine has not been run (it writes into the user's library).
- Generation requests queued in a session are remembered in memory only (a reload forgets which prompt fills which cutaway).
- `music.duck_db` and `style.voice_gain_db` are UI fields the engine may ignore.
- No installer yet (Phase 4: electron-builder NSIS) — `build/icon.ico` is ready for it.
