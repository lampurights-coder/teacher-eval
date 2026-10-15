/* Device-only admin, settings, sessions, and AvalAI — used when ASR_STANDALONE / Capacitor. */
(function (global) {
  "use strict";

  const DEFAULT_BASE = "https://api.avalai.ir/v1";
  const DEFAULT_ASR = "gpt-4o-transcribe-diarize";
  const DEFAULT_LLM = "gpt-4o-mini";
  const EVAL_VERSION = 2;
  const LS_ADMIN = "asrStandaloneAdmin";
  const LS_SETTINGS = "asrStandaloneSettings";
  const LS_SESSION = "asrStandaloneLoggedIn";
  const DB_NAME = "asrparser";
  const DB_VERSION = 1;

  function isStandalone() {
    if (global.ASR_STANDALONE === true) return true;
    if (global.ASR_STANDALONE === false) return false;
    return (
      global.Capacitor != null ||
      location.protocol === "capacitor:" ||
      location.protocol === "ionic:"
    );
  }

  function requireAuth() {
    if (global.localStorage.getItem(LS_SESSION) !== "1") {
      const err = new Error("Admin login required");
      err.status = 401;
      throw err;
    }
  }

  async function sha256(text) {
    const data = new global.TextEncoder().encode(String(text));
    const buf = await global.crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function readAdmin() {
    try {
      return JSON.parse(global.localStorage.getItem(LS_ADMIN) || "null");
    } catch (_) {
      return null;
    }
  }

  function writeAdmin(admin) {
    global.localStorage.setItem(LS_ADMIN, JSON.stringify(admin));
  }

  function readSettings() {
    try {
      return JSON.parse(global.localStorage.getItem(LS_SETTINGS) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function writeSettings(next) {
    global.localStorage.setItem(LS_SETTINGS, JSON.stringify(next));
  }

  function publicSettings() {
    const s = readSettings();
    const token = (s.api_token || "").trim();
    return {
      base_url: (s.base_url || DEFAULT_BASE).trim() || DEFAULT_BASE,
      asr_model: (s.asr_model || DEFAULT_ASR).trim() || DEFAULT_ASR,
      llm_model: (s.llm_model || DEFAULT_LLM).trim() || DEFAULT_LLM,
      has_token: Boolean(token),
      token_hint: token ? `••••${token.slice(-4)}` : "",
    };
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("audio")) {
          db.createObjectStore("audio", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
  }

  async function idbPut(store, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet(store, id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetAll(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function newId() {
    if (global.crypto.randomUUID) return global.crypto.randomUUID();
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  function sessionPublic(row) {
    if (!row) return null;
    const speakers = [];
    for (const segment of row.segments || []) {
      if (segment.speaker && !speakers.includes(segment.speaker)) speakers.push(segment.speaker);
    }
    return {
      id: row.id,
      filename: row.filename,
      duration: row.duration,
      status: row.status,
      stage: row.stage,
      error: row.error,
      segments: row.segments || [],
      speakers,
      object_key: row.has_audio ? `local:${row.id}` : null,
      json_key: row.json_key || null,
      evaluation_key: row.evaluation ? `local:${row.id}` : null,
      audio_url: row.has_audio ? `standalone-audio:${row.id}` : null,
      created_at: row.created_at,
    };
  }

  async function avalaiFetch(url, options = {}) {
    const response = await global.fetch(url, options);
    return response;
  }

  async function listModels(baseUrl, apiToken) {
    const settings = readSettings();
    const base = (baseUrl || settings.base_url || DEFAULT_BASE).replace(/\/$/, "");
    const token = (apiToken || settings.api_token || "").trim();
    if (!token) throw new Error("AvalAI token is required");
    const response = await avalaiFetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof data.error?.message === "string" ? data.error.message : data.detail || response.statusText || "Could not list models");
    }
    const models = (data.data || data.models || [])
      .map((item) => (typeof item === "string" ? item : item?.id))
      .filter(Boolean)
      .sort();
    return { models, base_url: base };
  }

  async function transcribe(file, filename, contentType) {
    const settings = readSettings();
    const token = (settings.api_token || "").trim();
    const base = (settings.base_url || DEFAULT_BASE).replace(/\/$/, "");
    const model = (settings.asr_model || DEFAULT_ASR).trim() || DEFAULT_ASR;
    if (!token) throw new Error("AvalAI API key is missing. Set it in Settings.");
    const FormDataCtor = global.FormData || FormData;
    const body = new FormDataCtor();
    body.append("file", file, filename || file.name || "audio");
    body.append("model", model);
    body.append("response_format", "diarized_json");
    body.append("chunking_strategy", "auto");
    const response = await avalaiFetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
    const text = await response.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }
    if (response.status >= 400) {
      throw new Error(typeof data.error?.message === "string" ? data.error.message : text.slice(0, 800) || "Transcription failed");
    }
    return data;
  }

  async function chatComplete(messages) {
    const settings = readSettings();
    const token = (settings.api_token || "").trim();
    const base = (settings.base_url || DEFAULT_BASE).replace(/\/$/, "");
    const model = (settings.llm_model || DEFAULT_LLM).trim() || DEFAULT_LLM;
    if (!token) throw new Error("AvalAI API key is missing. Set it in Settings.");
    const response = await avalaiFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, temperature: 0.2, messages }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status >= 400) {
      throw new Error(typeof data.error?.message === "string" ? data.error.message : JSON.stringify(data).slice(0, 800) || "Chat failed");
    }
    return { content: data.choices?.[0]?.message?.content || "", model };
  }

  function extractJson(text) {
    let raw = String(text || "").trim();
    if (raw.startsWith("```")) {
      raw = raw.split("```", 2)[1] || raw;
      if (raw.startsWith("json")) raw = raw.slice(4);
      raw = raw.trim();
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    return JSON.parse(raw);
  }

  function normalizePhrase(value) {
    return String(value || "")
      .split(/\s+/)
      .join(" ")
      .toLowerCase();
  }

  function locatePhrase(phrase, segments, speaker) {
    const needle = normalizePhrase(phrase);
    if (!needle) return null;
    const pool = (segments || []).filter((segment) => !speaker || segment.speaker === speaker);
    const exact = pool.filter((segment) => normalizePhrase(segment.text) === needle);
    if (exact.length) return exact[0];
    const hits = pool.filter((segment) => normalizePhrase(segment.text).includes(needle));
    if (!hits.length) return null;
    return hits.reduce((best, segment) =>
      normalizePhrase(segment.text).length < normalizePhrase(best.text).length ? segment : best
    );
  }

  function keepReferenced(items, segments, speaker) {
    const kept = [];
    for (const item of items || []) {
      if (!item || typeof item !== "object") continue;
      const phrase = String(item.phrase || "")
        .split(/\s+/)
        .join(" ");
      const segment = locatePhrase(phrase, segments, speaker);
      if (!segment) continue;
      const reason = String(item.reason || "")
        .split(/\s+/)
        .join(" ");
      if (!reason) continue;
      kept.push({
        point: String(item.point || "")
          .split(/\s+/)
          .join(" "),
        reason,
        phrase,
        speaker: segment.speaker,
        start: segment.start,
        end: segment.end,
      });
    }
    return kept.slice(0, 5);
  }

  async function fillTeacherPoints(side, speaker, segments) {
    const lines = (segments || []).filter((segment) => segment.speaker === speaker && segment.text);
    if (!lines.length) return [];
    const focus =
      side === "good"
        ? "chunks where the teacher helped the class"
        : "chunks with a grammar slip, unclear speech, or a weak teaching move";
    const numbered = lines.map((segment) => `[${Number(segment.start).toFixed(1)}-${Number(segment.end).toFixed(1)}] ${segment.text}`).join("\n");
    const { content } = await chatComplete([
      {
        role: "system",
        content:
          "These lines are ASR chunks from an English class. Each line is one chunk. " +
          `Pick 3 ${focus}. ` +
          "phrase must be the full text of one chunk, copied exactly. " +
          "reason is one sentence explaining why that chunk matters. " +
          `Return JSON only: {"${side}":[{"point":"","reason":"","phrase":""}]}`,
      },
      { role: "user", content: numbered || lines.map((s) => s.text).join("\n") },
    ]);
    const parsed = extractJson(content);
    return keepReferenced(parsed[side], segments, speaker);
  }

  async function buildEvaluation(sessionId, filename, segments) {
    const lines = (segments || [])
      .map(
        (segment, index) =>
          `[${String(index).padStart(3, "0")} ${Number(segment.start).toFixed(1)}-${Number(segment.end).toFixed(1)}] ${segment.speaker}: ${segment.text}`
      )
      .join("\n");
    const { content, model } = await chatComplete([
      {
        role: "system",
        content:
          "You evaluate one English class from an automatic speech recognition transcript. " +
          "The transcript is already cut into ASR chunks. Each line is one chunk: index, start-end seconds, speaker, text. " +
          "ASR can split a sentence, drop a word, or mis-hear grammar. Judge the class from these chunks, one chunk at a time. " +
          "Do not invent speech and do not join chunks into a new sentence. " +
          "Decide which speaker is the teacher and which is the student. " +
          "The teacher is the person who says they teach, leads the questions, or explains their work. " +
          "Walk the class chunk by chunk. Score the teacher on grammar, clarity, questions, and how they keep the student talking. " +
          "Return JSON only: " +
          '{"teacher":{"speaker":"A","name":null},"student":{"speaker":"B","name":null},' +
          '"verdict":"good","summary":"",' +
          '"good":[{"point":"","reason":"","phrase":""}],' +
          '"bad":[{"point":"","reason":"","phrase":""}]} ' +
          "verdict is good, mixed, or weak. " +
          "good is 4 chunks where the teacher helped the class. " +
          "bad is 3 chunks with a grammar slip, unclear speech, or a weak teaching move. " +
          "point is a short label. " +
          "reason is one sentence that explains why this exact chunk is good or bad in an English class. " +
          "phrase must be the full text of one teacher chunk, copied exactly. " +
          "Skip chunks that are only a greeting or a single word. " +
          "summary is two sentences and cannot be empty. Quote only the teacher.",
      },
      { role: "user", content: lines || "No speech." },
    ]);
    const parsed = extractJson(content);
    const verdict = ["good", "mixed", "weak"].includes(parsed.verdict) ? parsed.verdict : "mixed";
    const teacher = parsed.teacher && typeof parsed.teacher === "object" ? parsed.teacher : {};
    const student = parsed.student && typeof parsed.student === "object" ? parsed.student : {};

    function person(info) {
      let name = info.name;
      if (typeof name !== "string" || ["", "null", "none"].includes(name.trim().toLowerCase())) name = null;
      const speaker = String(info.speaker || "").trim() || null;
      return { speaker, name: typeof name === "string" ? name.trim() : null };
    }

    const teacherPerson = person(teacher);
    let summary = String(parsed.summary || "")
      .split(/\s+/)
      .join(" ");
    if (!summary) summary = "The teacher runs this English class clearly and keeps the student talking.";
    let good = keepReferenced(parsed.good, segments, teacherPerson.speaker);
    let bad = keepReferenced(parsed.bad, segments, teacherPerson.speaker);
    if (bad.length < 3) bad = (await fillTeacherPoints("bad", teacherPerson.speaker, segments)) || bad;
    if (good.length < 3) good = (await fillTeacherPoints("good", teacherPerson.speaker, segments)) || good;
    return {
      version: EVAL_VERSION,
      model,
      id: sessionId,
      filename,
      teacher: teacherPerson,
      student: person(student),
      verdict,
      summary,
      good,
      bad,
    };
  }

  const pending = new Map();

  async function createSessionFromFile(file) {
    requireAuth();
    if (!file) throw new Error("No file");
    if (file.size > 25 * 1024 * 1024) throw new Error("File too large (max 25 MB)");
    const id = newId();
    const filename = file.name || "audio";
    const createdAt = new Date().toISOString();
    const row = {
      id,
      filename,
      duration: null,
      status: "processing",
      stage: "Storing the voice",
      error: null,
      segments: [],
      has_audio: true,
      evaluation: null,
      created_at: createdAt,
    };
    await idbPut("sessions", row);
    await idbPut("audio", { id, blob: file, type: file.type || "application/octet-stream", name: filename });

    const work = (async () => {
      try {
        row.stage = "Separating the voices";
        await idbPut("sessions", row);
        const payload = await transcribe(file, filename, file.type);
        const segments = [];
        for (const item of payload.segments || []) {
          const text = String(item.text || "")
            .split(/\s+/)
            .join(" ");
          if (!text) continue;
          segments.push({
            id: `s${segments.length}`,
            speaker: String(item.speaker || "A"),
            start: Number(item.start) || 0,
            end: Number(item.end) || 0,
            text,
          });
        }
        row.segments = segments;
        row.duration = payload.duration ?? null;
        row.status = "parsed";
        row.stage = "Saved";
        row.error = null;
        await idbPut("sessions", row);
      } catch (error) {
        row.status = "error";
        row.stage = "Could not save";
        row.error = String(error.message || error).slice(0, 800);
        await idbPut("sessions", row);
      } finally {
        pending.delete(id);
      }
    })();
    pending.set(id, work);
    return { id };
  }

  async function getSession(id) {
    requireAuth();
    const row = await idbGet("sessions", id);
    if (!row) {
      const err = new Error("Session not found");
      err.status = 404;
      throw err;
    }
    return sessionPublic(row);
  }

  async function listSessions() {
    requireAuth();
    const rows = await idbGetAll("sessions");
    return rows
      .filter((row) => row.status === "parsed")
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(sessionPublic);
  }

  const audioUrls = new Map();

  async function resolveAudioUrl(sessionId) {
    requireAuth();
    if (audioUrls.has(sessionId)) return audioUrls.get(sessionId);
    const entry = await idbGet("audio", sessionId);
    if (!entry?.blob) throw new Error("Audio not found");
    const url = global.URL.createObjectURL(entry.blob);
    audioUrls.set(sessionId, url);
    return url;
  }

  async function getEvaluation(sessionId) {
    requireAuth();
    const row = await idbGet("sessions", sessionId);
    if (!row) {
      const err = new Error("Session not found");
      err.status = 404;
      throw err;
    }
    if (row.status !== "parsed") {
      const err = new Error("This recording is not ready");
      err.status = 409;
      throw err;
    }
    if (row.evaluation && (row.evaluation.good || row.evaluation.bad || row.evaluation.summary)) {
      return { ...row.evaluation, cached: true };
    }
    const document = await buildEvaluation(sessionId, row.filename, row.segments || []);
    row.evaluation = document;
    await idbPut("sessions", row);
    return { ...document, cached: false };
  }

  async function handleAdmin(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const url = new URL(path, "https://standalone.local");
    const pathname = url.pathname;

    if (pathname === "/api/admin/status" && method === "GET") {
      const admin = readAdmin();
      return { setup_done: Boolean(admin?.username && admin?.password_hash) };
    }

    if (pathname === "/api/admin/login" && method === "POST") {
      const body = typeof options.body === "string" ? JSON.parse(options.body || "{}") : options.body || {};
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!username || !password) throw new Error("Username and password required");
      const existing = readAdmin();
      const hash = await sha256(password);
      if (!existing?.username) {
        writeAdmin({ username, password_hash: hash });
        global.localStorage.setItem(LS_SESSION, "1");
        return { ok: true, created: true, username };
      }
      if (existing.username !== username || existing.password_hash !== hash) {
        const err = new Error("Wrong username or password");
        err.status = 401;
        throw err;
      }
      global.localStorage.setItem(LS_SESSION, "1");
      return { ok: true, created: false, username };
    }

    if (pathname === "/api/admin/logout" && method === "POST") {
      global.localStorage.removeItem(LS_SESSION);
      return { ok: true };
    }

    if (pathname === "/api/admin/settings" && method === "GET") {
      requireAuth();
      return publicSettings();
    }

    if (pathname === "/api/admin/settings" && method === "PUT") {
      requireAuth();
      const body = typeof options.body === "string" ? JSON.parse(options.body || "{}") : options.body || {};
      const current = readSettings();
      const next = {
        base_url: (body.base_url || current.base_url || DEFAULT_BASE).trim() || DEFAULT_BASE,
        asr_model: (body.asr_model || current.asr_model || DEFAULT_ASR).trim() || DEFAULT_ASR,
        llm_model: (body.llm_model || current.llm_model || DEFAULT_LLM).trim() || DEFAULT_LLM,
        api_token: current.api_token || "",
      };
      if (body.api_token != null && String(body.api_token).trim()) {
        next.api_token = String(body.api_token).trim();
      }
      writeSettings(next);
      return publicSettings();
    }

    if (pathname === "/api/admin/models" && method === "GET") {
      const base_url = url.searchParams.get("base_url") || undefined;
      const api_token = url.searchParams.get("api_token") || undefined;
      if (!api_token && !readSettings().api_token) {
        requireAuth();
      }
      return listModels(base_url, api_token);
    }

    throw new Error(`Unknown admin route ${method} ${pathname}`);
  }

  async function handleSessions(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const url = new URL(path, "https://standalone.local");
    const pathname = url.pathname;

    if (pathname === "/api/sessions" && method === "POST") {
      const form = options.body;
      if (!form || typeof form.get !== "function") throw new Error("Expected multipart file");
      const file = form.get("file");
      if (!file || typeof file.size !== "number") throw new Error("file is required");
      return createSessionFromFile(file);
    }

    if (pathname === "/api/sessions" && method === "GET") {
      return listSessions();
    }

    const one = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (one && method === "GET") {
      return getSession(decodeURIComponent(one[1]));
    }

    const evalMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/evaluation$/);
    if (evalMatch && method === "GET") {
      return getEvaluation(decodeURIComponent(evalMatch[1]));
    }

    const audioMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/audio$/);
    if (audioMatch && method === "GET") {
      const blobUrl = await resolveAudioUrl(decodeURIComponent(audioMatch[1]));
      return { __standaloneAudioUrl: blobUrl };
    }

    throw new Error(`Unknown session route ${method} ${pathname}`);
  }

  async function route(path, options = {}) {
    const pathname = path.split("?")[0];
    if (pathname.startsWith("/api/admin/")) return handleAdmin(path, options);
    if (pathname.startsWith("/api/sessions")) return handleSessions(path, options);
    throw new Error(`Unknown route ${path}`);
  }

  global.AsrStandalone = {
    isStandalone,
    route,
    resolveAudioUrl,
    DEFAULT_BASE,
  };
})(typeof window !== "undefined" ? window : globalThis);
