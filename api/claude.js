// Claude: Transkript nachbessern ("polish") oder Ordner zusammenfassen ("summary").
// Die Anweisungen liegen hier auf dem Server – die App schickt nur Text.
import Anthropic from "@anthropic-ai/sdk";
import { fail, json, requireAuth, requireEnv } from "../lib/server.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const POLISH_SYSTEM = `Du bekommst die automatische Transkription eines Abschnitts einer deutschen Sprachaufnahme.
Bessere sie behutsam nach:
- Offensichtliche Erkennungsfehler korrigieren (falsch verstandene Wörter, Namen, Fachbegriffe), wenn der Zusammenhang eindeutig ist.
- Rechtschreibung, Groß-/Kleinschreibung und Zeichensetzung korrigieren.
- Sinnvolle Absätze bilden. Erkennbare Sprecherwechsel als neuen Absatz setzen.
- Reine Füllwörter („äh“, „ähm“) und versehentliche Wortwiederholungen entfernen.
Wichtig: Inhalt, Reihenfolge und Wortwahl bleiben erhalten. Nichts zusammenfassen, nichts weglassen, nichts hinzuerfinden. Unklare Stellen unverändert lassen.
Der Abschnitt kann mitten im Satz beginnen oder enden – dann so lassen.
Gib ausschließlich den überarbeiteten Abschnitt zurück, ohne Einleitung oder Kommentar.`;

const SUMMARY_SYSTEM = `Du fasst Sprachaufnahmen (Gespräche, Notizen, Besprechungen) auf Deutsch zusammen.
Alle Aufnahmen gehören zu einem Ordner und werden gemeinsam als ein Vorgang ausgewertet.
- Kurzfassung: knapp und konkret.
- Stichpunkte: nach Themen gruppiert, kurze Stichpunkte statt ganzer Sätze; Zahlen, Mengen, Preise, Termine und Namen genau übernehmen.
- To-dos: jede Aufgabe, Besorgung oder Zusage, die aus den Aufnahmen hervorgeht (auch Einkaufslisten-Punkte einzeln). „wer“ und „bis“ nur füllen, wenn es gesagt wurde.
- Ordne jedes To-do genau einer Spalte des Aufgabenplaners zu:
  • "today" (Heute): konkrete, erledigbare berufliche/geschäftliche Aufgaben – anrufen, bestellen, Angebot schreiben, Material besorgen, Termin machen.
  • "process" (Prozesse & Optimierungen): übergeordnete Themen und Verbesserungen, die nicht in einem Schritt erledigt sind – Abläufe ändern, etwas einführen, optimieren, Strategie, „müssten wir mal grundsätzlich …“.
  • "private" (Privat): alles Persönliche außerhalb der Arbeit – Familie, Freunde, Haushalt, privater Einkauf, Gesundheit, Freizeit.
  Im Zweifel zwischen "today" und "process": konkrete Einzelaufgabe → "today".
- Entscheidungen und offene Fragen nur, wenn es welche gibt (sonst leere Liste).
Erfinde nichts, was nicht in den Aufnahmen vorkommt.`;

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kurzfassung", "stichpunkte", "todos", "entscheidungen", "offene_fragen"],
  properties: {
    kurzfassung: { type: "string", description: "2–5 Sätze: worum ging es, was ist das Ergebnis." },
    stichpunkte: {
      type: "array",
      description: "Die wichtigsten Inhalte, nach Themen gruppiert.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["thema", "punkte"],
        properties: { thema: { type: "string" }, punkte: { type: "array", items: { type: "string" } } },
      },
    },
    todos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aufgabe", "wer", "bis", "spalte"],
        properties: {
          aufgabe: { type: "string", description: "Konkrete Aufgabe, mit Verb formuliert." },
          wer: { type: "string", description: "Zuständige Person, leer wenn nicht genannt." },
          bis: { type: "string", description: "Frist/Zeitpunkt wie genannt, leer wenn nicht genannt." },
          spalte: { type: "string", enum: ["today", "process", "private"], description: "Spalte im Aufgabenplaner." },
        },
      },
    },
    entscheidungen: { type: "array", items: { type: "string" } },
    offene_fragen: { type: "array", items: { type: "string" } },
  },
};

const clip = (s, n) => String(s ?? "").slice(0, n);

async function ask({ system, user, effort, schema }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const output_config = { effort };
  if (schema) output_config.format = { type: "json_schema", schema };
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config,
    system,
    messages: [{ role: "user", content: user }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    throw new Error(`Claude hat die Anfrage abgelehnt${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : "."}`);
  }
  if (msg.stop_reason === "max_tokens") throw new Error("Antwort von Claude war zu lang und wurde abgeschnitten.");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

export async function POST(request) {
  const denied = requireAuth(request) || requireEnv("ANTHROPIC_API_KEY");
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return fail("Ungültige Anfrage."); }
  const folder = clip(body.folderName, 200);
  const vocab = clip(body.vocabulary, 1000).trim();

  try {
    if (body.kind === "polish") {
      const text = clip(body.text, 60000);
      if (!text.trim()) return json({ text: "" });
      const before = clip(body.previous, 1500);
      const user = [
        `Thema der Aufnahme: ${folder}`,
        vocab && `Bekannte Begriffe und Namen: ${vocab}`,
        before && `<davor nur_zum_kontext>\n${before}\n</davor>`,
        `<abschnitt>\n${text}\n</abschnitt>`,
      ].filter(Boolean).join("\n\n");
      return json({ text: await ask({ system: POLISH_SYSTEM, user, effort: "medium" }) });
    }

    if (body.kind === "summary") {
      const recs = Array.isArray(body.recordings) ? body.recordings.slice(0, 200) : [];
      if (!recs.length) return fail("Keine Transkripte übergeben.");
      const parts = recs.map((r, i) =>
        `<aufnahme nr="${i + 1}" zeit="${clip(r.time, 40)}" dauer="${clip(r.duration, 20)}">\n${clip(r.text, 400000)}\n</aufnahme>`);
      const text = await ask({
        system: SUMMARY_SYSTEM,
        user: `Ordner: ${folder}\n\n${parts.join("\n\n")}`,
        effort: "high",
        schema: SUMMARY_SCHEMA,
      });
      return json({ summary: JSON.parse(text) });
    }

    return fail("Unbekannte Aktion.");
  } catch (err) {
    console.error(err);
    const status = err?.status && err.status >= 400 ? 502 : 500;
    return fail(err?.message || "Fehler bei Claude.", status);
  }
}
