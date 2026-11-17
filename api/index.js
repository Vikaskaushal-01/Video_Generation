// AI Video Studio API — one Vercel function behind the rewrite in vercel.json.
// API keys stay on the server (Vercel environment variables) and are never sent to the browser.
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { PROVIDERS } from "../lib/providers.js";
import * as store from "../lib/store.js";

const MAX_DURATION = Number(process.env.MAX_DURATION || 300); // keep in sync with vercel.json
const PROVIDER_ID = (process.env.VIDEO_PROVIDER || "zhipu").toLowerCase();
const provider = PROVIDERS[PROVIDER_ID];

function setupError() {
  if (!provider) return `Unknown VIDEO_PROVIDER "${PROVIDER_ID}". Use: ${Object.keys(PROVIDERS).join(", ")}`;
  const key = process.env[provider.keyName];
  if (!key || key.startsWith("paste")) return `API key missing: in Vercel → Project → Settings → Environment Variables, set ${provider.keyName} (get it at ${provider.keyUrl}), then redeploy.`;
  return store.STORAGE_ERROR;
}

const json = (status, data) => Response.json(data, { status });
const fail = (status, message) => json(status, { error: { message } });
const publicJob = ({ interactionId, taskId, videoUrl, downloadUrl, ...j }) => ({ ...j, canEdit: !!interactionId && j.provider === PROVIDER_ID });

async function finish(job, result) {
  const { video, ...extra } = result;
  Object.assign(job, await store.uploadVideo(job.id, video), extra, { status: "completed", finishedAt: Date.now() });
}

// Runs the whole generation inside this invocation (huggingface, gemini)
async function runJob(job, input) {
  try { await finish(job, await provider.generate(job, input)); }
  catch (err) { console.error(`Job ${job.id} failed:`, err); Object.assign(job, { status: "failed", error: err.message }); }
  await store.saveJob(job);
}

// Moves a processing job forward on each status poll (zhipu), or fails jobs whose function was cut off
async function advance(job) {
  if (job.status !== "processing" || job.provider !== PROVIDER_ID) return job;
  if (!job.taskId) {
    if (Date.now() - job.createdAt > (MAX_DURATION + 30) * 1000) {
      Object.assign(job, { status: "failed", error: "Generation took longer than the server time limit — try a shorter or smaller video." });
      await store.saveJob(job);
    }
    return job;
  }
  if (Date.now() - (job.checkedAt || 0) < 4000 || !(await store.lock(job.id))) return job;
  try {
    const result = await provider.check(job);
    if (result) await finish(job, result);
    else job.checkedAt = Date.now();
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);
    Object.assign(job, { status: "failed", error: err.message });
  }
  await store.saveJob(job);
  await store.unlock(job.id);
  return job;
}

function route(request) {
  const url = new URL(request.url);
  const r = url.searchParams.get("route") ?? url.pathname.replace(/^\/api\/?/, "");
  return { url, parts: ["api", ...r.split("/").filter(Boolean)] };
}

async function handle(request) {
  const { url, parts } = route(request);
  const method = request.method;
  try {
    const SETUP = setupError();

    // GET /api/config -> which options the UI should show
    if (parts[1] === "config") {
      if (!provider) return json(200, { provider: PROVIDER_ID, label: "Setup needed", fields: [], canEdit: false, promptLimit: 0, setupError: SETUP });
      const { label, fields, canEdit, promptLimit } = provider;
      return json(200, { provider: PROVIDER_ID, label, fields, canEdit, promptLimit, setupError: SETUP });
    }
    if (SETUP) return fail(method === "GET" ? 503 : 400, SETUP);
    if (parts[1] !== "videos") return fail(404, "Not found");

    // GET /api/videos -> history
    if (method === "GET" && parts.length === 2) {
      const jobs = await store.listJobs();
      return json(200, { data: jobs.map(publicJob) });
    }

    // POST /api/videos -> new video   |   POST /api/videos/:id/edit -> edit an existing one
    if (method === "POST" && (parts.length === 2 || parts[3] === "edit")) {
      let body;
      try { body = await request.json(); } catch { return fail(400, "Invalid request (the image may be too large — max ~4 MB)."); }
      const prompt = String(body.prompt || "").trim();
      if (!prompt && !body.image) return fail(400, "Please write a prompt.");
      if (prompt.length > provider.promptLimit) return fail(400, `Prompt is too long (max ${provider.promptLimit} characters).`);

      let parent = null;
      if (parts[3] === "edit") {
        parent = await store.getJob(parts[2]);
        if (!provider.canEdit || !parent?.interactionId) return fail(400, "This video can't be edited.");
      }

      const options = {};
      for (const f of provider.fields) {
        const v = String(parent ? parent.options[f.name] : body.options?.[f.name] ?? f.default);
        if (!f.options.some(([val]) => val === v)) return fail(400, `Invalid ${f.label}.`);
        options[f.name] = v;
      }
      if (parent && body.options?.seconds) options.seconds = String(body.options.seconds);

      let image = null;
      if (body.image && !parent) {
        if (!/^data:image\/(png|jpe?g|webp);base64,/.test(body.image)) return fail(400, "Unsupported image (use PNG or JPG).");
        image = body.image;
      }

      const job = {
        id: crypto.randomUUID().slice(0, 12),
        provider: PROVIDER_ID,
        prompt,
        options,
        portrait: provider.portrait(options),
        fromImage: !!image,
        editOf: parent?.id || null,
        status: "processing",
        createdAt: Date.now(),
      };
      const input = { prompt, image, previousInteractionId: parent?.interactionId };

      if (provider.start) {
        Object.assign(job, await provider.start(job, input)); // errors here go straight back to the user
        await store.addJob(job);
      } else {
        await store.addJob(job);
        waitUntil(runJob(job, input)); // keeps running after the response is sent (up to maxDuration)
      }
      return json(202, publicJob(job));
    }

    let job = await store.getJob(parts[2]);
    if (!job) return fail(404, "Video not found");

    if (method === "GET" && parts.length === 3) return json(200, publicJob(await advance(job)));

    if (method === "GET" && parts[3] === "content") {
      if (!job.videoUrl) return fail(404, "Video file missing");
      return Response.redirect(url.searchParams.has("download") ? job.downloadUrl : job.videoUrl, 302);
    }

    if (method === "DELETE" && parts.length === 3) {
      await store.deleteJob(job);
      return json(200, { deleted: true });
    }

    return fail(404, "Not found");
  } catch (err) {
    console.error(err);
    return fail(500, err.message || "Server error");
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
