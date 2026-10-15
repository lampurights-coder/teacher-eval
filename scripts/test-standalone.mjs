#!/usr/bin/env node
/**
 * Verify standalone admin/settings/session save logic without a browser.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(String(k), String(v));
  }
  removeItem(k) {
    this.map.delete(String(k));
  }
}

/** Minimal IndexedDB for our put/get/getAll usage */
function installFakeIndexedDB(global) {
  const dbs = new Map();

  class Request {
    constructor() {
      this.result = null;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
    }
    _ok(result) {
      this.result = result;
      queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this }));
    }
    _fail(err) {
      this.error = err;
      queueMicrotask(() => this.onerror && this.onerror({ target: this }));
    }
  }

  class ObjectStore {
    constructor(name, data) {
      this.name = name;
      this.data = data;
    }
    put(value) {
      const req = new Request();
      // Keep references (Blob/File must not structuredClone in Node tests)
      this.data.set(value.id, value);
      req._ok(value.id);
      return req;
    }
    get(id) {
      const req = new Request();
      req._ok(this.data.has(id) ? this.data.get(id) : undefined);
      return req;
    }
    getAll() {
      const req = new Request();
      req._ok([...this.data.values()]);
      return req;
    }
  }

  class Transaction {
    constructor(db, storeNames) {
      this.db = db;
      this.storeNames = storeNames;
      this.oncomplete = null;
      this.onerror = null;
      queueMicrotask(() => this.oncomplete && this.oncomplete());
    }
    objectStore(name) {
      if (!this.db.stores.has(name)) this.db.stores.set(name, new Map());
      return new ObjectStore(name, this.db.stores.get(name));
    }
  }

  class IDBDatabase {
    constructor(name) {
      this.name = name;
      this.objectStoreNames = {
        _names: new Set(),
        contains(n) {
          return this._names.has(n);
        },
      };
      this.stores = new Map();
    }
    createObjectStore(name) {
      this.objectStoreNames._names.add(name);
      this.stores.set(name, new Map());
      return {};
    }
    transaction(storeNames) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      return new Transaction(this, names);
    }
  }

  global.indexedDB = {
    open(name, version) {
      const req = new Request();
      let db = dbs.get(name);
      const isNew = !db;
      if (!db) {
        db = new IDBDatabase(name);
        dbs.set(name, db);
      }
      queueMicrotask(() => {
        if (isNew && req.onupgradeneeded) {
          req.result = db;
          req.onupgradeneeded({ target: req });
        }
        req._ok(db);
      });
      return req;
    },
  };
}

function installCrypto(global) {
  global.crypto = {
    subtle: {
      async digest(algo, data) {
        if (algo !== "SHA-256") throw new Error("only SHA-256");
        const hash = createHash("sha256").update(Buffer.from(data)).digest();
        return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
      },
    },
    randomUUID() {
      return "11111111-1111-4111-8111-111111111111";
    },
  };
  global.TextEncoder = class {
    encode(s) {
      return Buffer.from(String(s), "utf8");
    }
  };
}

// Blob/File/FormData for session create
class NodeBlob {
  constructor(parts, opts = {}) {
    this._buf = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
    this.size = this._buf.length;
    this.type = opts.type || "";
  }
  async arrayBuffer() {
    return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength);
  }
}
class NodeFile extends NodeBlob {
  constructor(parts, name, opts) {
    super(parts, opts);
    this.name = name;
  }
}
class NodeFormData {
  constructor() {
    this._m = new Map();
  }
  append(k, v) {
    this._m.set(k, v);
  }
  get(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  }
}

async function main() {
  const localStorage = new MemoryStorage();
  const global = {
    localStorage,
    location: { protocol: "capacitor:" },
    ASR_STANDALONE: true,
    Capacitor: {},
    Blob: NodeBlob,
    File: NodeFile,
    FormData: NodeFormData,
    URL: {
      createObjectURL() {
        return "blob:test";
      },
    },
    fetch: async () => {
      throw new Error("network should not be called in unit tests");
    },
  };
  installFakeIndexedDB(global);
  installCrypto(global);

  // Load standalone IIFE against our fake window
  const src = readFileSync(path.join(root, "ui-template/standalone.js"), "utf8");
  const runner = new Function("window", "globalThis", src + "\n;return window.AsrStandalone;");
  const Asr = runner(global, global);
  assert(Asr && Asr.isStandalone(), "standalone mode detected");

  // --- admin create + persist ---
  let status = await Asr.route("/api/admin/status");
  assert(status.setup_done === false, "setup starts empty");

  const created = await Asr.route("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ username: "teacher", password: "secret1" }),
  });
  assert(created.created === true && created.username === "teacher", "admin account created");
  assert(localStorage.getItem("asrStandaloneLoggedIn") === "1", "login session flag saved");
  assert(Boolean(localStorage.getItem("asrStandaloneAdmin")), "admin credentials saved in localStorage");

  status = await Asr.route("/api/admin/status");
  assert(status.setup_done === true, "setup_done after create");

  // wrong password
  let bad = null;
  try {
    await Asr.route("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: "teacher", password: "nope" }),
    });
  } catch (e) {
    bad = e;
  }
  assert(bad && /Wrong/.test(bad.message), "wrong password rejected");

  // --- settings persist (token kept when blank) ---
  await Asr.route("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({
      base_url: "https://api.avalai.ir/v1",
      asr_model: "gpt-4o-transcribe-diarize",
      llm_model: "gpt-4o-mini",
      api_token: "tok_test_1234",
    }),
  });
  let settings = await Asr.route("/api/admin/settings");
  assert(settings.has_token === true, "token marked saved");
  assert(settings.token_hint.includes("1234"), "token hint shows last4");
  assert(JSON.parse(localStorage.getItem("asrStandaloneSettings")).api_token === "tok_test_1234", "raw token persisted locally");

  await Asr.route("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({
      base_url: "https://api.avalai.ir/v1",
      asr_model: "gpt-4o-transcribe-diarize",
      llm_model: "gpt-4o-mini",
    }),
  });
  settings = await Asr.route("/api/admin/settings");
  assert(JSON.parse(localStorage.getItem("asrStandaloneSettings")).api_token === "tok_test_1234", "blank token keep keeps previous");

  // --- session + audio + evaluation cache ---
  // Stub AvalAI transcribe by monkeypatching fetch used inside standalone
  let fetchCalls = 0;
  global.fetch = async (url, opts = {}) => {
    fetchCalls += 1;
    const u = String(url);
    if (u.includes("/audio/transcriptions")) {
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            duration: 12.5,
            text: "hello class",
            segments: [
              { speaker: "A", start: 0, end: 2, text: "Hello students" },
              { speaker: "B", start: 2.1, end: 4, text: "Hello teacher" },
            ],
          });
        },
        async json() {
          return JSON.parse(await this.text());
        },
      };
    }
    if (u.includes("/chat/completions")) {
      return {
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    teacher: { speaker: "A", name: null },
                    student: { speaker: "B", name: null },
                    verdict: "good",
                    summary: "Clear teaching. Student engages.",
                    good: [{ point: "Greeting", reason: "Warm start", phrase: "Hello students" }],
                    bad: [{ point: "Pace", reason: "Could slow down", phrase: "Hello students" }],
                  }),
                },
              },
            ],
          };
        },
      };
    }
    if (u.includes("/models")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o-transcribe-diarize" }] };
        },
      };
    }
    throw new Error("unexpected fetch " + u);
  };

  const models = await Asr.route("/api/admin/models?api_token=tok_test_1234");
  assert(models.models.includes("gpt-4o-mini"), "models list works");

  const file = new NodeFile([Buffer.from("fake-audio-bytes")], "class.mp3", { type: "audio/mpeg" });
  const form = new NodeFormData();
  form.append("file", file);
  assert(typeof form.get === "function" && form.get("file")?.size > 0, "FormData carries file blob");
  const createdSession = await Asr.route("/api/sessions", { method: "POST", body: form });
  assert(createdSession.id, "session id returned");

  let session;
  for (let i = 0; i < 80; i++) {
    session = await Asr.route(`/api/sessions/${createdSession.id}`);
    if (session.status === "parsed" || session.status === "error") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert(
    session.status === "parsed",
    `session reaches parsed and stays saved (got ${session.status}: ${session.error || session.stage})`
  );
  assert(session.segments.length === 2, "diarized segments saved");
  assert(session.audio_url, "audio_url present for playback");

  const listed = await Asr.route("/api/sessions");
  assert(listed.some((s) => s.id === createdSession.id), "parsed session appears in history list");

  const review = await Asr.route(`/api/sessions/${createdSession.id}/evaluation`);
  assert(review.verdict === "good", "evaluation produced");
  assert(review.cached === false, "first evaluation not cached");
  const review2 = await Asr.route(`/api/sessions/${createdSession.id}/evaluation`);
  assert(review2.cached === true, "second evaluation served from saved cache");

  const audio = await Asr.resolveAudioUrl(createdSession.id);
  assert(audio === "blob:test", "audio blob url resolved from IndexedDB");

  await Asr.route("/api/admin/logout", { method: "POST", body: "{}" });
  assert(localStorage.getItem("asrStandaloneLoggedIn") == null, "logout clears session flag");
  assert(localStorage.getItem("asrStandaloneAdmin"), "logout keeps saved admin account");

  // re-login works with saved credentials
  const again = await Asr.route("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ username: "teacher", password: "secret1" }),
  });
  assert(again.created === false, "second login uses saved account");

  if (failed) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll standalone save tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
