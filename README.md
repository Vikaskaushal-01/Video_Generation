# AI Video Studio

Type a prompt (or upload an image) and get an AI-generated video.

**How it's hosted:** the website is on Vercel, but videos are generated and saved on the host PC
in the `videos/` folder (no database). Vercel forwards every `/api` request to the PC through a free ngrok tunnel.

```
visitor → your-site.vercel.app → ngrok tunnel → this PC (server.js) → videos/
```

The site only works while the host PC is on and `npm run start:public` is running.

Providers (pick one with `VIDEO_PROVIDER` in `.env`): `huggingface` (free), `zhipu` (free), `gemini` (paid).

## Files

- `public/index.html` – the website
- `api/index.js` – Vercel function that forwards `/api/*` to the PC (`BACKEND_URL`)
- `server.js` – the real server: calls the AI and saves videos to `videos/`
- `start-public.js` – starts `server.js` and the ngrok tunnel together

## Setup on the host PC

1. Install ngrok: `winget install Ngrok.Ngrok`, then `ngrok config add-authtoken <token>`
   (token: <https://dashboard.ngrok.com/get-started/your-authtoken>).
2. Copy `.env.example` to `.env`, fill in your key and `NGROK_DOMAIN`
   (free domain: <https://dashboard.ngrok.com/domains>).
3. Set the same domain as `BACKEND_URL` in `api/index.js` and push (Vercel redeploys).
4. Run `npm run start:public` and keep the window open.

Only you on this PC? `npm start` → <http://localhost:3000>.
