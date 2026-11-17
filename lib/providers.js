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

