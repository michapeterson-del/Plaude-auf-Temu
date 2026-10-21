// Legt To-dos direkt im Aufgabenplaner an (Tabelle "tasks", PostgREST unter <TODO_API_URL>/rest/v1/).
import { fail, json, requireAuth, todoConfig } from "../lib/server.js";

const CATEGORIES = ["today", "process", "private"];

export async function POST(request) {
  const denied = requireAuth(request);
  if (denied) return denied;
  const todo = todoConfig();
  if (!todo) return fail("Auf dem Server fehlt: TODO_API_URL, TODO_API_KEY", 500);

  let body;
  try { body = await request.json(); } catch { return fail("Ungültige Anfrage."); }
  const category = CATEGORIES.includes(body.category) ? body.category : "today";
  const tasks = (Array.isArray(body.tasks) ? body.tasks : [])
    .slice(0, 100)
    .map((t) => ({
      title: String(t.title || "").trim().slice(0, 500),
      description: String(t.description || "").slice(0, 4000),
      category: CATEGORIES.includes(t.category) ? t.category : category,
      status: "open",
      source: "manual",
      steps: [],
    }))
    .filter((t) => t.title);
  if (!tasks.length) return fail("Keine Aufgaben übergeben.");

  const key = todo.key;
  const res = await fetch(`${todo.url}/rest/v1/tasks`, {
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
