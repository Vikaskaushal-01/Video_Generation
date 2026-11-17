// AI Video Studio API — stateless Vercel function, no database.
// It calls the AI provider and returns a link to the finished video; the browser keeps the history.
// Your API key stays here (Vercel environment variable) and is never sent to the browser.
//
//   GET  /api/config          -> options for the UI
//   POST /api/videos          -> generate; returns { status: "completed", videoUrl } or { status: "processing", taskId }
//   GET  /api/videos/:taskId  -> check a processing task (zhipu)

const PROVIDER_ID = (process.env.VIDEO_PROVIDER || "huggingface").toLowerCase();

async function readJson(r) {
  const json = await r.json().catch(() => ({}));
  return Array.isArray(json) ? json[0] || {} : json;
}

// ---------- Hugging Face (free): FLUX draws the first frame, Wan 2.2 animates it ----------
async function gradio(host, api, data) {
  const auth = { Authorization: `Bearer ${process.env.HF_TOKEN}` };
  const r = await fetch(`${host}/gradio_api/call/${api}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
  const start = await readJson(r);
  if (!r.ok || !start.event_id) throw new Error(start.error || start.detail || `Hugging Face Space unavailable (${r.status}) — it may be restarting, try again in a minute`);
  const text = await (await fetch(`${host}/gradio_api/call/${api}/${start.event_id}`, { headers: auth })).text();
  const last = [...text.matchAll(/event: (\w+)\ndata: (.*)/g)].pop();
  if (!last) throw new Error("No response from Hugging Face Space");
  const payload = (() => { try { return JSON.parse(last[2]); } catch { return last[2]; } })();
  if (last[1] !== "complete") {
    const msg = payload?.message || payload?.error || (typeof payload === "string" && payload !== "null" ? payload : "");
    if (/quota|GPU/i.test(msg)) throw new Error(`Free daily GPU limit reached on Hugging Face — try again later (it resets every day). ${msg}`);
    throw new Error(msg || "The Hugging Face Space failed to generate (it may be busy or restarting) — try again in a minute");
  }
  return payload;
}

const ZHIPU_ERRORS = {
  1000: "Invalid API key — check ZHIPU_API_KEY", 1002: "Invalid API key — check ZHIPU_API_KEY", 1003: "API key expired",
  1113: "Account has no balance for this model (use cogvideox-flash, the free one)", 1261: "Prompt too long",
  1301: "Blocked by safety filter — please reword your prompt", 1302: "Too many requests at once — wait a minute and try again",
  1303: "Too many requests — wait and try again", 1305: "Free daily limit reached — try again tomorrow",
};
async function zhipu(method, path, body) {
  const r = await fetch(`https://open.bigmodel.cn/api/paas/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.ZHIPU_API_KEY}`, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  const json = await readJson(r);
  if (!r.ok) {
    const code = Number(json.error?.code);
    throw new Error(ZHIPU_ERRORS[code] ? `${ZHIPU_ERRORS[code]} (code ${code})` : json.error?.message || json.msg || `API error ${r.status}`);
  }
  return json;
}

const PROVIDERS = {
  huggingface: {
    label: "Wan 2.2 on Hugging Face · free",
    keyName: "HF_TOKEN",
    keyUrl: "https://huggingface.co/settings/tokens",
    promptLimit: 1000,
    fields: [
      { name: "shape", label: "Shape", default: "landscape", options: [["landscape", "▭ Landscape 16:9"], ["portrait", "▯ Portrait 9:16"], ["square", "◻ Square"]] },
      { name: "seconds", label: "Length", default: "4", options: [["2", "2 sec"], ["3", "3 sec"], ["4", "4 sec"], ["5", "5 sec"]] },
    ],
    portrait: (o) => o.shape === "portrait",
    async start({ prompt, image, options }) {
      const [w, h] = { landscape: [832, 480], portrait: [480, 832], square: [640, 640] }[options.shape];
      const imageHost = process.env.HF_IMAGE_SPACE || "https://black-forest-labs-flux-1-schnell.hf.space";
      const videoHost = process.env.HF_VIDEO_SPACE || "https://prithivmlmods-wan2-2-fast.hf.space";
      if (!image) {
        const [img] = await gradio(imageHost, "infer", [prompt, 0, true, w, h, 4]);
        const r = await fetch(img.url);
        if (!r.ok) throw new Error("Could not download the first frame image");
        image = `data:${r.headers.get("content-type") || "image/webp"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
      }
      const [vid] = await gradio(videoHost, "generate_video",
        [image, prompt || "cinematic motion, smooth animation", 4, "blurry, low quality, deformed, watermark, static", Number(options.seconds), 1, 1, 42, true]);
      const videoUrl = vid?.video?.url || vid?.url || (typeof vid?.video === "string" ? vid.video : null);
      if (!videoUrl) throw new Error("The Space returned no video");
      return { status: "completed", videoUrl };
    },
  },

  zhipu: {
    label: "CogVideoX-Flash · free",
    keyName: "ZHIPU_API_KEY",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    promptLimit: 512,
    fields: [
      { name: "size", label: "Size", default: "1920x1080", options: [
        ["1920x1080", "▭ Landscape 16:9 HD"], ["1080x1920", "▯ Portrait 9:16 HD"], ["1280x960", "▭ 4:3"],
        ["960x1280", "▯ 3:4"], ["1024x1024", "◻ Square"], ["720x480", "Small (fastest)"], ["3840x2160", "4K"]] },
      { name: "quality", label: "Mode", default: "speed", options: [["speed", "⚡ Fast"], ["quality", "✨ Best quality"]] },
      { name: "fps", label: "FPS", default: "30", options: [["30", "30 fps"], ["60", "60 fps"]] },
      { name: "audio", label: "Sound", default: "true", options: [["true", "🔊 With sound"], ["false", "🔇 No sound"]] },
    ],
    portrait: (o) => { const [w, h] = o.size.split("x").map(Number); return h > w; },
    async start({ prompt, image, options: o }) {
      const body = { model: process.env.ZHIPU_MODEL || "cogvideox-flash", prompt, quality: o.quality, with_audio: o.audio === "true", size: o.size, fps: Number(o.fps) };
      if (image) body.image_url = image;
      const task = await zhipu("POST", "/videos/generations", body);
      if (!task.id) throw new Error("No task id returned");
      return { status: "processing", taskId: task.id };
    },
    async check(taskId) {
      const r = await zhipu("GET", `/async-result/${encodeURIComponent(taskId)}`);
      if (r.task_status === "SUCCESS") {
        const videoUrl = r.video_result?.[0]?.url;
        if (!videoUrl) throw new Error("Finished but no video URL was returned");
        return { status: "completed", videoUrl };
      }
      if (r.task_status === "FAIL") throw new Error(r.error?.message || "Generation failed — the prompt may have been blocked. Try rewording it.");
      return { status: "processing", taskId };
    },
  },
};

// ---------- HTTP ----------
const provider = PROVIDERS[PROVIDER_ID];
const json = (status, data) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const fail = (status, message) => json(status, { error: { message } });

function setupError() {
  if (!provider) return `Unknown VIDEO_PROVIDER "${PROVIDER_ID}" — use huggingface or zhipu.`;
  const key = process.env[provider.keyName];
  if (!key || key.startsWith("paste")) return `API key missing: in Vercel → Settings → Environment Variables add ${provider.keyName} (get it free at ${provider.keyUrl}), then redeploy.`;
  return null;
}

async function handle(request) {
  const url = new URL(request.url);
  const parts = (url.searchParams.get("route") ?? url.pathname.replace(/^\/api\/?/, "")).split("/").filter(Boolean);
  try {
    if (parts[0] === "config") {
      const { label = "Setup needed", fields = [], promptLimit = 0 } = provider || {};
      return json(200, { provider: PROVIDER_ID, label, fields, promptLimit, setupError: setupError() });
    }
    if (parts[0] !== "videos") return fail(404, "Not found");
    const setup = setupError();
    if (setup) return fail(400, setup);

    if (request.method === "GET" && parts.length === 2) {
      if (!provider.check) return fail(400, "Nothing to check for this provider.");
      return json(200, await provider.check(parts[1]));
    }

    if (request.method === "POST" && parts.length === 1) {
      let body;
      try { body = await request.json(); } catch { return fail(400, "Invalid request (the image may be too large — max ~4 MB)."); }
      const prompt = String(body.prompt || "").trim();
      if (!prompt && !body.image) return fail(400, "Please write a prompt.");
      if (prompt.length > provider.promptLimit) return fail(400, `Prompt is too long (max ${provider.promptLimit} characters).`);

      const options = {};
      for (const f of provider.fields) {
        const v = String(body.options?.[f.name] ?? f.default);
        if (!f.options.some(([val]) => val === v)) return fail(400, `Invalid ${f.label}.`);
        options[f.name] = v;
      }
      const image = body.image || null;
      if (image && !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) return fail(400, "Unsupported image (use PNG or JPG).");

      const result = await provider.start({ prompt, image, options });
      return json(200, { ...result, options, portrait: provider.portrait(options) });
    }

    return fail(404, "Not found");
  } catch (err) {
    console.error(err);
    return fail(500, err.message || "Server error");
  }
}

export const GET = handle;
export const POST = handle;
