// AI Video Studio — zero-dependency server for AI video generation.
// Providers:  zhipu  -> CogVideoX-Flash (FREE)   |   gemini -> Google Gemini Omni Flash (paid)
// Your API keys stay here on the server and are never sent to the browser.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const VIDEO_DIR = path.join(__dirname, "videos");
const DB_FILE = path.join(VIDEO_DIR, "jobs.json");
fs.mkdirSync(VIDEO_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP helper (https.request: no 5-minute timeout like fetch) ----------
function request(method, url, { headers = {}, body } = {}) {
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
    req.setTimeout(25 * 60 * 1000, () => req.destroy(new Error("The AI service took too long to respond")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function requestJson(method, url, opts) {
  const r = await request(method, url, opts);
  let json;
  try { json = JSON.parse(r.buffer.toString()); } catch { json = {}; }
  if (Array.isArray(json)) json = json[0] || {};
  if (r.status >= 400) {
    // Zhipu returns Chinese messages with numeric codes — translate the common ones
    const ZHIPU = {
      1000: "Invalid API key — check ZHIPU_API_KEY in .env", 1001: "API key missing", 1002: "Invalid API key — check ZHIPU_API_KEY in .env",
      1003: "API key expired", 1004: "API key not valid", 1113: "Account has no balance for this model (make sure the model is cogvideox-flash, the free one)",
      1211: "Model not found", 1261: "Prompt too long", 1301: "Blocked by safety filter — please reword your prompt",
      1302: "Too many requests at once — wait a minute and try again", 1303: "Too many requests — wait and try again",
      1305: "Free daily limit reached — try again tomorrow",
    };
    const code = Number(json.error?.code);
    const raw = json.error?.message || json.msg || json.message || `API error ${r.status}`;
    const msg = ZHIPU[code] ? `${ZHIPU[code]} (code ${code})` : raw;
    throw new Error(r.status === 429 ? `${msg} (rate/daily limit reached — try again later)` : msg);
  }
  return json;
}

async function downloadTo(url, dest, headers) {
  const r = await request("GET", url, { headers });
  if (r.status >= 400) throw new Error(`Video download failed (${r.status})`);
  fs.writeFileSync(dest, r.buffer);
}

