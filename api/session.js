// GET: Anmeldestatus · POST: anmelden · DELETE: abmelden
import { checkPassword, clearCookie, fail, isAuthed, json, sessionCookie } from "../lib/server.js";

const features = () => ({ aufgabenplaner: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) });

export async function GET(request) {
  if (!process.env.APP_PASSWORD) return fail("APP_PASSWORD ist auf dem Server nicht gesetzt.", 500);
  return isAuthed(request) ? json({ ok: true, features: features() }) : fail("Nicht angemeldet.", 401);
}

export async function POST(request) {
  if (!process.env.APP_PASSWORD) return fail("APP_PASSWORD ist auf dem Server nicht gesetzt.", 500);
  let body = {};
  try { body = await request.json(); } catch { /* leer */ }
  if (!checkPassword(body.password)) {
    // Bremst Durchprobieren von Passwörtern aus
    await new Promise((r) => setTimeout(r, 1500));
    return fail("Falsches Passwort.", 401);
  }
  return json({ ok: true, features: features() }, 200, { "Set-Cookie": sessionCookie() });
}

export async function DELETE() {
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}
