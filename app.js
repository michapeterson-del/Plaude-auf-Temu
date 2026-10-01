/* ============================================================
   Einstellungen
   ============================================================ */
const DEFAULTS = {
  language: "de",
  vocabulary: "",
  polish: true,
  autoSummary: true,
  todoApp: "aufgabenplaner",
  todoCategory: "auto",
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
   Aufnahme – wird alle 4 Minuten in eigenständige Teile
   geschnitten, die sofort gespeichert werden (kein Datenverlust,
   und jedes Stück passt sicher in die Transkriptions-API).
   ============================================================ */
const SEGMENT_MS = 4 * 60 * 1000; // ~2 MB pro Stück – passt sicher durch den Server

function pickMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
  if (!window.MediaRecorder) return null;
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
}

const MIC_CONSTRAINTS = {
  audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
};

class Recorder {
  constructor(recordingId, onSegment) {
    this.recordingId = recordingId;
    this.onSegment = onSegment;
    this.segmentIndex = 0;
    this.pending = [];
    this.interruptions = 0;
    this.stopped = false;
  }

  async start() {
    this.mime = pickMime();
    this.startedAt = Date.now();
    await this._openMic();
    this._startSegment();
    this._onVisibility = () => {
      if (document.visibilityState === "visible") this.recover();
      // Beim Verlassen: bisheriges Stück sofort speichern, neues beginnen (falls iOS uns weiter lässt)
      else this._rotate();
    };
    document.addEventListener("visibilitychange", this._onVisibility);
    window.addEventListener("pageshow", this._onVisibility);
    window.addEventListener("pagehide", this._flushBound = () => this._flush());
  }

  async _openMic() {
    this.stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const track = this.stream.getAudioTracks()[0];
    // iOS beendet das Mikrofon, wenn man die App verlässt: dann das bisherige Stück sichern
    track.addEventListener("ended", () => this._flush());
    this._setupMeter();
    this._lockScreen();
  }

  async _lockScreen() {
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
    // Falls der Browser die Aufnahme von sich aus beendet (Mikrofon weg), trotzdem speichern
    rec.onerror = () => { try { rec.stop(); } catch { /* schon gestoppt */ } };
    rec.start(1000);
    this.current = rec;
    this.pending.push(done);
    clearTimeout(this.segmentTimer);
    this.segmentTimer = setTimeout(() => this._rotate(), SEGMENT_MS);
  }

  _rotate() {
    if (this.stopped || this.current?.state === "inactive") return;
    const old = this.current;
    this._startSegment();
    old.stop();
  }

  /** Aktuelles Stück sofort speichern (z. B. wenn die App in den Hintergrund geht). */
  _flush() {
    clearTimeout(this.segmentTimer);
    if (this.current && this.current.state !== "inactive") {
      try { this.current.stop(); } catch { /* egal */ }
    }
  }

  /** Nach dem Zurückkehren in die App: Mikrofon wieder öffnen und weiter aufnehmen. */
  async recover() {
    if (this.stopped || this.recovering) return;
    const track = this.stream?.getAudioTracks()[0];
    const alive = track && track.readyState === "live" && !track.muted && this.current?.state === "recording";
    if (alive) {
      this.audioCtx?.resume?.();
      if (!this.wakeLock || this.wakeLock.released) this._lockScreen();
      return;
    }
    this.recovering = true;
    try {
      this._flush();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.audioCtx?.close();
      this.analyser = null;
      await this._openMic();
      if (this.stopped) { this.stream.getTracks().forEach((t) => t.stop()); return; }
      this.interruptions++;
      this._startSegment();
      toast("Aufnahme läuft weiter.");
    } catch {
      toast("Mikrofon konnte nicht wieder geöffnet werden – bitte Aufnahme beenden und neu starten.", 6000);
    } finally {
      this.recovering = false;
    }
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
    this.stopped = true;
    document.removeEventListener("visibilitychange", this._onVisibility);
    window.removeEventListener("pageshow", this._onVisibility);
    window.removeEventListener("pagehide", this._flushBound);
    this._flush();
    await Promise.all(this.pending);
    this.stream?.getTracks().forEach((t) => t.stop());
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
  const r = await updateRecording(recordingId, { status: "neu", duration, interruptions: recorder.interruptions });
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
   Server-Aufrufe (Schlüssel liegen nur auf dem Server)
   ============================================================ */
const MAX_UPLOAD = 4.3 * 1024 * 1024; // Grenze für eine Anfrage an Vercel

class AuthError extends Error {}

async function api(path, { method = "POST", body, form } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new Error("Keine Verbindung zum Server.");
  }
  let data = {};
  try { data = await res.json(); } catch { /* keine JSON-Antwort */ }
  if (res.status === 401 && path !== "/api/session") {
    showLogin();
    throw new AuthError("Bitte neu anmelden.");
  }
  if (!res.ok) throw new Error(data.error || `Serverfehler (${res.status})`);
  return data;
}

async function transcribeBlob(blob, { prompt, filename }) {
  if (blob.size > MAX_UPLOAD) throw new Error("Audio-Stück ist zu groß (max. 4 MB).");
  const form = new FormData();
  form.append("file", blob, filename);
  if (settings.language) form.append("language", settings.language);
  if (prompt) form.append("prompt", prompt);
  return (await api("/api/transcribe", { form })).text || "";
}

function sttPrompt(folderName, previousText) {
  const parts = [];
  parts.push(`Aufnahme zum Thema „${folderName}“. Gesprochenes Deutsch, mit korrekter Rechtschreibung und Zeichensetzung.`);
  if (settings.vocabulary.trim()) parts.push(`Begriffe und Namen: ${settings.vocabulary.trim()}.`);
  // Ende des vorherigen Stücks für einen sauberen Übergang
  if (previousText) parts.push(previousText.slice(-600));
  return parts.join(" ");
}

async function polishText(text, folderName, previous) {
  const data = await api("/api/claude", {
    body: { kind: "polish", text, previous: previous?.slice(-1500) || "", folderName, vocabulary: settings.vocabulary },
  });
  return data.text || text;
}

async function summarizeFolder(folderId) {
  const folder = await store.folder(folderId);
  const recs = (await store.recordings(folderId)).filter((r) => r.status === "fertig" && r.transcript.trim());
  if (!recs.length) throw new Error("Noch keine fertigen Transkripte in diesem Ordner.");
  const { summary } = await api("/api/claude", {
    body: {
      kind: "summary",
      folderName: folder.name,
      recordings: recs.map((r) => ({
        time: new Date(r.createdAt).toLocaleString("de-DE"),
        duration: fmtDuration(r.duration),
        text: r.transcript,
      })),
    },
  });
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
      // Pro Stück: Text erkennen, dann nachbessern. Zwischenstände werden gespeichert,
      // damit nach einem Fehler oder Neuladen nichts doppelt gemacht wird.
      const parts = r.parts ? [...r.parts] : [];
      const total = r.segments.length;
      const label = (i) => (total > 1 ? `Teil ${i + 1}/${total}` : "");
      for (const [i, seg] of r.segments.entries()) {
        parts[i] ??= {};
        if (parts[i].raw == null) {
          await updateRecording(id, { status: "transkribiere", error: null, progress: label(i) });
          render();
          const name = seg.name || `aufnahme-${i + 1}.${extFor(seg.mime || seg.blob.type)}`;
          parts[i].raw = await transcribeBlob(seg.blob, { prompt: sttPrompt(folder.name, parts[i - 1]?.raw), filename: name });
          await updateRecording(id, { parts });
        }
        if (settings.polish && parts[i].polished == null && parts[i].raw.trim()) {
          await updateRecording(id, { status: "bessere", progress: label(i) });
          render();
          parts[i].polished = await polishText(parts[i].raw, folder.name, parts[i - 1]?.polished ?? parts[i - 1]?.raw);
          await updateRecording(id, { parts });
        }
      }
      const raw = parts.map((p) => p.raw).join("\n\n").trim();
      const polishedAll = parts.every((p) => p.polished != null || !p.raw.trim());
      const transcript = settings.polish && polishedAll
        ? parts.map((p) => p.polished ?? p.raw).join("\n\n").trim()
        : raw;
      r = await updateRecording(id, {
        rawTranscript: raw,
        transcript,
        polished: settings.polish && polishedAll,
        status: "fertig",
        error: null,
        progress: "",
      });
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
  if (!settings.autoSummary) return;
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
    let segments = [{ index: 0, blob: file, mime: file.type, name: file.name }];
    let duration;
    if (file.size > MAX_UPLOAD) {
      toast(`„${file.name}“ wird vorbereitet …`, 8000);
      try {
        ({ segments, duration } = await splitAudioFile(file));
      } catch (err) {
        console.error(err);
        toast(`„${file.name}“ konnte nicht gelesen werden (zu lang oder unbekanntes Format).`, 6000);
        continue;
      }
    } else {
      duration = await probeDuration(file);
    }
    const rec = {
      id: uid(),
      folderId,
      createdAt: file.lastModified || Date.now(),
      source: "datei",
      fileName: file.name,
      status: "neu",
      segments,
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

/* Große Dateien im Browser dekodieren und in kleine WAV-Stücke (Mono, Sprachqualität) schneiden,
   damit jedes Stück durch den Server passt. */
async function splitAudioFile(file) {
  const data = await file.arrayBuffer();
  let audio;
  for (const rate of [16000, 22050, 24000, 44100]) {
    try {
      const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, rate);
      audio = await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(data.slice(0), resolve, reject);
        p?.then?.(resolve, reject);
      });
      break;
    } catch (err) {
      if (rate === 44100) throw err;
    }
  }
  const rate = audio.sampleRate;
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const chunkSamples = Math.floor((3.6 * 1024 * 1024) / 2) - 44; // 16 Bit pro Sample, < 4 MB pro Stück
  const segments = [];
  const base = file.name.replace(/\.[^.]+$/, "");
  for (let start = 0, index = 0; start < audio.length; start += chunkSamples, index++) {
    const end = Math.min(audio.length, start + chunkSamples);
    const blob = encodeWav(channels, start, end, rate);
    segments.push({ index, blob, mime: "audio/wav", name: `${base}-${index + 1}.wav` });
  }
  return { segments, duration: audio.duration };
}

function encodeWav(channels, start, end, rate) {
  const n = end - start;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  const k = channels.length;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (const ch of channels) x += ch[start + i];
    x = Math.max(-1, Math.min(1, x / k));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
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
const CATS = {
  today: { icon: "☀️", label: "Heute" },
  process: { icon: "🔁", label: "Prozess" },
  private: { icon: "🔒", label: "Privat" },
};
const CAT_ORDER = ["today", "process", "private"];

/** Spalte eines To-dos: eigene Wahl > feste Einstellung > Vorschlag der KI > Heute */
function todoCategory(folder, t) {
  const own = (folder.todoCat || {})[todoKey(t)];
  if (own) return own;
  if (settings.todoCategory && settings.todoCategory !== "auto") return settings.todoCategory;
  return CATS[t.spalte] ? t.spalte : "today";
}

const todoLine = (t) => t.aufgabe + (t.bis ? ` (bis ${t.bis})` : "") + (t.wer ? ` – ${t.wer}` : "");

async function sendTodos(todos, folder) {
  const folderName = folder.name;
  if (!todos.length) return false;
  const app = settings.todoApp || DEFAULTS.todoApp;
  const lines = todos.map(todoLine);
  const text = lines.join("\n");
  const enc = encodeURIComponent;
  let url;
  switch (app) {
    case "aufgabenplaner": {
      try {
        const { count } = await api("/api/todo", {
          body: {
            tasks: todos.map((t) => ({
              title: t.aufgabe,
              category: todoCategory(folder, t),
              description: [t.wer && `Wer: ${t.wer}`, t.bis && `Bis: ${t.bis}`, `Aus Aufnahme: ${folderName}`].filter(Boolean).join("\n"),
            })),
          },
        });
        toast(count === 1 ? "Im Aufgabenplaner angelegt." : `${count} Aufgaben im Aufgabenplaner angelegt.`);
        return true;
      } catch (err) {
        if (!(err instanceof AuthError)) toast(err.message, 5000);
        return false;
      }
    }
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
  const ok = await sendTodos(todos, f);
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
  if (!loggedIn) return;
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

  const setupHint = settings.todoApp === "aufgabenplaner" && serverFeatures && !serverFeatures.aufgabenplaner
    ? `<button class="notice" data-action="settings">Der Aufgabenplaner ist auf dem Server noch nicht eingerichtet (SUPABASE_URL / SUPABASE_ANON_KEY) – oder in den <b>Einstellungen</b> eine andere To-do-App wählen.</button>`
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
        <p class="hint">Am iPhone pausiert das Mikrofon, solange du in einer anderen App bist oder das Handy gesperrt ist. Beim Zurückkommen läuft die Aufnahme automatisch weiter. Für lange Aufnahmen im Hintergrund die Sprachmemos-App nutzen und die Datei hier hinzufügen.</p>
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
            const cat = CATS[todoCategory(f, t)];
            return `<li><label class="${done[k] ? "done" : ""}">
              <input type="checkbox" data-todo="${esc(k)}" ${done[k] ? "checked" : ""}>
              <span>${esc(t.aufgabe)}${meta ? `<small>${esc(meta)}</small>` : ""}</span>
            </label>
            ${settings.todoApp === "aufgabenplaner" ? `<button class="cat" data-action="cycle-cat" data-key="${esc(k)}" title="Spalte ändern">${cat.icon} ${cat.label}</button>` : ""}
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
            <span class="muted">${fmtTime(r.createdAt)} · ${fmtDuration(r.duration)}${r.fileName ? ` · ${esc(r.fileName)}` : ""}${r.interruptions ? ` · ${r.interruptions}× unterbrochen` : ""}</span>
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
    case "cycle-cat": {
      const f = await store.folder(route.id);
      const t = [...(f.summary?.todos || []), ...(f.extraTodos || [])].find((x) => todoKey(x) === btn.dataset.key);
      if (!t) break;
      const next = CAT_ORDER[(CAT_ORDER.indexOf(todoCategory(f, t)) + 1) % CAT_ORDER.length];
      await updateFolder(route.id, (x) => ({ todoCat: { ...(x.todoCat || {}), [btn.dataset.key]: next } }));
      render();
      break;
    }
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
  form.querySelector(".planner-only").hidden = v !== "aufgabenplaner";
}
$("#logout").addEventListener("click", logout);
form.elements.todoApp.addEventListener("change", updateTodoAppHint);
form.addEventListener("submit", () => {
  const next = { ...settings };
  for (const k of Object.keys(DEFAULTS)) {
    const el = form.elements[k];
    if (!el) continue;
    next[k] = el.type === "checkbox" ? el.checked : el.value.trim();
  }
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
    if (["neu", "transkribiere", "bessere"].includes(r.status)) processRecording(r.id);
  }
}

/* Speicher dauerhaft anfordern, damit der Browser nichts wegräumt */
navigator.storage?.persist?.().catch(() => {});

/* ============================================================
   Anmeldung
   ============================================================ */
let serverFeatures = null;
let loggedIn = false;

function showLogin(message = "") {
  loggedIn = false;
  $("#title").textContent = "Plaude";
  $("#back").hidden = true;
  $("#open-settings").hidden = true;
  view.innerHTML = `
    <form class="card login" data-form="login">
      <h2>Anmelden</h2>
      <p class="hint">Deine Aufnahmen bleiben auf diesem Gerät. Das Passwort schützt die Transkription und deinen Aufgabenplaner.</p>
      <input type="password" name="password" placeholder="Passwort" autocomplete="current-password" required>
      ${message ? `<p class="error">${esc(message)}</p>` : ""}
      <button class="btn primary" type="submit">Anmelden</button>
    </form>`;
  view.querySelector("input").focus();
}

async function onLoggedIn(data) {
  loggedIn = true;
  serverFeatures = data.features || {};
  $("#open-settings").hidden = false;
  parseRoute();
  await render();
  resumePending();
}

view.addEventListener("submit", async (e) => {
  const form = e.target.closest('form[data-form="login"]');
  if (!form) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: form.password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showLogin(data.error || "Anmeldung fehlgeschlagen."); return; }
    form.password.blur();
    await onLoggedIn(data);
  } catch {
    showLogin("Keine Verbindung zum Server.");
  }
}, true);

async function logout() {
  await fetch("/api/session", { method: "DELETE", credentials: "same-origin" }).catch(() => {});
  dlg.close();
  showLogin();
}

(async () => {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return onLoggedIn(data);
    showLogin(res.status === 401 ? "" : data.error || "Server nicht erreichbar.");
  } catch {
    showLogin("Server nicht erreichbar.");
  }
})();
