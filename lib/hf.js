// Free text/image-to-video on Hugging Face Spaces with automatic fallback.
// Tries each model in order; if one fails (daily GPU limit, Space busy/down/broken) it moves to the next.
// Each model is tried with your HF_TOKEN (your own daily quota) and then anonymously (shared free quota).
// Override the order/subset with HF_MODELS, e.g. HF_MODELS=ltx-distilled,wan22-fast

const NEG = "blurry, low quality, deformed, distorted, watermark, text, static, still image";
const file = (dataUrl) => (dataUrl ? { url: dataUrl, meta: { _type: "gradio.FileData" } } : null);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// [width, height] per shape, each model has its own preferred sizes
const dims = (shape, l, p, s) => ({ landscape: l, portrait: p, square: s })[shape];

export const MODELS = [
  {
    id: "wan22-14b", name: "Wan 2.2 14B", host: "https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space", api: "generate_video",
    needsImage: true,
    data: ({ prompt, frame, seconds }) => [file(frame), prompt, 6, NEG, clamp(seconds, 1, 5), 1, 1, 42, true],
  },
  {
    id: "wan22-fast", name: "Wan 2.2 Fast", host: "https://prithivmlmods-wan2-2-fast.hf.space", api: "generate_video",
    needsImage: true,
    data: ({ prompt, frame, seconds }) => [frame, prompt, 4, NEG, clamp(seconds, 1, 5), 1, 1, 42, true],
  },
  {
    id: "ltx23", name: "LTX 2.3", host: "https://lightricks-ltx-2-3.hf.space", api: "generate_video",
    needsImage: true,
    data: ({ prompt, frame, seconds, shape }) => {
      const [w, h] = dims(shape, [768, 512], [512, 768], [640, 640]);
      return [file(frame), prompt, clamp(seconds, 2, 5), false, 10, true, h, w];
    },
  },
  {
    id: "fastwan-5b", name: "FastWan 2.2 5B", host: "https://alekseycalvin-fastwan2-2-5b-ti2v.hf.space", api: "generate_video",
    needsImage: false, // text-and-image-to-video: uses the frame when there is one
    data: ({ prompt, frame, seconds, shape }) => {
      const [w, h] = dims(shape, [832, 480], [480, 832], [640, 640]);
      return [file(frame), prompt, h, w, NEG, clamp(seconds, 1, 5), 0, 4, 42, true];
    },
  },
  {
    id: "wan21-fast", name: "Wan 2.1 Fast", host: "https://multimodalart-wan2-1-fast.hf.space", api: "generate_video",
    needsImage: true,
    data: ({ prompt, frame, seconds, shape }) => {
      const [w, h] = dims(shape, [832, 480], [480, 832], [640, 640]);
      return [file(frame), prompt, h, w, NEG, clamp(seconds, 1, 5), 1, 4, 42, true];
    },
  },
  {
    id: "ltx-distilled", name: "LTX Video", host: "https://lightricks-ltx-video-distilled.hf.space", api: "text_to_video",
    needsImage: false, // pure text-to-video, very light on GPU quota
    data: ({ prompt, seconds, shape }) => {
      const [w, h] = dims(shape, [704, 480], [480, 704], [576, 576]);
      return [prompt, NEG, null, null, h, w, "text-to-video", clamp(seconds, 1, 8), 9, 42, true, 1, true];
    },
  },
  {
    id: "cogvideox-2b", name: "CogVideoX 2B", host: "https://zai-org-cogvideox-2b-space.hf.space", api: "generate",
    needsImage: false, // text-to-video, fixed 6 s 720×480, slow
    data: ({ prompt }) => [prompt, 30, 6],
  },
];
const FRAME_MODEL = { host: process.env.HF_IMAGE_SPACE || "https://black-forest-labs-flux-1-schnell.hf.space", api: "infer" };

// ---------- Gradio client ----------
async function gradioCall(host, api, data, auth, signal) {
  const r = await fetch(`${host}/gradio_api/call/${api}`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ data }), signal,
  });
  const start = await r.json().catch(() => ({}));
  if (!r.ok || !start.event_id) throw new Error(start.error || start.detail || `Space unavailable (${r.status})`);
  const text = await (await fetch(`${host}/gradio_api/call/${api}/${start.event_id}`, { headers: auth, signal })).text();
  const last = [...text.matchAll(/event: (\w+)\ndata: (.*)/g)].pop();
  if (!last) throw new Error("No response from Space");
  const payload = (() => { try { return JSON.parse(last[2]); } catch { return last[2]; } })();
  if (last[1] !== "complete") {
    const msg = payload?.message || payload?.error || (typeof payload === "string" && payload !== "null" ? payload : "");
    throw new Error(msg || "Space failed to generate (busy, restarting or out of GPU quota)");
  }
  return payload;
}

// Your token first (your quota), then anonymous (shared quota)
async function gradio(host, api, data, signal) {
  const ids = process.env.HF_TOKEN ? [{ Authorization: `Bearer ${process.env.HF_TOKEN}` }, {}] : [{}];
  let err;
  for (const auth of ids) {
    try { return await gradioCall(host, api, data, auth, signal); }
    catch (e) { err = e; if (signal?.aborted) break; }
  }
  throw err;
}

// Find the video in whatever shape a Space returns it
function findVideo(x, depth = 0) {
  if (!x || depth > 5) return null;
  if (typeof x === "string") return x.startsWith("data:video") ? x : null;
  if (Array.isArray(x)) { for (const v of x) { const f = findVideo(v, depth + 1); if (f) return f; } return null; }
  if (typeof x === "object") {
    if (x.video) { const f = findVideo(x.video, depth + 1) || (typeof x.video === "string" && /^https?:/.test(x.video) ? x.video : null); if (f) return f; }
    if (typeof x.url === "string" && (/\.(mp4|webm|mov)(\?|$)/i.test(x.url) || /video/.test(x.mime_type || "") || x.url.startsWith("data:video"))) return x.url;
    for (const v of Object.values(x)) { const f = findVideo(v, depth + 1); if (f) return f; }
  }
  return null;
}

async function makeFrame(prompt, shape, signal) {
  const [w, h] = dims(shape, [832, 480], [480, 832], [640, 640]);
  const [img] = await gradio(FRAME_MODEL.host, FRAME_MODEL.api, [prompt, 0, true, w, h, 4], signal);
  const r = await fetch(img.url, { signal });
  if (!r.ok) throw new Error("Could not download the first frame image");
  return `data:${r.headers.get("content-type") || "image/webp"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
}

const isQuota = (m) => /quota|GPU|exceeded/i.test(m);

export async function generate({ prompt, image, shape, seconds, budgetMs = 280_000 }) {
  const deadline = Date.now() + budgetMs;
  const order = process.env.HF_MODELS ? process.env.HF_MODELS.split(",").map((s) => s.trim()) : MODELS.map((m) => m.id);
  const models = order.map((id) => MODELS.find((m) => m.id === id)).filter(Boolean);
  prompt = prompt || "cinematic motion, smooth animation";

  let frame = image, frameError = null;
  const errors = [];
  for (const m of models) {
    const left = deadline - Date.now();
    if (left < 20_000) { errors.push(`${m.name}: skipped (out of time)`); break; }
    const signal = AbortSignal.timeout(Math.min(left, 200_000));
    try {
      if (m.needsImage && !frame) {
        if (frameError) throw new Error(`needs a first frame (${frameError})`);
        try { frame = await makeFrame(prompt, shape, signal); }
        catch (e) { frameError = e.message; throw new Error(`needs a first frame (${frameError})`); }
      }
      const payload = await gradio(m.host, m.api, m.data({ prompt, frame, seconds: Number(seconds), shape }), signal);
      const videoUrl = findVideo(payload);
      if (!videoUrl) throw new Error("returned no video");
      console.log(`Video made with ${m.name}${errors.length ? ` after: ${errors.join(" | ")}` : ""}`);
      return { videoUrl, model: m.name };
    } catch (e) {
      const msg = e.name === "TimeoutError" ? "took too long" : e.message;
      console.warn(`${m.name} failed: ${msg}`);
      errors.push(`${m.name}: ${msg.slice(0, 160)}`);
    }
  }
  const allQuota = errors.length && errors.every((e) => isQuota(e) || /first frame/.test(e));
  throw new Error(allQuota
    ? "Free daily GPU limit reached on every Hugging Face model — try again later (it resets every day)."
    : `All Hugging Face models are busy or failed right now — try again in a few minutes. (${errors.join(" | ")})`);
}
