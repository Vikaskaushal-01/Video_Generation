// Video providers.
//   huggingface / gemini -> generate(job, input) runs to completion inside one function call (waitUntil)
//   zhipu                -> start(job, input) submits a task; check(job) is called on each status poll
// Every provider returns the finished video as a Buffer; the API stores it in Vercel Blob.
import https from "node:https";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP helpers ----------
export function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method,
      headers: { ...headers, ...(data && { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }) },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(request("GET", new URL(res.headers.location, url).toString(), { headers }));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error("The AI service took too long to respond")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const ZHIPU_ERRORS = {
  1000: "Invalid API key — check ZHIPU_API_KEY", 1001: "API key missing", 1002: "Invalid API key — check ZHIPU_API_KEY",
  1003: "API key expired", 1004: "API key not valid", 1113: "Account has no balance for this model (make sure the model is cogvideox-flash, the free one)",
  1211: "Model not found", 1261: "Prompt too long", 1301: "Blocked by safety filter — please reword your prompt",
  1302: "Too many requests at once — wait a minute and try again", 1303: "Too many requests — wait and try again",
  1305: "Free daily limit reached — try again tomorrow",
};

async function requestJson(method, url, opts) {
  const r = await request(method, url, opts);
  let json;
  try { json = JSON.parse(r.buffer.toString()); } catch { json = {}; }
  if (Array.isArray(json)) json = json[0] || {};
  if (r.status >= 400) {
    const code = Number(json.error?.code);
    const raw = json.error?.message || json.msg || json.message || `API error ${r.status}`;
    const msg = ZHIPU_ERRORS[code] ? `${ZHIPU_ERRORS[code]} (code ${code})` : raw;
    throw new Error(r.status === 429 ? `${msg} (rate/daily limit reached — try again later)` : msg);
  }
  return json;
}

async function download(url, headers) {
  const r = await request("GET", url, { headers });
  if (r.status >= 400) throw new Error(`Video download failed (${r.status})`);
  return r.buffer;
}

// Calls a public Gradio app (Hugging Face Space) with your HF token so the free daily GPU quota is yours.
async function gradio(host, api, data) {
  const auth = { Authorization: `Bearer ${process.env.HF_TOKEN}` };
  const r = await fetch(`${host}/gradio_api/call/${api}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
  const start = await r.json().catch(() => ({}));
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

// ---------- Providers ----------
export const PROVIDERS = {
  huggingface: {
    label: "Wan 2.2 on Hugging Face · free",
    keyName: "HF_TOKEN",
    keyUrl: "https://huggingface.co/settings/tokens",
    canEdit: false,
    promptLimit: 1000,
    fields: [
      { name: "shape", label: "Shape", default: "landscape", options: [["landscape", "▭ Landscape 16:9"], ["portrait", "▯ Portrait 9:16"], ["square", "◻ Square"]] },
      { name: "seconds", label: "Length", default: "4", options: [["2", "2 sec"], ["3", "3 sec"], ["4", "4 sec"], ["5", "5 sec"]] },
    ],
    portrait: (o) => o.shape === "portrait",
    async generate(job, { prompt, image }) {
      const SIZES = { landscape: [832, 480], portrait: [480, 832], square: [640, 640] };
      const [w, h] = SIZES[job.options.shape];
      const auth = { Authorization: `Bearer ${process.env.HF_TOKEN}` };
      const imageHost = process.env.HF_IMAGE_SPACE || "https://black-forest-labs-flux-1-schnell.hf.space";
      const videoHost = process.env.HF_VIDEO_SPACE || "https://prithivmlmods-wan2-2-fast.hf.space";
      // 1) No image uploaded? Draw the first frame from the prompt with FLUX (free)
      if (!image) {
        const [img] = await gradio(imageHost, "infer", [prompt, 0, true, w, h, 4]);
        const r = await fetch(img.url, { headers: auth });
        if (!r.ok) throw new Error("Could not download the first frame image");
        image = `data:${r.headers.get("content-type") || "image/webp"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
      }
      // 2) Animate it with Wan 2.2
      const [vid] = await gradio(videoHost, "generate_video",
        [image, prompt || "cinematic motion, smooth animation", 4, "blurry, low quality, deformed, watermark, static", Number(job.options.seconds), 1, 1, 42, true]);
      if (typeof vid?.video === "string" && vid.video.startsWith("data:")) return { video: Buffer.from(vid.video.split(",")[1], "base64") };
      if (vid?.url || vid?.video?.url) return { video: await download(vid.url || vid.video.url, auth) };
      throw new Error("The Space returned no video");
    },
  },

};
