/* ============================================================
   Einstellungen
   ============================================================ */
const DEFAULTS = {
  openaiKey: "",
  anthropicKey: "",
  sttModel: "gpt-4o-transcribe",
  language: "de",
  vocabulary: "",
  claudeModel: "claude-opus-5-5",
  polish: true,
  autoSummary: true,
  todoApp: "shortcut",
  shortcutName: "Plaude To-do",
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("plaude.settings") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(s) {
  try { localStorage.setItem("plaude.settings", JSON.stringify(s)); } catch { /* privater Modus */ }
}
let settings = loadSettings();

/* ============================================================
   Speicher (IndexedDB): Ordner + Aufnahmen inkl. Audio
   ============================================================ */
const DB_NAME = "plaude";
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("folders", { keyPath: "id" });
      const rec = d.createObjectStore("recordings", { keyPath: "id" });
      rec.createIndex("folderId", "folderId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const store = {
  folders: () => tx("folders", "readonly", (s) => req2p(s.getAll())),
  folder: (id) => tx("folders", "readonly", (s) => req2p(s.get(id))),
  putFolder: (f) => tx("folders", "readwrite", (s) => req2p(s.put(f))),
  deleteFolder: async (id) => {
    const recs = await store.recordings(id);
    await tx("recordings", "readwrite", (s) => Promise.all(recs.map((r) => req2p(s.delete(r.id)))));
    await tx("folders", "readwrite", (s) => req2p(s.delete(id)));
  },
  recordings: (folderId) =>
    tx("recordings", "readonly", (s) => req2p(s.index("folderId").getAll(folderId)))
      .then((list) => list.sort((a, b) => a.createdAt - b.createdAt)),
  allRecordings: () => tx("recordings", "readonly", (s) => req2p(s.getAll())),
  recording: (id) => tx("recordings", "readonly", (s) => req2p(s.get(id))),
  putRecording: (r) => tx("recordings", "readwrite", (s) => req2p(s.put(r))),
  deleteRecording: (id) => tx("recordings", "readwrite", (s) => req2p(s.delete(id))),
};

/* Ändert einen Datensatz frisch aus der DB (vermeidet Überschreiben mit altem Stand). */
async function updateRecording(id, patch) {
  const r = await store.recording(id);
  if (!r) return null;
  Object.assign(r, typeof patch === "function" ? patch(r) : patch);
  await store.putRecording(r);
  return r;
}
async function updateFolder(id, patch) {
  const f = await store.folder(id);
  if (!f) return null;
  Object.assign(f, typeof patch === "function" ? patch(f) : patch);
  await store.putFolder(f);
  return f;
}

/* ============================================================
   Hilfsfunktionen
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtDuration = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const fmtDate = (ts) => {
  const d = new Date(ts), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Heute";
  if (d.toDateString() === y.toDateString()) return "Gestern";
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
};
const defaultFolderName = () => {
  const d = new Date();
  return `${d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" })} ${fmtTime(d)}`;
};

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function extFor(mime) {
  if (!mime) return "webm";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "webm";
}

/* ============================================================
   Aufnahme – wird alle 8 Minuten in eigenständige Teile
   geschnitten, die sofort gespeichert werden (kein Datenverlust,
   und jedes Stück passt sicher in die Transkriptions-API).
   ============================================================ */
const SEGMENT_MS = 8 * 60 * 1000;

function pickMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
  if (!window.MediaRecorder) return null;
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
}

class Recorder {
  constructor(recordingId, onSegment) {
    this.recordingId = recordingId;
    this.onSegment = onSegment;
    this.segmentIndex = 0;
    this.pending = [];
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    this.mime = pickMime();
    this.startedAt = Date.now();
    this._startSegment();
    this._setupMeter();
    try { this.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* nicht unterstützt */ }
  }

  _startSegment() {
    const opts = { audioBitsPerSecond: 64000 };
    if (this.mime) opts.mimeType = this.mime;
    const rec = new MediaRecorder(this.stream, opts);
    const chunks = [];
    const index = this.segmentIndex++;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve) => {
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: rec.mimeType || this.mime || "audio/webm" });
        if (blob.size > 0) await this.onSegment(index, blob);
        resolve();
      };
    });
    rec.start(1000);
    this.current = rec;
    this.pending.push(done);
    this.segmentTimer = setTimeout(() => this._rotate(), SEGMENT_MS);
  }

  _rotate() {
    const old = this.current;
    this._startSegment();
    old.stop();
  }

  _setupMeter() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.levelData = new Uint8Array(this.analyser.fftSize);
    } catch { /* Pegelanzeige optional */ }
  }

  level() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (const v of this.levelData) { const x = (v - 128) / 128; sum += x * x; }
    return Math.min(1, Math.sqrt(sum / this.levelData.length) * 4);
  }

  elapsed() { return (Date.now() - this.startedAt) / 1000; }

  async stop() {
    clearTimeout(this.segmentTimer);
    if (this.current?.state !== "inactive") this.current.stop();
    await Promise.all(this.pending);
    this.stream.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close();
    try { await this.wakeLock?.release(); } catch { /* egal */ }
  }
}

let activeRecorder = null; // { recorder, folderId, recordingId }

async function startRecording(folderId) {
  if (activeRecorder) return;
  if (!pickMime() && pickMime() !== "") {
    toast("Dieser Browser kann leider nicht aufnehmen.");
    return;
  }
  const rec = {
    id: uid(),
    folderId,
    createdAt: Date.now(),
    source: "aufnahme",
    status: "aufnahme",
    segments: [],
    duration: 0,
    transcript: "",
    rawTranscript: "",
  };
  await store.putRecording(rec);

  const recorder = new Recorder(rec.id, async (index, blob) => {
    await updateRecording(rec.id, (r) => {
      const segments = [...r.segments, { index, blob, mime: blob.type }].sort((a, b) => a.index - b.index);
      return { segments };
    });
  });
  try {
    await recorder.start();
  } catch (err) {
    await store.deleteRecording(rec.id);
    toast(err.name === "NotAllowedError" ? "Mikrofon-Zugriff wurde nicht erlaubt." : "Mikrofon konnte nicht gestartet werden.");
    return;
  }
  activeRecorder = { recorder, folderId, recordingId: rec.id };
  render();
}

async function stopRecording() {
  if (!activeRecorder) return;
  const { recorder, folderId, recordingId } = activeRecorder;
  const duration = recorder.elapsed();
  activeRecorder = null;
  await recorder.stop();
  const r = await updateRecording(recordingId, { status: "neu", duration });
  if (!r || !r.segments.length) {
    await store.deleteRecording(recordingId);
    toast("Die Aufnahme war leer.");
  } else {
    await updateFolder(folderId, { updatedAt: Date.now(), summaryStale: true });
    processRecording(recordingId);
  }
  render();
}

window.addEventListener("beforeunload", (e) => {
  if (activeRecorder) { e.preventDefault(); e.returnValue = ""; }
});

/* ============================================================
   Transkription (OpenAI)
   ============================================================ */
const MAX_UPLOAD = 25 * 1024 * 1024;

async function transcribeBlob(blob, { prompt, filename }) {
  if (!settings.openaiKey) throw new Error("Kein OpenAI-Schlüssel hinterlegt (Einstellungen).");
  if (blob.size > MAX_UPLOAD) throw new Error("Audio-Stück ist größer als 25 MB.");
  const fd = new FormData();
  fd.append("file", blob, filename);
  fd.append("model", settings.sttModel || DEFAULTS.sttModel);
  if (settings.language) fd.append("language", settings.language);
  if (prompt) fd.append("prompt", prompt);
  fd.append("response_format", "json");

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.openaiKey}` },
        body: fd,
      });
      if (res.ok) return ((await res.json()).text || "").trim();
      const body = await res.text();
      let msg = body;
      try { msg = JSON.parse(body).error?.message || body; } catch { /* Text lassen */ }
      lastErr = new Error(`OpenAI (${res.status}): ${msg}`);
      if (res.status < 500 && res.status !== 429) throw lastErr;
    } catch (err) {
      lastErr = err;
      if (String(err.message).startsWith("OpenAI (4") && !String(err.message).startsWith("OpenAI (429")) throw err;
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw lastErr;
}

function sttPrompt(folderName, previousText) {
  const parts = [];
  parts.push(`Aufnahme zum Thema „${folderName}“. Gesprochenes Deutsch, mit korrekter Rechtschreibung und Zeichensetzung.`);
  if (settings.vocabulary.trim()) parts.push(`Begriffe und Namen: ${settings.vocabulary.trim()}.`);
  // Ende des vorherigen Stücks für einen sauberen Übergang
  if (previousText) parts.push(previousText.slice(-600));
  return parts.join(" ");
}

/* ============================================================
   Claude: Nachbessern + Zusammenfassen
   ============================================================ */
// Offizielles Anthropic-SDK, lokal gebündelt (vendor/), erst bei Bedarf geladen
async function claudeClient() {
  if (!settings.anthropicKey) throw new Error("Kein Anthropic-Schlüssel hinterlegt (Einstellungen).");
  const { default: Anthropic } = await import("./vendor/anthropic-sdk.js");
  return new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true });
}

async function askClaude({ system, user, effort, schema }) {
  const client = await claudeClient();
  const outputConfig = { effort };
  if (schema) outputConfig.format = { type: "json_schema", schema };
  const stream = client.beta.messages.stream({
    model: settings.claudeModel || DEFAULTS.claudeModel,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: outputConfig,
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

const POLISH_SYSTEM = `Du bekommst die automatische Transkription einer deutschen Sprachaufnahme.
Bessere sie behutsam nach:
- Offensichtliche Erkennungsfehler korrigieren (falsch verstandene Wörter, Namen, Fachbegriffe), wenn der Zusammenhang eindeutig ist.
- Rechtschreibung, Groß-/Kleinschreibung und Zeichensetzung korrigieren.
- Sinnvolle Absätze bilden. Erkennbare Sprecherwechsel als neuen Absatz setzen.
- Reine Füllwörter („äh“, „ähm“) und versehentliche Wortwiederholungen entfernen.
Wichtig: Inhalt, Reihenfolge und Wortwahl bleiben erhalten. Nichts zusammenfassen, nichts weglassen, nichts hinzuerfinden. Unklare Stellen unverändert lassen.
Gib ausschließlich den überarbeiteten Text zurück, ohne Einleitung oder Kommentar.`;

async function polishTranscript(text, folderName) {
  const vocab = settings.vocabulary.trim() ? `\nBekannte Begriffe und Namen: ${settings.vocabulary.trim()}` : "";
  return askClaude({
    system: POLISH_SYSTEM,
    effort: "medium",
    user: `Thema der Aufnahme: ${folderName}${vocab}\n\n<transkript>\n${text}\n</transkript>`,
  });
}

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
        properties: {
          thema: { type: "string" },
          punkte: { type: "array", items: { type: "string" } },
        },
      },
    },
    todos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aufgabe", "wer", "bis"],
        properties: {
          aufgabe: { type: "string", description: "Konkrete Aufgabe, mit Verb formuliert." },
          wer: { type: "string", description: "Zuständige Person, leer wenn nicht genannt." },
          bis: { type: "string", description: "Frist/Zeitpunkt wie genannt, leer wenn nicht genannt." },
        },
      },
    },
    entscheidungen: { type: "array", items: { type: "string" } },
    offene_fragen: { type: "array", items: { type: "string" } },
  },
};

const SUMMARY_SYSTEM = `Du fasst Sprachaufnahmen (Gespräche, Notizen, Besprechungen) auf Deutsch zusammen.
Alle Aufnahmen gehören zu einem Ordner und werden gemeinsam als ein Vorgang ausgewertet.
- Kurzfassung: knapp und konkret.
- Stichpunkte: nach Themen gruppiert, kurze Stichpunkte statt ganzer Sätze; Zahlen, Mengen, Preise, Termine und Namen genau übernehmen.
- To-dos: jede Aufgabe, Besorgung oder Zusage, die aus den Aufnahmen hervorgeht (auch Einkaufslisten-Punkte einzeln). „wer“ und „bis“ nur füllen, wenn es gesagt wurde.
- Entscheidungen und offene Fragen nur, wenn es welche gibt (sonst leere Liste).
Erfinde nichts, was nicht in den Aufnahmen vorkommt.`;

async function summarizeFolder(folderId) {
  const folder = await store.folder(folderId);
  const recs = (await store.recordings(folderId)).filter((r) => r.status === "fertig" && r.transcript.trim());
  if (!recs.length) throw new Error("Noch keine fertigen Transkripte in diesem Ordner.");
  const body = recs
    .map((r, i) => `<aufnahme nr="${i + 1}" zeit="${new Date(r.createdAt).toLocaleString("de-DE")}" dauer="${fmtDuration(r.duration)}">\n${r.transcript}\n</aufnahme>`)
    .join("\n\n");
  const text = await askClaude({
    system: SUMMARY_SYSTEM,
    effort: "high",
    schema: SUMMARY_SCHEMA,
    user: `Ordner: ${folder.name}\n\n${body}`,
  });
  const summary = JSON.parse(text);
  await updateFolder(folderId, { summary, summaryAt: Date.now(), summaryStale: false, summaryError: null });
}

/* ============================================================
   Verarbeitungs-Warteschlange (eins nach dem anderen)
   ============================================================ */
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn).catch(() => {}));

function processRecording(id) {
  enqueue(async () => {
    let r = await store.recording(id);
    if (!r || r.status === "aufnahme") return;
    const folder = await store.folder(r.folderId);
    if (!folder) return;
    try {
      if (!r.rawTranscript) {
        await updateRecording(id, { status: "transkribiere", error: null, progress: "" });
        render();
        const texts = [];
        for (const [i, seg] of r.segments.entries()) {
          if (r.segments.length > 1) {
            await updateRecording(id, { progress: `Teil ${i + 1}/${r.segments.length}` });
            render();
          }
          const name = seg.name || `aufnahme-${i + 1}.${extFor(seg.mime || seg.blob.type)}`;
          texts.push(await transcribeBlob(seg.blob, { prompt: sttPrompt(folder.name, texts.at(-1)), filename: name }));
        }
        const raw = texts.join("\n\n").trim();
        r = await updateRecording(id, { rawTranscript: raw, transcript: raw, progress: "" });
      }
      if (settings.polish && settings.anthropicKey && !r.polished && r.rawTranscript) {
        await updateRecording(id, { status: "bessere" });
        render();
        const polished = await polishTranscript(r.rawTranscript, folder.name);
        r = await updateRecording(id, { transcript: polished || r.rawTranscript, polished: true });
      }
      await updateRecording(id, { status: "fertig", error: null });
      await updateFolder(r.folderId, { summaryStale: true, updatedAt: Date.now() });
      render();
      maybeAutoSummarize(r.folderId);
    } catch (err) {
      console.error(err);
      await updateRecording(id, { status: "fehler", error: err.message || String(err), progress: "" });
      render();
    }
  });
}

const summarizing = new Set();
function runSummary(folderId) {
  if (summarizing.has(folderId)) return;
  summarizing.add(folderId);
  render();
  enqueue(async () => {
    try {
      await summarizeFolder(folderId);
    } catch (err) {
      console.error(err);
      await updateFolder(folderId, { summaryError: err.message || String(err) });
    } finally {
      summarizing.delete(folderId);
      render();
    }
  });
}

async function maybeAutoSummarize(folderId) {
  if (!settings.autoSummary || !settings.anthropicKey) return;
  if (activeRecorder?.folderId === folderId) return;
  const recs = await store.recordings(folderId);
  const busy = recs.some((r) => ["neu", "transkribiere", "bessere", "aufnahme"].includes(r.status));
  if (!busy) runSummary(folderId);
}

/* ============================================================
   Dateien hochladen (z. B. Sprachmemos)
   ============================================================ */
async function importFiles(folderId, files) {
  for (const file of files) {
    if (file.size > MAX_UPLOAD) {
      toast(`„${file.name}“ ist größer als 25 MB – bitte kürzer aufnehmen oder teilen.`, 5000);
      continue;
    }
    const duration = await probeDuration(file);
    const rec = {
      id: uid(),
      folderId,
      createdAt: file.lastModified || Date.now(),
      source: "datei",
      fileName: file.name,
      status: "neu",
      segments: [{ index: 0, blob: file, mime: file.type, name: file.name }],
      duration,
      transcript: "",
      rawTranscript: "",
    };
    await store.putRecording(rec);
    processRecording(rec.id);
  }
  await updateFolder(folderId, { updatedAt: Date.now(), summaryStale: true });
  render();
}

function probeDuration(blob) {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    const url = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    a.src = url;
  });
}

/* ============================================================
   To-dos an die To-do-App schicken
   ============================================================ */
const todoLine = (t) => t.aufgabe + (t.bis ? ` (bis ${t.bis})` : "") + (t.wer ? ` – ${t.wer}` : "");

async function sendTodos(todos, folderName) {
  if (!todos.length) return false;
  const app = settings.todoApp || DEFAULTS.todoApp;
  const lines = todos.map(todoLine);
  const text = lines.join("\n");
  const enc = encodeURIComponent;
  let url;
  switch (app) {
    case "shortcut":
      url = `shortcuts://run-shortcut?name=${enc(settings.shortcutName || DEFAULTS.shortcutName)}&input=text&text=${enc(text)}`;
      break;
    case "things":
      url = todos.length === 1
        ? `things:///add?title=${enc(lines[0])}&notes=${enc(folderName)}`
        : `things:///add?titles=${enc(text)}&notes=${enc(folderName)}`;
      break;
    case "todoist":
      if (todos.length > 1) {
        // Todoist nimmt per Link nur eine Aufgabe – die übrigen nacheinander öffnen geht nicht, daher teilen
        return shareText(text, folderName);
      }
      url = `todoist://addtask?content=${enc(todos[0].aufgabe)}${todos[0].bis ? `&date=${enc(todos[0].bis)}` : ""}`;
      break;
    default:
      return shareText(text, folderName);
  }
  location.href = url;
  return true;
}

async function shareText(text, title) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return true; } catch { return false; }
  }
  try { await navigator.clipboard.writeText(text); toast("Kopiert – jetzt in der To-do-App einfügen."); return true; }
  catch { toast("Teilen nicht möglich."); return false; }
}

async function sendAndMark(folderId, keys) {
  const f = await store.folder(folderId);
  const all = [...(f.summary?.todos || []), ...(f.extraTodos || [])];
  const todos = all.filter((t) => keys.includes(todoKey(t)));
  const ok = await sendTodos(todos, f.name);
  if (ok) {
    await updateFolder(folderId, (x) => {
      const sent = { ...(x.todoSent || {}) };
      todos.forEach((t) => { sent[todoKey(t)] = Date.now(); });
      return { todoSent: sent };
    });
    render();
  }
}

/* ============================================================
   Export
   ============================================================ */
const todoKey = (t) => t.aufgabe.toLowerCase().replace(/\s+/g, " ").trim();

async function folderAsMarkdown(folderId) {
  const f = await store.folder(folderId);
  const recs = await store.recordings(folderId);
  const lines = [`# ${f.name}`, "", `${new Date(f.createdAt).toLocaleString("de-DE")} · ${recs.length} Aufnahme(n)`, ""];
  const s = f.summary;
  if (s) {
    lines.push("## Zusammenfassung", "", s.kurzfassung, "");
    if (s.stichpunkte.length) {
      lines.push("## Stichpunkte", "");
      for (const g of s.stichpunkte) {
        lines.push(`**${g.thema}**`);
        g.punkte.forEach((p) => lines.push(`- ${p}`));
        lines.push("");
      }
    }
    const done = f.todoDone || {};
    const todos = [...s.todos, ...(f.extraTodos || [])];
    if (todos.length) {
      lines.push("## To-dos", "");
      todos.forEach((t) => {
        const meta = [t.wer, t.bis].filter(Boolean).join(", ");
        lines.push(`- [${done[todoKey(t)] ? "x" : " "}] ${t.aufgabe}${meta ? ` (${meta})` : ""}`);
      });
      lines.push("");
    }
    if (s.entscheidungen.length) lines.push("## Entscheidungen", "", ...s.entscheidungen.map((x) => `- ${x}`), "");
    if (s.offene_fragen.length) lines.push("## Offene Fragen", "", ...s.offene_fragen.map((x) => `- ${x}`), "");
  }
  lines.push("## Transkripte", "");
  recs.forEach((r, i) => {
    lines.push(`### Aufnahme ${i + 1} – ${fmtTime(r.createdAt)} (${fmtDuration(r.duration)})`, "", r.transcript || "_(noch kein Text)_", "");
  });
  return lines.join("\n");
}

/* ============================================================
   Ansichten
   ============================================================ */
const view = $("#view");
let route = { name: "home" };
let renderToken = 0;
const openTranscripts = new Set();
const editing = new Set();

function parseRoute() {
  const m = location.hash.match(/^#\/ordner\/(.+)$/);
  route = m ? { name: "folder", id: decodeURIComponent(m[1]) } : { name: "home" };
}

async function render() {
  const token = ++renderToken;
  const html = route.name === "folder" ? await renderFolder(route.id) : await renderHome();
  if (token !== renderToken || html == null) return;
  // offene Eingaben nicht durch Hintergrund-Updates zerschießen
  const focused = document.activeElement;
  if (focused && view.contains(focused) && (focused.tagName === "TEXTAREA" || focused.tagName === "INPUT")) {
    pendingRender = true;
    return;
  }
  view.innerHTML = html;
  bindView();
}
let pendingRender = false;
document.addEventListener("focusout", () => {
  setTimeout(() => { if (pendingRender) { pendingRender = false; render(); } }, 0);
});

async function renderHome() {
  $("#title").textContent = "Plaude";
  $("#back").hidden = true;
  const [folders, recs] = await Promise.all([store.folders(), store.allRecordings()]);
  folders.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  const counts = {};
  const busy = {};
  for (const r of recs) {
    counts[r.folderId] = (counts[r.folderId] || 0) + 1;
    if (["transkribiere", "bessere", "neu", "aufnahme"].includes(r.status)) busy[r.folderId] = true;
  }

  const setupHint = !settings.openaiKey
    ? `<button class="notice" data-action="settings">Zuerst in den <b>Einstellungen</b> die API-Schlüssel eintragen.</button>`
    : "";

  let groups = "";
  let lastDay = null;
  for (const f of folders) {
    const day = fmtDate(f.createdAt);
    if (day !== lastDay) { groups += `<h2 class="day">${esc(day)}</h2>`; lastDay = day; }
    const todos = f.summary?.todos?.length || 0;
    const open = f.summary ? f.summary.todos.filter((t) => !(f.todoDone || {})[todoKey(t)]).length : 0;
    groups += `
      <a class="folder-card" href="#/ordner/${encodeURIComponent(f.id)}">
        <span class="folder-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>
        <span class="folder-main">
          <span class="folder-name">${esc(f.name)}</span>
          <span class="folder-meta">${counts[f.id] || 0} Aufnahme${counts[f.id] === 1 ? "" : "n"} · ${fmtTime(f.createdAt)}${todos ? ` · ${open}/${todos} To-dos offen` : ""}</span>
          ${f.summary ? `<span class="folder-preview">${esc(f.summary.kurzfassung)}</span>` : ""}
        </span>
        ${busy[f.id] ? `<span class="spinner" aria-label="wird verarbeitet"></span>` : ""}
      </a>`;
  }

  return `
    ${setupHint}
    <form class="new-folder" data-form="new-folder">
      <input name="name" placeholder="Neuer Ordner, z. B. „Einkauf Baumarkt“" autocomplete="off" enterkeyhint="go">
      <button class="btn" type="submit">Anlegen</button>
    </form>
    <button class="btn primary big" data-action="quick-record">
      <span class="rec-dot" aria-hidden="true"></span> Sofort aufnehmen
    </button>
    ${groups || `<p class="empty">Noch keine Ordner. Lege einen an oder starte direkt eine Aufnahme.</p>`}
  `;
}

const STATUS_TEXT = {
  aufnahme: "Nimmt auf …",
  neu: "Wartet …",
  transkribiere: "Transkribiere …",
  bessere: "Bessere Text nach …",
  fertig: "",
  fehler: "Fehler",
};

async function renderFolder(id) {
  const f = await store.folder(id);
  if (!f) { location.hash = "#/"; return null; }
  $("#title").textContent = f.name;
  $("#back").hidden = false;
  const recs = await store.recordings(id);
  const isRecHere = activeRecorder?.folderId === id;
  const otherRec = activeRecorder && !isRecHere;

  const recBlock = isRecHere
    ? `<div class="recorder live">
        <div class="meter"><span id="meter-bar"></span></div>
        <div class="rec-time" id="rec-time">${fmtDuration(activeRecorder.recorder.elapsed())}</div>
        <button class="btn stop big" data-action="stop"><span class="stop-sq" aria-hidden="true"></span> Aufnahme beenden</button>
        <p class="hint">Bildschirm anlassen – auf dem iPhone stoppt die Aufnahme sonst beim Sperren.</p>
      </div>`
    : `<div class="recorder">
        <button class="btn primary big" data-action="record" ${otherRec ? "disabled" : ""}>
          <span class="rec-dot" aria-hidden="true"></span> ${recs.length ? "Weitere Aufnahme" : "Aufnahme starten"}
        </button>
        <label class="btn ghost small upload">
          Audiodatei hinzufügen
          <input type="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.webm,.ogg" multiple data-action="upload" hidden>
        </label>
        ${otherRec ? `<p class="hint">In einem anderen Ordner läuft gerade eine Aufnahme.</p>` : ""}
      </div>`;

  // Zusammenfassung
  const s = f.summary;
  const isSumming = summarizing.has(id);
  const finished = recs.filter((r) => r.status === "fertig").length;
  let summaryHtml = "";
  if (s) {
    const done = f.todoDone || {};
    const sent = f.todoSent || {};
    const todos = [...s.todos, ...(f.extraTodos || [])];
    const openUnsent = todos.filter((t) => !done[todoKey(t)] && !sent[todoKey(t)]).length;
    summaryHtml = `
      <section class="card summary">
        <div class="card-head">
          <h2>Zusammenfassung</h2>
          ${f.summaryStale && finished ? `<span class="badge">neue Aufnahmen</span>` : ""}
        </div>
        <p class="lead">${esc(s.kurzfassung)}</p>

        <h3>To-dos</h3>
        <ul class="todos">
          ${todos.map((t) => {
            const k = todoKey(t);
            const meta = [t.wer, t.bis].filter(Boolean).join(" · ");
            return `<li><label class="${done[k] ? "done" : ""}">
              <input type="checkbox" data-todo="${esc(k)}" ${done[k] ? "checked" : ""}>
              <span>${esc(t.aufgabe)}${meta ? `<small>${esc(meta)}</small>` : ""}</span>
            </label>
            <button class="send ${sent[k] ? "sent" : ""}" data-action="send-todo" data-key="${esc(k)}" aria-label="An To-do-App senden" title="${sent[k] ? "Schon gesendet – nochmal senden" : "An To-do-App senden"}">
              ${sent[k]
                ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>`
                : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`}
            </button></li>`;
          }).join("") || `<li class="muted">Keine To-dos erkannt.</li>`}
        </ul>
        ${openUnsent ? `<button class="btn small" data-action="send-all">Alle ${openUnsent} offenen an To-do-App senden</button>` : ""}
        <form class="add-todo" data-form="add-todo">
          <input name="aufgabe" placeholder="To-do ergänzen" autocomplete="off" enterkeyhint="done">
          <button class="btn small" type="submit">+</button>
        </form>

        ${s.stichpunkte.length ? `<h3>Stichpunkte</h3>${s.stichpunkte.map((g) => `
          <div class="topic"><h4>${esc(g.thema)}</h4><ul>${g.punkte.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`).join("")}` : ""}

        ${s.entscheidungen.length ? `<h3>Entscheidungen</h3><ul>${s.entscheidungen.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${s.offene_fragen.length ? `<h3>Offene Fragen</h3><ul>${s.offene_fragen.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        <p class="hint">Erstellt ${fmtDate(f.summaryAt)} um ${fmtTime(f.summaryAt)}</p>
      </section>`;
  }

  const summaryActions = finished
    ? `<div class="row wrap">
        <button class="btn ${s && !f.summaryStale ? "ghost" : "primary"}" data-action="summarize" ${isSumming ? "disabled" : ""}>
          ${isSumming ? `<span class="spinner"></span> Fasse zusammen …` : s ? "Zusammenfassung neu erstellen" : "Zusammenfassen &amp; To-dos"}
        </button>
        <button class="btn ghost" data-action="copy">Kopieren</button>
        ${navigator.share ? `<button class="btn ghost" data-action="share">Teilen</button>` : ""}
        <button class="btn ghost" data-action="download">Als Datei</button>
      </div>
      ${f.summaryError ? `<p class="error">${esc(f.summaryError)}</p>` : ""}`
    : "";

  const recList = recs.map((r, i) => {
    const statusText = STATUS_TEXT[r.status] + (r.progress ? ` ${r.progress}` : "");
    const working = ["transkribiere", "bessere", "neu"].includes(r.status);
    const isOpen = openTranscripts.has(r.id);
    const isEditing = editing.has(r.id);
    return `
      <article class="rec" data-rec="${esc(r.id)}">
        <header class="rec-head">
          <div>
            <strong>Aufnahme ${i + 1}</strong>
            <span class="muted">${fmtTime(r.createdAt)} · ${fmtDuration(r.duration)}${r.fileName ? ` · ${esc(r.fileName)}` : ""}</span>
          </div>
          ${working || r.status === "aufnahme" ? `<span class="status"><span class="spinner"></span>${esc(statusText)}</span>` : ""}
          ${r.status === "fehler" ? `<span class="status err">Fehler</span>` : ""}
        </header>
        ${r.status === "fehler" ? `<p class="error">${esc(r.error)}</p><button class="btn small" data-action="retry">Erneut versuchen</button>` : ""}
        ${r.segments.length ? `<div class="players">${r.segments.map((_, si) => `<audio controls preload="none" data-seg="${si}"></audio>`).join("")}</div>` : ""}
        ${r.transcript ? `
          <details class="transcript" ${isOpen || isEditing ? "open" : ""}>
            <summary>Transkript</summary>
            ${isEditing
              ? `<textarea class="edit" rows="10">${esc(r.transcript)}</textarea>
                 <div class="row"><button class="btn small primary" data-action="save-edit">Speichern</button><button class="btn small ghost" data-action="cancel-edit">Abbrechen</button></div>`
              : `<div class="text">${esc(r.transcript).replace(/\n/g, "<br>")}</div>
                 <div class="row"><button class="btn small ghost" data-action="edit">Bearbeiten</button>${r.rawTranscript && r.polished ? `<button class="btn small ghost" data-action="show-raw">Original-Erkennung</button>` : ""}</div>`}
          </details>` : ""}
        <div class="row end"><button class="link danger" data-action="delete-rec">Aufnahme löschen</button></div>
      </article>`;
  }).join("");

  return `
    ${recBlock}
    ${summaryHtml}
    ${summaryActions}
    <section class="recs">
      <h2 class="section-title">Aufnahmen</h2>
      ${recList || `<p class="empty">Noch keine Aufnahmen in diesem Ordner.</p>`}
    </section>
    <div class="row between folder-actions">
      <button class="link" data-action="rename">Ordner umbenennen</button>
      <button class="link danger" data-action="delete-folder">Ordner löschen</button>
    </div>
  `;
}

/* Audio-Player erst bei Bedarf befüllen */
const objectUrls = [];
async function attachPlayers() {
  objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  for (const el of view.querySelectorAll(".rec")) {
    const audios = el.querySelectorAll("audio[data-seg]");
    if (!audios.length) continue;
    const r = await store.recording(el.dataset.rec);
    audios.forEach((a) => {
      const seg = r?.segments[Number(a.dataset.seg)];
      if (!seg) return;
      const url = URL.createObjectURL(seg.blob);
      objectUrls.push(url);
      a.src = url;
      // Teile nacheinander abspielen
      a.addEventListener("ended", () => audios[Number(a.dataset.seg) + 1]?.play());
    });
  }
}

function bindView() {
  if (route.name === "folder") attachPlayers();
  view.querySelectorAll("details.transcript").forEach((d) => {
    d.addEventListener("toggle", () => {
      const id = d.closest(".rec").dataset.rec;
      d.open ? openTranscripts.add(id) : openTranscripts.delete(id);
    });
  });
}

/* Live-Anzeige der Aufnahmezeit + Pegel */
function tick() {
  if (activeRecorder) {
    const t = $("#rec-time");
    if (t) t.textContent = fmtDuration(activeRecorder.recorder.elapsed());
    const bar = $("#meter-bar");
    if (bar) bar.style.transform = `scaleX(${0.04 + activeRecorder.recorder.level() * 0.96})`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ============================================================
   Ereignisse
   ============================================================ */
async function createFolder(name) {
  const f = { id: uid(), name: name.trim() || defaultFolderName(), createdAt: Date.now(), updatedAt: Date.now() };
  await store.putFolder(f);
  return f;
}

view.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === "new-folder") {
    const f = await createFolder(form.name.value);
    location.hash = `#/ordner/${encodeURIComponent(f.id)}`;
  } else if (form.dataset.form === "add-todo") {
    const aufgabe = form.aufgabe.value.trim();
    if (!aufgabe) return;
    form.aufgabe.blur();
    await updateFolder(route.id, (f) => ({ extraTodos: [...(f.extraTodos || []), { aufgabe, wer: "", bis: "" }] }));
    render();
  }
});

view.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.matches("[data-todo]")) {
    await updateFolder(route.id, (f) => ({ todoDone: { ...(f.todoDone || {}), [el.dataset.todo]: el.checked } }));
    el.closest("label").classList.toggle("done", el.checked);
  } else if (el.matches('[data-action="upload"]')) {
    const files = [...el.files];
    el.value = "";
    if (files.length) importFiles(route.id, files);
  }
});

view.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.dataset.action === "upload") return;
  const action = btn.dataset.action;
  const recEl = btn.closest(".rec");
  const recId = recEl?.dataset.rec;

  switch (action) {
    case "settings": openSettings(); break;
    case "quick-record": {
      const f = await createFolder("");
      location.hash = `#/ordner/${encodeURIComponent(f.id)}`;
      await startRecording(f.id);
      break;
    }
    case "record": await startRecording(route.id); break;
    case "stop": btn.disabled = true; await stopRecording(); break;
    case "retry": {
      await updateRecording(recId, { status: "neu", error: null });
      processRecording(recId);
      render();
      break;
    }
    case "summarize": runSummary(route.id); break;
    case "send-todo": await sendAndMark(route.id, [btn.dataset.key]); break;
    case "send-all": {
      const f = await store.folder(route.id);
      const done = f.todoDone || {}, sent = f.todoSent || {};
      const keys = [...(f.summary?.todos || []), ...(f.extraTodos || [])].map(todoKey).filter((k) => !done[k] && !sent[k]);
      await sendAndMark(route.id, keys);
      break;
    }
    case "copy": {
      const md = await folderAsMarkdown(route.id);
      try { await navigator.clipboard.writeText(md); toast("In die Zwischenablage kopiert."); }
      catch { toast("Kopieren nicht möglich."); }
      break;
    }
    case "share": {
      const md = await folderAsMarkdown(route.id);
      const f = await store.folder(route.id);
      try { await navigator.share({ title: f.name, text: md }); } catch { /* abgebrochen */ }
      break;
    }
    case "download": {
      const md = await folderAsMarkdown(route.id);
      const f = await store.folder(route.id);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
      a.download = `${f.name.replace(/[\\/:*?"<>|]+/g, "-")}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      break;
    }
    case "edit": editing.add(recId); render(); break;
    case "cancel-edit": editing.delete(recId); render(); break;
    case "save-edit": {
      const text = recEl.querySelector("textarea.edit").value;
      editing.delete(recId);
      await updateRecording(recId, { transcript: text });
      await updateFolder(route.id, { summaryStale: true });
      document.activeElement?.blur();
      render();
      break;
    }
    case "show-raw": {
      const r = await store.recording(recId);
      const box = recEl.querySelector(".text");
      const showingRaw = box.dataset.raw === "1";
      box.innerHTML = esc(showingRaw ? r.transcript : r.rawTranscript).replace(/\n/g, "<br>");
      box.dataset.raw = showingRaw ? "0" : "1";
      btn.textContent = showingRaw ? "Original-Erkennung" : "Nachgebesserte Fassung";
      break;
    }
    case "delete-rec": {
      if (!confirm("Diese Aufnahme samt Transkript löschen?")) return;
      await store.deleteRecording(recId);
      await updateFolder(route.id, { summaryStale: true });
      render();
      break;
    }
    case "rename": {
      const f = await store.folder(route.id);
      const name = prompt("Neuer Name für den Ordner:", f.name);
      if (name && name.trim()) { await updateFolder(route.id, { name: name.trim() }); render(); }
      break;
    }
    case "delete-folder": {
      if (!confirm("Ordner mit allen Aufnahmen und Texten löschen?")) return;
      await store.deleteFolder(route.id);
      location.hash = "#/";
      break;
    }
  }
});

$("#back").addEventListener("click", () => { location.hash = "#/"; });
window.addEventListener("hashchange", () => { parseRoute(); editing.clear(); render(); });

/* Einstellungen */
const dlg = $("#settings");
const form = $("#settings-form");
function openSettings() {
  for (const [k, v] of Object.entries(settings)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v; else el.value = v;
  }
  updateTodoAppHint();
  dlg.showModal();
}
$("#open-settings").addEventListener("click", openSettings);
function updateTodoAppHint() {
  const v = form.elements.todoApp.value;
  form.querySelector(".shortcut-only").hidden = v !== "shortcut";
}
form.elements.todoApp.addEventListener("change", updateTodoAppHint);
form.addEventListener("submit", () => {
  const next = { ...settings };
  for (const k of Object.keys(DEFAULTS)) {
    const el = form.elements[k];
    if (!el) continue;
    next[k] = el.type === "checkbox" ? el.checked : el.value.trim();
  }
  next.sttModel ||= DEFAULTS.sttModel;
  next.claudeModel ||= DEFAULTS.claudeModel;
  settings = next;
  saveSettings(settings);
  toast("Gespeichert.");
  render();
  resumePending();
});
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

/* Nach Neuladen: unterbrochene Aufnahmen/Verarbeitungen wieder aufnehmen */
async function resumePending() {
  const recs = await store.allRecordings();
  for (const r of recs) {
    if (r.status === "aufnahme") {
      if (r.segments.length) await updateRecording(r.id, { status: "neu", duration: r.duration || r.segments.length * SEGMENT_MS / 1000 });
      else { await store.deleteRecording(r.id); continue; }
    }
    if (["neu", "transkribiere", "bessere"].includes(r.status) && settings.openaiKey) processRecording(r.id);
  }
}

/* Speicher dauerhaft anfordern, damit der Browser nichts wegräumt */
navigator.storage?.persist?.().catch(() => {});

parseRoute();
resumePending().then(render);
if (!settings.openaiKey) setTimeout(openSettings, 300);
