# AI Video Studio

Type a prompt (or upload an image) and get an AI-generated video. Runs on Vercel with **no database**:
the API calls the AI and returns a link to the video, and each visitor's history is kept in their own browser.

## Deploy

1. Import this repo at <https://vercel.com/new>.
2. In **Settings → Environment Variables** add:
   - `VIDEO_PROVIDER` = `huggingface` (free) or `zhipu` (free)
   - `HF_TOKEN` (<https://huggingface.co/settings/tokens>) or `ZHIPU_API_KEY` (<https://open.bigmodel.cn/usercenter/apikeys>)
3. Redeploy.

Videos are hosted by the AI service, which deletes them after a while — use **Download** to keep one.

## Files

- `public/index.html` – the website
- `api/index.js` – the API (one Vercel function)
