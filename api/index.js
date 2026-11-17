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

