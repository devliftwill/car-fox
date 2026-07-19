# Car Fox

Monorepo for the Car Fox web experience, the live "fox" avatar agent, and the
**SOMEBODY KNOWS** :30 campaign.

## Layout

| Path            | What it is |
| --------------- | ---------- |
| `carfox-web/`   | Next.js 16 app — hero site, `/live` LemonSlice fox avatar, vehicle pages. **This is the deployed app.** |
| `fox-agent/`    | Python (pipecat) warm daemon that keeps a low-latency fox call ready. Local/host-side only. |
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
| `LEMONSLICE_API_KEY` | `/api/fox-session` — creates the LemonSlice live-avatar session |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | fox conversation model |

Copy `carfox-web/.env.local` locally for development; never commit real keys.

## Local development

```bash
cd carfox-web
npm install
npm run dev        # http://localhost:3000
```
