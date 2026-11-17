// AI Video Studio on Vercel — forwards every /api request to the server running on your PC
// (server.js, which saves videos in the local "videos" folder) through an ngrok tunnel.
// Set BACKEND_URL below (or as a Vercel environment variable) to your ngrok domain.
const BACKEND_URL = process.env.BACKEND_URL || "https://YOUR-DOMAIN.ngrok-free.app";

const OFFLINE = "The video server on the host PC is offline. Start it with \"npm run start:public\" and try again.";

async function handle(request) {
  const incoming = new URL(request.url);
  const route = incoming.searchParams.get("route") ?? incoming.pathname.replace(/^\/api\/?/, "");
  incoming.searchParams.delete("route");
  const target = new URL(`/api/${route}${incoming.search}`, BACKEND_URL);

  const headers = { "ngrok-skip-browser-warning": "1" };
  for (const h of ["content-type", "range"]) if (request.headers.get(h)) headers[h] = request.headers.get(h);

  let r;
  try {
    r = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    });
  } catch {
    return Response.json({ error: { message: OFFLINE } }, { status: 502 });
  }
  // ngrok answers with its own error page when the PC/tunnel is down
  if (r.headers.get("ngrok-error-code") || (r.status >= 500 && !r.headers.get("content-type")?.includes("json") && !r.headers.get("content-type")?.includes("video"))) {
    return Response.json({ error: { message: OFFLINE } }, { status: 502 });
  }

  const out = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"]) {
    if (r.headers.get(h)) out.set(h, r.headers.get(h));
  }
  out.set("cache-control", "no-store");
  return new Response(r.body, { status: r.status, headers: out });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
