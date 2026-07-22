# Car Fox

Monorepo for the Car Fox web experience, the live "fox" avatar, and the
**SOMEBODY KNOWS** :30 campaign.

## The fox is self-hosted now

The talking Car Fox is rendered **entirely in the browser** — a parametric SVG
rig ([`FoxAvatar.tsx`](carfox-web/components/FoxAvatar.tsx)) lip-synced in real
time by WebAudio formant analysis ([`foxLipsync.ts`](carfox-web/lib/foxLipsync.ts))
over a **browser-direct Gemini Live** call ([`FoxLiveCall.tsx`](carfox-web/components/FoxLiveCall.tsx)).
No avatar vendor, no per-minute credits, no GPU server, no Python sidecar.

Auth: the browser never sees the Gemini API key — [`/api/fox-token`](carfox-web/app/api/fox-token/route.ts)
mints a **single-use ephemeral token** (60s to connect, 30min hard cap) per call.

Visual QA bench for the rig: `/fox-lab` (idle / manual sliders / vowel drill).

## Layout

| Path            | What it is |
| --------------- | ---------- |
| `carfox-web/`   | Next.js 16 app — hero site, vehicle pages, site-wide fox dock. **This is the deployed app.** |
| `fox-agent/`    | **DEPRECATED** — the old pipecat/LemonSlice sidecar daemon. Unused since the fox went local; the GCE VM that ran it can be deleted. |
| `production/`   | SOMEBODY KNOWS masters (16×9 / 4×5), clips, VO, end cards, and the production report. |
| `*.html`, `server.py`, `cars.js` | Early prototypes kept for reference. |

## Deployment (CI/CD → Vercel)

The `carfox-web` app deploys to Vercel automatically:

- **Push to `main`** → production deploy.
- **Push any other branch / open a PR** → preview deploy.

Vercel is configured with **Root Directory = `carfox-web`** so it builds the app
from within this monorepo.

### Required environment variables (set in Vercel, not committed)

| Variable | Used by |
| --- | --- |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `/api/fox-token` — mints ephemeral Gemini Live tokens (key stays server-side) |
| `SITE_PASSCODE` | the `/gate` access wall |

No longer needed (safe to remove): `LEMONSLICE_API_KEY`, `FOX_DAEMON_URL`,
`FOX_DAEMON_SECRET`.

Copy `carfox-web/.env.local` locally for development; never commit real keys.

## Local development

```bash
cd carfox-web
npm install
npm run dev        # http://localhost:3000
```
