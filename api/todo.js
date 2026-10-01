// Legt To-dos direkt im Aufgabenplaner an (Supabase-Tabelle "tasks").
import { fail, json, requireAuth, requireEnv } from "../lib/server.js";

const CATEGORIES = ["today", "process", "private"];

export async function POST(request) {
  const denied = requireAuth(request) || requireEnv("SUPABASE_URL", "SUPABASE_ANON_KEY");
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return fail("Ungültige Anfrage."); }
  const category = CATEGORIES.includes(body.category) ? body.category : "today";
  const tasks = (Array.isArray(body.tasks) ? body.tasks : [])
    .slice(0, 100)
    .map((t) => ({
      title: String(t.title || "").trim().slice(0, 500),
      description: String(t.description || "").slice(0, 4000),
      category,
      status: "open",
      source: "manual",
      steps: [],
    }))
    .filter((t) => t.title);
  if (!tasks.length) return fail("Keine Aufgaben übergeben.");

  const key = process.env.SUPABASE_ANON_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/tasks`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(tasks),
  });
  if (!res.ok) return fail(`Aufgabenplaner (${res.status}): ${(await res.text()).slice(0, 300)}`, 502);
  return json({ ok: true, count: tasks.length });
}
