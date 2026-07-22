# Car Fox

Monorepo for the Car Fox web experience, the live "fox" avatar, and the
**SOMEBODY KNOWS** :30 campaign.

## Two fox stacks

**The corner dock** (production, every page) runs the **LemonSlice** live
avatar: [`FoxRoomCall.tsx`](carfox-web/components/FoxRoomCall.tsx) joins a
LemonSlice-hosted Daily room; the pipecat sidecar
([`fox-agent/fox_daemon.py`](fox-agent/fox_daemon.py), hosted on a GCE VM)
drives Gemini Live → the LemonSlice fox lip-syncs it back as video.
**The GCE VM and LemonSlice subscription must stay up** — the dock depends on
them.

**The Avatar Lab** (`/avatar`, sandbox only) is the experimental vendor-free
stack: upload a photo → MediaPipe rig → mesh-warp renderer
([`PhotoAvatar.tsx`](carfox-web/components/PhotoAvatar.tsx)) over browser-direct
Gemini Live with ephemeral tokens ([`/api/fox-token`](carfox-web/app/api/fox-token/route.ts)).
Nothing in the lab affects the dock. The SVG fox QA bench lives at `/fox-lab`.

## Layout

| Path            | What it is |
| --------------- | ---------- |
| `carfox-web/`   | Next.js 16 app — hero site, vehicle pages, site-wide fox dock. **This is the deployed app.** |
| `fox-agent/`    | Python (pipecat) warm daemon powering the dock's LemonSlice call. Runs on GCE VM `car-fox-daemon` (34.122.23.74:8080). |
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
| `FOX_DAEMON_URL` | `/api/fox-room` — the GCE fox daemon (http://34.122.23.74:8080) |
| `FOX_DAEMON_SECRET` | `/api/fox-room` — shared secret for the daemon |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `/api/fox-token` — ephemeral tokens for the Avatar Lab sandbox |
| `SITE_PASSCODE` | the `/gate` access wall |

(`LEMONSLICE_API_KEY` lives on the daemon VM, not in Vercel.)

Copy `carfox-web/.env.local` locally for development; never commit real keys.

## Local development

```bash
cd carfox-web
npm install
npm run dev        # http://localhost:3000
```
