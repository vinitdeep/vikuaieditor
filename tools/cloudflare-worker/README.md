# Viku AI pictures — your church's free picture service

Viku can paint a **new AI picture for every cutaway of every reel** by itself. It reads the sermon line under each
cutaway (Odia, Hindi or English), writes an English scene for it with a text model, and paints the scene with an image
model. Both run on **Cloudflare Workers AI**, on your own free Cloudflare account.

Free plan: 10,000 "neurons" a day — about **80 pictures a day** (a 1-minute reel uses ~8). It resets every day.

## Set it up once (about 10 minutes)

1. Make a free account at <https://dash.cloudflare.com/sign-up>.
2. Install Node.js (<https://nodejs.org>), open a terminal in this folder and run:

   ```
   npx wrangler login
   npx wrangler deploy
   ```

   It prints your service URL, for example `https://viku-pictures.<your-name>.workers.dev`.
3. Choose a long random key (a password only Viku will know) and store it in the worker:

   ```
   npx wrangler secret put API_KEY
   ```

4. In Viku: **Settings → AI pictures** → paste the URL and the key → **Save**. Viku keeps the key encrypted.

From then on every reel gets new AI pictures while it is built (Automate and Manual). In Manual, the Reel panel's
**New AI pictures for this reel** button repaints an existing reel and re-renders it.

## What the service does

| Request | Does |
|---|---|
| `POST /` `{prompt, model: "flux" \| "sdxl", steps, width, height}` | one picture (Flux 1024×1024, SDXL up to 768×1344) |
| `POST /text` `{messages, model: "llama"}` | a short answer from a text model (sermon line → English scene) |
| `GET /models` | the picture models |

Every request needs `Authorization: Bearer <your key>`; anything else gets 401.
