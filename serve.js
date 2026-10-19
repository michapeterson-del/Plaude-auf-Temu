// Eigenständiger Server für den Betrieb außerhalb von Vercel (z. B. Coolify/Docker).
// Liefert die statischen Dateien aus und leitet /api/<name> an die Handler in api/<name>.js
// weiter – dieselben Funktionen, die Vercel als Serverless Functions ausführt.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Nur diese Dateien werden ausgeliefert – Server-Code, iOS-Projekt usw. bleiben privat.
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/icon-180.png": ["icon-180.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
};
const API = new Set(["claude", "session", "todo", "transcribe"]);

// Entspricht den Headern aus vercel.json
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

async function handleApi(name, req, res) {
  const mod = await import(`./api/${name}.js`);
  const handler = mod[req.method];
  if (typeof handler !== "function") {
    return send(res, 405, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify({ error: "Methode nicht erlaubt." }));
  }

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  });

  const response = await handler(request);
  const headers = { "Cache-Control": "no-store" };
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["Set-Cookie"] = cookies;

  res.writeHead(response.status, { ...SECURITY_HEADERS, ...headers });
  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    const api = pathname.match(/^\/api\/([a-z]+)\/?$/);
    if (api && API.has(api[1])) return await handleApi(api[1], req, res);

    const file = STATIC[pathname];
    if (file && (req.method === "GET" || req.method === "HEAD")) {
      const data = await readFile(path.join(ROOT, file[0]));
      return send(res, 200, { "Content-Type": file[1] }, req.method === "HEAD" ? undefined : data);
    }
    send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Nicht gefunden.");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify({ error: "Interner Serverfehler." }));
    else res.end();
  }
}).listen(PORT, () => console.log(`Plaude läuft auf Port ${PORT}`));
