// Starts the local video server (saves to ./videos) and the ngrok tunnel that the Vercel site forwards to.
// Usage: npm run start:public      (needs NGROK_DOMAIN in .env and ngrok installed + logged in)
import { spawn } from "node:child_process";

const domain = process.env.NGROK_DOMAIN;
const port = process.env.PORT || 3000;
if (!domain) {
  console.error('\n  ⚠ Set NGROK_DOMAIN=your-name.ngrok-free.app in .env (free domain: https://dashboard.ngrok.com/domains)\n');
  process.exit(1);
}

const procs = [
  spawn(process.execPath, ["--env-file=.env", "server.js"], { stdio: "inherit" }),
  spawn("ngrok", ["http", `--url=${domain}`, String(port), "--log=stdout", "--log-level=warn"], { stdio: "inherit", shell: true }),
];
console.log(`\n  Tunnel: https://${domain}  →  http://localhost:${port}\n  Keep this window open while people use the site. Ctrl+C to stop.\n`);

const stop = () => { procs.forEach((p) => p.kill()); process.exit(); };
procs.forEach((p) => p.on("exit", (code) => { if (code) console.error(`A process exited (code ${code}) — stopping.`); stop(); }));
process.on("SIGINT", stop);
