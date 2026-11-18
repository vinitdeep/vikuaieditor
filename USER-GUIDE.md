# Viku — User Guide

Viku turns a long sermon video (Odia, Hindi or English) into short vertical reels for Instagram, YouTube Shorts,
Facebook and WhatsApp status. Each reel is 1080 × 1920, under a minute, with captions, Bible verse cards,
illustrations, soft music and a thumbnail — and it always ends on a line of hope.

Everything runs on your own PC. The internet is only needed once (to download the speech models and Bibles) and
for the optional extras (AI pictures, HeyGen music).

---

## 1. Install

1. Double-click **Viku-Setup-0.1.0.exe**.
2. If Windows says *"Windows protected your PC"*, click **More info → Run anyway** (the installer is not
   code-signed yet).
3. Choose the folder (the default is fine) and click **Install**. No administrator password is needed — Viku
   installs for your Windows user only.
4. Viku adds a shortcut on the **Desktop** and in the **Start menu**.

**What your PC needs:** Windows 10 or 11 (64-bit), about **6 GB free disk** (the app, its engine and the models)
plus room for your projects (a 2-hour sermon needs about 2 GB), and 8 GB of memory or more. A graphics card is not
required.

## 2. First start: "Setting up Viku"

The first time you open Viku it prepares its offline engine. You will see a **Setting up Viku** screen with a
progress bar.

- It downloads about **350 MB** and usually takes **2–5 minutes**. Keep the window open.
- If it stops with an error (most often the internet dropped), click **Try again**. Nothing is lost.
- Click **Details** to see exactly what it is doing.

This happens only once (and again for a minute after an update).

**Ready from the first minute:** the installer brings **119 starter illustrations** (Viku's own AI pictures —
creation, praise, prayer, the cross, family, the enemy defeated …), so cutaways work before you generate any
pictures. On the first start Viku also **composes five soft music beds** on your PC — *Hopeful*, *Victorious*,
*Reflective*, *Prayerful* and *Uplifting* (about a minute in the background; no internet needed). Settings →
General → **Starter content** shows both.

## 3. The welcome guide

After the setup, a short guide opens:

1. **Data folder** — where projects and finished reels are kept. The default is fine; pick a bigger drive if
   your C: drive is nearly full.
2. **Engine & models** — download the speech and AI models (see below).
3. **Sign-ins** — optional online helpers (AI Studio pictures, HeyGen music, Bible download).
4. **Your church** — church name and the **credit line** shown small at the bottom of every reel
   (for example *Pastor Jacob Deep · TAPP Church Hirakud*).

You can open the guide again any time: **Settings → General → Show the welcome guide**.

## 4. Models (one-time download)

Open **Settings → Models** (or the guide's *Engine & models* step). You see a list of what Viku needs:

| Item | What it does | Size |
|---|---|---|
| FFmpeg | reads and writes video | 115 MB |
| DeepFilterNet | cleans the preacher's voice | 27 MB |
| IndicConformer | understands Odia and Hindi speech | 2.6 GB |
| multilingual-e5-small | "Viku Brain": finds good moments, matching pictures and verses | 487 MB |
| Noto fonts | captions in Odia, Hindi and English | 2 MB |
| Whisper (optional) | English sermons | 148 MB |
| U-2-Net (optional) | cuts the preacher out for thumbnails | 176 MB |

- Click **Install all required**. A bar shows the megabytes as they arrive.
- **Pause** stops a download; **Resume** continues where it stopped (nothing is downloaded twice).
- The bin icon **removes** an item to free space; you can download it again later.
- Each item shows its **licence** — click it to read it.

### The Hugging Face step (IndicConformer)

The Odia/Hindi speech model is free, but its makers (AI4Bharat) share it only with people who accept their terms
on the Hugging Face website. You do this once:

1. In Viku, click **Open model page**. Your web browser opens the model's page.
2. **Sign up** (free, just an e-mail) or **log in**, then press **Agree and access repository**.
3. On Hugging Face, click your picture → **Settings → Access Tokens → Create new token**. Choose type **Read**,
   give it any name, and **copy** the token (it starts with `hf_`).
4. Back in Viku, **paste** the token in the box under IndicConformer and click **Install**.

The token goes straight to the Viku engine on your PC (kept encrypted for later downloads); it is never shown
again and never sent anywhere except Hugging Face.

**No account?** If someone already has the model (another church PC, a USB stick), click **Install from
folder…** and choose the folder that contains it. Viku checks every file before using it. A church can also set
a **Models mirror** (Settings → Models) — a web folder with the same files — for a shared or faster download.

**What the error messages mean**

- *Hugging Face needs your free account* — do the four steps above; check that you pressed **Agree** with the
  same account and that the token type is **Read**.
- *The download could not reach the internet* — check Wi-Fi / data and press **Resume**.
- *The downloaded file was damaged* — press **Install** again; if it repeats, try another network or a mirror.

## 5. Automate: one click, finished reels

1. Click **Automate** at the top.
2. **Sermon video** — choose the MP4 (or click a *Recent* sermon).
3. **Language** — Odia, Hindi, English, or **Auto** for sermons that mix languages.
4. **Reels** — how many (1–12) and the maximum length (up to 60 s).
5. **Sermon part** (optional) — only listen to part of a long sermon, e.g. from `2:10:50` to `2:13:20`. This is
   much faster than the whole two hours. Leave it empty for the whole sermon.
6. **Options** — pictures from your **Library** (or none), music from the library, thumbnails on/off. Voice
   cleaning is always on.
7. Click **Make N reels**. The pipeline shows each stage: *Analyze → Find clips → Build reels → Render*.

When it finishes, the reels appear as cards: play them right there, **Open in Manual** to adjust, **Export…**,
or **Reveal** the MP4 file in Explorer.

Time guide on an ordinary PC: about 3 minutes for a 2–3 minute part of the sermon; a full 2-hour sermon takes much
longer the first time (the speech is transcribed once and remembered).

## 6. Manual editing basics

Click **Manual**. The screen has four areas:

- **Left — Browser:** *Media* (sermons and reels), *Transcript* (what was said, line by line), *Suggestions*
  (moments Viku Brain recommends), *Library* (pictures, music, sound effects), *Bible*.
- **Middle — Viewer:** *Reel 9:16* shows the reel as it will look; *Source 16:9* shows the original video with
  the crop box; *Rendered* plays the finished MP4.
- **Right — Inspector:** the settings of whatever you selected (reel, clip, caption, verse, cutaway, audio,
  thumbnail).
- **Bottom — Timeline:** verse cards, cutaways (pictures), captions, video, voice, music and sound effects.

Common jobs:

- **Make a reel by hand:** in *Transcript*, drag across the lines you want (Ctrl+drag to add another part) and
  click **Make reel**.
- **Fix a caption:** click the caption on the timeline, correct the text in the Inspector, click outside the box.
  Viku remembers your correction for next time.
- **Change a picture:** click the picture (cutaway) on the timeline → **Swap from Library**, then double-click a
  picture in the Library (or drag a picture onto the cutaway). Its timing and zoom stay the same.
- **Jump cuts:** press **B** for the blade, click a video clip to cut it, press **A** to go back to select. Drag a
  clip left or right to move it; select and press **Delete** to remove it (the rest closes up).
- **Crop:** in *Source 16:9*, drag the box to keep the preacher in frame.
- **Undo / Redo:** Ctrl+Z / Ctrl+Y. **Save:** automatic (Ctrl+S saves at once).
- **Keyboard:** press **?** for all shortcuts (Space play, J/K/L shuttle, ←/→ frame, I/O mark lines…).

## 7. AI Studio pictures (free)

When the library has no fitting picture, the cutaway shows a dashed gold **Needs image** clip.

**Automatic (recommended): the Viku extension.** Google does not let other apps use AI Studio, so Viku makes the
pictures in your own Chrome or Edge with a small extension. Set it up once:

1. Sign-in window → **Google AI Studio** → **Open extension folder**.
2. In Chrome open `chrome://extensions` (Edge: `edge://extensions`) and switch on **Developer mode**.
3. Click **Load unpacked** and choose that folder. The Viku icon appears in the toolbar.
4. In the same browser, open aistudio.google.com once and sign in with your own Google account.

Click **AI pictures** in the top bar to see what is happening — progress, each picture as it is made, and Retry for
any that failed; it opens there by itself when reels need new pictures, inside Viku’s window. From then on, every
prompt Viku queues is made one at a time in an AI Studio tab the extension opens, and the
picture lands on its cutaway by itself — keep the browser open and carry on working. Your other AI Studio tabs are
never touched, and Viku never sees your password. If AI Studio says you have reached a limit, Viku waits 10 minutes
and carries on (press **Send next** to try sooner). The extension's toolbar button shows what it is doing and can
switch it off.

**By hand (without the extension):**

1. Click **✦ Generate** on that clip (or **Generate all** at the top of the Cutaways track). The Sign-in window
   opens with Google **AI Studio** inside it.
2. The first time, **sign in to Google** inside that window (your own account — Viku never sees your password).
3. Click **Send next**. Viku types the prepared prompt into AI Studio and sends it. If it cannot, it copies the
   prompt — click AI Studio's prompt box, press Ctrl+V and send.
4. When the picture appears, it is captured automatically (or click AI Studio's download button) and placed on the
   right cutaway. It is also added to your Library for future reels.

The queue is remembered: if you close Viku while prompts are waiting, they are still there next time, and a
picture that arrives later still lands on its cutaway.

## 8. Music

Viku picks a music bed for each reel from its theme: a victory message gets the **Victorious** bed, a prayer
message **Prayerful**, a message about struggle or depression **Reflective**, hope and God's love **Hopeful**,
salvation **Uplifting**. You can always choose another track in **Library → Music** (double-click it, or drag it
onto the Music track).

**Make a new bed (offline, free):** in **Library → Music → Generate music**, pick a mood and click **Generate**
(10–20 seconds). The new bed plays as a preview — click **Add to library** to keep it, or **Try another** for a
different one. Generated music is made on your PC, is royalty-free and may be used in any video; it never uses
bell, chime or shimmer sounds. Each bed is 90 seconds and loops seamlessly under longer reels.

**HeyGen music (optional, online):**

1. Click the **HeyGen** chip at the top → **Sign in**. A code appears; open the link, enter the code and approve.
   (No password is typed into Viku.)
2. In **Library → Music**, describe the mood ("hopeful worship piano") under *Generate with HeyGen* and click
   **Generate**. The new track joins your music library. HeyGen tracks are licensed to your HeyGen account.

Music is always mixed quietly under the voice (it dips when the preacher speaks).

## 9. Bibles

Verse cards use offline Bibles: **IRV Odia**, **IRV Hindi** and the **World English Bible**. Download them once:
the **eBible** chip at the top (or the welcome guide) → **Download**. The first download also prepares a
"meaning index" (about 7–8 minutes per Bible) so Viku can recognise a verse even when the preacher paraphrases it.

In **Manual → Bible** you can search verses and drag one onto the **Verse** track.

## 10. Exporting

- In the Inspector (**Reel → Build & export**) choose a preset and click **Render**. When it is done, the file
  appears under the button — **Play** shows it in the viewer, **Show** opens the folder.
- **Export** (top right, or Ctrl+E) renders several reels at once.
- Reels are saved as `exports\<number>-<title>.mp4` with a matching `.jpg` thumbnail, in the project's folder
  (or the exports folder you chose in Settings → Folders).
- Every reel: 1080 × 1920, 30 fps, H.264, loudness −14 LUFS — ready for Instagram, YouTube Shorts and Facebook.

## 11. Troubleshooting

| Problem | What to do |
|---|---|
| "Setting up Viku" failed | Check the internet, click **Try again**. Click **Details** and note the last line if you ask for help. |
| A banner says the engine is not running | Click **Start engine**. If it keeps stopping, restart Viku. Settings → Engine shows the engine's log. |
| "Hugging Face needs your free account" | Do the token steps in section 4 (Agree on the model page, **Read** token). Or use **Install from folder…**. |
| Download stopped half way | Press **Resume** — it continues from where it stopped. |
| No Odia/Hindi captions | Settings → Models: IndicConformer must say **Installed**. |
| No verse cards | Download the Bibles (section 9). |
| Pictures are wrong for the words | Swap them from the Library, or generate new ones in AI Studio. Viku learns from the reels you keep. |
| The Library has no pictures / no music | Settings → General → **Starter content** → *Re-import starter illustrations*; Library → Music → **Generate music**. |
| AI Studio prompt was not sent | Click in AI Studio's prompt box, press Ctrl+V, then Ctrl+Enter. |
| Disk is full | Settings → Models: remove optional models; delete old projects' proxy files from Media; move Projects to another drive (Settings → Folders). |
| Windows SmartScreen warning on install | **More info → Run anyway** (the installer is not signed yet). |

**Where things are kept:** your projects, models, Bibles, library and settings live in
`%APPDATA%\Viku` (type that into the Explorer address bar). The app itself is in
`%LOCALAPPDATA%\Programs\Viku`.

**Uninstalling:** Windows Settings → Apps → Viku → Uninstall. Your projects and models are **kept** unless you
tick **"Also delete my projects, models and settings"** in the uninstaller.

**About & licences:** Settings → General → **About & licences** lists every open-source component Viku uses and
its licence. The starter illustrations were made with Google Gemini / AI Studio by the Viku project and are free
to use in Viku videos.
