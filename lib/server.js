// Gemeinsame Helfer für die Server-Funktionen (Vercel).
// Alle Schlüssel kommen ausschließlich aus Umgebungsvariablen und verlassen den Server nie.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "plaude_session";
const SESSION_DAYS = 30;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export const fail = (message, status = 400) => json({ error: message }, status);

function signingKey() {
  // Ändert sich das Passwort, werden alle bestehenden Anmeldungen ungültig.
  const secret = process.env.SESSION_SECRET || process.env.OPENAI_API_KEY || "";
  return createHash("sha256").update(`plaude|${process.env.APP_PASSWORD}|${secret}`).digest();
}

const sign = (value) => createHmac("sha256", signingKey()).update(value).digest("base64url");

function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function checkPassword(input) {
  const pw = process.env.APP_PASSWORD;
  return Boolean(pw) && safeEqual(input ?? "", pw);
}

export function sessionCookie() {
  const expires = Date.now() + SESSION_DAYS * 864e5;
  const value = `${expires}.${sign(String(expires))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function isAuthed(request) {
  if (!process.env.APP_PASSWORD) return false;
  const cookies = Object.fromEntries(
    (request.headers.get("cookie") || "").split(/;\s*/).filter(Boolean).map((c) => {
      const i = c.indexOf("=");
      return [c.slice(0, i), c.slice(i + 1)];
    }),
  );
  const raw = cookies[COOKIE];
  if (!raw) return false;
  const [expires, sig] = raw.split(".");
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  return safeEqual(sig, sign(expires));
}

/** Liefert eine 401-Antwort, wenn nicht angemeldet – sonst null. */
export function requireAuth(request) {
  if (!process.env.APP_PASSWORD) return fail("APP_PASSWORD ist auf dem Server nicht gesetzt.", 500);
  return isAuthed(request) ? null : fail("Nicht angemeldet.", 401);
}

export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  return missing.length ? fail(`Auf dem Server fehlt: ${missing.join(", ")}`, 500) : null;
}
