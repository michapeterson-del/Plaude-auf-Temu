// Leitet ein Audio-Stück an OpenAI weiter und gibt nur den Text zurück.
// Das Audio wird dabei nicht gespeichert.
import { fail, json, requireAuth, requireEnv } from "../lib/server.js";

const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com";

export async function POST(request) {
  const denied = requireAuth(request) || requireEnv("OPENAI_API_KEY");
  if (denied) return denied;

  let form;
  try { form = await request.formData(); } catch { return fail("Ungültige Anfrage."); }
  const file = form.get("file");
  if (!file || typeof file === "string" || !file.size) return fail("Keine Audiodatei erhalten.");

  const out = new FormData();
  out.append("file", file, file.name || "aufnahme.webm");
  out.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe");
  out.append("response_format", "json");
  const language = String(form.get("language") || "").trim();
  if (/^[a-z]{2,3}$/i.test(language)) out.append("language", language.toLowerCase());
  const prompt = String(form.get("prompt") || "").slice(0, 2000);
  if (prompt) out.append("prompt", prompt);

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${OPENAI_BASE}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: out,
    });
    if (res.ok || (res.status < 500 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg).error?.message || msg; } catch { /* Text lassen */ }
    return fail(`OpenAI (${res.status}): ${msg}`, 502);
  }
  const data = await res.json();
  return json({ text: (data.text || "").trim() });
}
