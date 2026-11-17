# AI Video Studio

Type a prompt (or upload an image) and get an AI-generated video.

Supported providers (pick one with `VIDEO_PROVIDER`):

| Provider | Model | Cost |
|---|---|---|
| `huggingface` | FLUX first frame + Wan 2.2 on Hugging Face Spaces | free (daily GPU quota) |
| `zhipu` | CogVideoX-Flash | free |
| `gemini` | Gemini Omni Flash (supports editing a video) | paid |

## Project layout

- `public/index.html` – the whole frontend
- `api/index.js` – the API, deployed as a single Vercel function
- `lib/providers.js` – video providers
- `lib/store.js` – job records in Upstash Redis, videos in Vercel Blob
- `server.js` – optional zero-dependency local server (stores files on disk)

## Deploy to Vercel

1. Import this repo at <https://vercel.com/new>.
2. In the project, open **Storage** and add **Blob** and **Upstash Redis** (their env vars are added automatically).
3. In **Settings → Environment Variables** add `VIDEO_PROVIDER` and the matching key (`HF_TOKEN`, `ZHIPU_API_KEY` or `GEMINI_API_KEY`). See `.env.example`.
4. Redeploy.

Long Zhipu jobs are advanced on each status poll; Hugging Face and Gemini jobs run in the background for up to 300 s (`maxDuration` in `vercel.json`).

## Run locally

```bash
npm install
cp .env.example .env   # fill in your keys
npm run start:local    # http://localhost:3000, no Vercel needed
# or: npm run dev      # vercel dev, uses Blob + Redis
```
