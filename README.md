# PriAi Motion Spot (Local Workflow)

The self-serve Netlify deployment has been retired. This repo now targets a local-only
pipeline so we can render PriAi motion spots on Sailesh's workstation without
serverless limits.

## Prerequisites

- macOS with Node.js 22 (already installed on the Mac mini)
- `.env` at the workspace root (`/Users/home/.openclaw/workspace/.env`) with:
  - `FIRECRAWL_API_KEY`
  - `ELEVENLABS_API_KEY`
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_REMOTION_BUCKET`, `SUPABASE_REMOTION_OBJECT`
- Remotion bundle synced to `../output/priai-design-video` (run `npm run upload:remotion`
  if you need to refresh from Supabase)

## Run the local app

```bash
cd /Users/home/.openclaw/workspace/priai-selfserve
npm install        # one-time
npm run dev        # serves the UI + API on http://localhost:3000
```

Leave the `npm run dev` process running. It hosts both the React front-end _and_
the `/api` endpoints that drive the Remotion pipeline.

## Submit a render job

You can use either the UI (http://localhost:3000) or a curl command:

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Narrate the StreetCloud site for a consulting partner.",
    "websiteUrl": "https://streetcloud.net",
    "outputFormat": "16:9",
    "runtime": "60s",
    "voiceId": "aurora",
    "ctaCopy": "Book a live PriAi Design working session at priai.ai/demo"
  }'
```

The job runner logs to the UI (“Production log” accordion) and saves the rendered
MP4 to `../output/priai-design-video/out/<job-id>.mp4`.

## Refresh the Remotion bundle

If you update the Remotion project under `../output/priai-design-video`, run:

```bash
npm run upload:remotion   # optional – pushes bundle to Supabase backup
```

If you want to re-fetch from Supabase instead, delete the local folder and run the
app once; the server will download the archive automatically.

## Notes

- Firecrawl scraping + ElevenLabs synthesis run locally via the keys in `.env`.
- There is no Netlify deployment anymore; all requests go through the local `npm run dev`
  process (reachable from OpenClaw/Telegram via tunnel if needed).
- The `/api/jobs` endpoint uses the in-memory job store, so keep the dev process
  running until each render finishes.
