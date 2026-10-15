/* ASR Parser UI interactions */

function isStandaloneApp() {
  return Boolean(window.AsrStandalone?.isStandalone?.());
}

function resolveApiBase() {
  if (isStandaloneApp()) return "";
  if (typeof window.ASR_API_BASE === "string" && window.ASR_API_BASE.trim()) {
    return window.ASR_API_BASE.trim().replace(/\/$/, "");
  }
  try {
    const saved = localStorage.getItem("asrApiBase");
    if (saved && saved.trim()) return saved.trim().replace(/\/$/, "");
  } catch (_) {}
  if (location.protocol === "http:" || location.protocol === "https:") return "";
  return "http://127.0.0.1:8765";
}

let API = resolveApiBase();

function api(path) {
  if (!path) return path;
  return path.startsWith("http") ? path : API + path;
}

function setApiBase(url) {
  if (isStandaloneApp()) return;
  API = String(url || "").trim().replace(/\/$/, "");
  try {
    if (API) localStorage.setItem("asrApiBase", API);
    else localStorage.removeItem("asrApiBase");
  } catch (_) {}
}

async function resolveSessionAudioUrl(sessionOrId) {
  const id = typeof sessionOrId === "string" ? sessionOrId : sessionOrId?.id;
  const hint = typeof sessionOrId === "object" ? sessionOrId?.audio_url : null;
  if (isStandaloneApp() && window.AsrStandalone?.resolveAudioUrl && id) {
    return window.AsrStandalone.resolveAudioUrl(id);
  }
  if (hint && String(hint).startsWith("blob:")) return hint;
  if (hint) return api(hint);
  return api(`/api/sessions/${id}/audio`);
}

async function adminFetch(path, options = {}) {
  if (isStandaloneApp() && window.AsrStandalone?.route) {
    try {
      return await window.AsrStandalone.route(path, options);
    } catch (error) {
      throw new Error(error.message || "Request failed");
    }
  }
  let response;
  try {
    response = await fetch(api(path), {
      credentials: "include",
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers,
      },
    });
  } catch (_) {
    const hint = API || "http://127.0.0.1:8765";
    throw new Error(`Server is offline. Start the API and set the phone server URL (now ${hint}).`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }
  return data;
}

async function apiRequest(path, options = {}) {
  if (isStandaloneApp() && window.AsrStandalone?.route) {
    try {
      return await window.AsrStandalone.route(path, options);
    } catch (error) {
      throw new Error(error.message || "Request failed");
    }
  }
  const response = await fetch(api(path), { credentials: "include", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }
  return data;
}

function bindAdminLogin() {
  const buttons = [...document.querySelectorAll(".login-btn")];
  if (!buttons.length || document.getElementById("login-sheet")) return;

  let admin = false;
  let step = 1;
  const page = document.querySelector(".page");
  const ASR_PRESET = "gpt-4o-transcribe-diarize";
  const LLM_PRESET = "gpt-4o-mini";

  const sheet = document.createElement("div");
  sheet.id = "login-sheet";
  sheet.className = "login-sheet";
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "login-title");
  sheet.innerHTML = `
    <form class="login-card" id="login-form" autocomplete="off">
      <div class="login-steps" aria-hidden="true">
        <span class="login-step-dot is-active" data-dot="1"></span>
        <span class="login-step-dot" data-dot="2"></span>
      </div>
      <div class="login-panels">
        <div class="login-panel is-active" data-step="1">
          <h2 id="login-title">Admin account</h2>
          <p class="login-lead" id="login-lead">Choose a username and password. They are saved on this server.</p>
          <label for="login-username">Username</label>
          <input id="login-username" name="username" type="text" autocomplete="username" required />
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" autocomplete="new-password" required />
        </div>
        <div class="login-panel" data-step="2" hidden>
          <h2>AvalAI connection</h2>
          <p class="login-lead">Step 2 — base URL, token, then type model ids. A green ✓ means it is on AvalAI.</p>
          <label for="setup-base-url">Base URL</label>
          <input id="setup-base-url" type="url" spellcheck="false" value="https://api.avalai.ir/v1" />
          <label for="setup-token">Token</label>
          <input id="setup-token" type="password" autocomplete="off" placeholder="AvalAI API token" />
          <p class="hint" id="setup-token-hint"></p>
          <label for="setup-asr-model">Transcribe model</label>
          <div class="model-pick">
            <input id="setup-asr-model" list="setup-asr-list" spellcheck="false" value="${ASR_PRESET}" />
            <span class="model-check" id="setup-asr-check" hidden title="On AvalAI">✓</span>
          </div>
          <datalist id="setup-asr-list"></datalist>
          <p class="hint" id="setup-asr-hint">Type a model id from AvalAI</p>
          <label for="setup-llm-model">Agent model</label>
          <div class="model-pick">
            <input id="setup-llm-model" list="setup-llm-list" spellcheck="false" value="${LLM_PRESET}" />
            <span class="model-check" id="setup-llm-check" hidden title="On AvalAI">✓</span>
          </div>
          <datalist id="setup-llm-list"></datalist>
          <p class="hint" id="setup-llm-hint">Type a model id from AvalAI</p>
        </div>
      </div>
      <p class="login-error" id="login-error" role="alert" aria-live="polite"></p>
      <div class="login-actions">
        <button class="btn-ghost" type="button" id="login-back" hidden>Back</button>
        <button class="btn-neon sm" type="submit" id="login-submit">Continue</button>
      </div>
    </form>`;
  document.body.appendChild(sheet);

  const form = sheet.querySelector("#login-form");
  const card = form;
  const lead = sheet.querySelector("#login-lead");
  const title = sheet.querySelector("#login-title");
  const username = sheet.querySelector("#login-username");
  const password = sheet.querySelector("#login-password");
  const errorEl = sheet.querySelector("#login-error");
  const backBtn = sheet.querySelector("#login-back");
  const submitBtn = sheet.querySelector("#login-submit");
  const baseInput = sheet.querySelector("#setup-base-url");
  const asrInput = sheet.querySelector("#setup-asr-model");
  const llmInput = sheet.querySelector("#setup-llm-model");
  const asrList = sheet.querySelector("#setup-asr-list");
  const llmList = sheet.querySelector("#setup-llm-list");
  const asrCheck = sheet.querySelector("#setup-asr-check");
  const llmCheck = sheet.querySelector("#setup-llm-check");
  const asrHint = sheet.querySelector("#setup-asr-hint");
  const llmHint = sheet.querySelector("#setup-llm-hint");
  const tokenInput = sheet.querySelector("#setup-token");
  const tokenHint = sheet.querySelector("#setup-token-hint");
  let setupDone = false;
  let setupCatalog = [];
  let setupCatalogTimer = null;

  function paintStep1Copy() {
    if (setupDone) {
      title.textContent = "Admin login";
      lead.textContent = "Enter the username and password you saved earlier.";
      password.autocomplete = "current-password";
      submitBtn.textContent = step === 1 ? "Continue" : "Open app";
    } else {
      title.textContent = "Create admin";
      lead.textContent = isStandaloneApp()
        ? "Pick any username and password. They stay on this phone — next time you log in with them."
        : "Pick any username and password. They are saved here — next time you log in with them.";
      password.autocomplete = "new-password";
      submitBtn.textContent = step === 1 ? "Save & continue" : "Open app";
    }
  }

  function setButtons() {
    buttons.forEach((button) => {
      button.classList.toggle("is-admin", admin);
      button.setAttribute("aria-label", admin ? "Settings" : "Admin");
      button.title = admin ? "Settings" : "Admin";
      // Compact gear icon — fits narrow phone headers
      button.innerHTML = admin
        ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13.2a7.6 7.6 0 0 0 .1-1.2 7.6 7.6 0 0 0-.1-1.2l2-1.6-1.9-3.3-2.4 1a7.4 7.4 0 0 0-2.1-1.2l-.4-2.5H9.4l-.4 2.5a7.4 7.4 0 0 0-2.1 1.2l-2.4-1L2.6 9.2l2 1.6a7.6 7.6 0 0 0-.1 1.2 7.6 7.6 0 0 0 .1 1.2l-2 1.6 1.9 3.3 2.4-1c.64.5 1.35.9 2.1 1.2l.4 2.5h4.2l.4-2.5c.75-.3 1.46-.7 2.1-1.2l2.4 1 1.9-3.3-2-1.6z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`
        : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    });
  }

  function setLocked(locked) {
    if (page) page.classList.toggle("is-locked", locked);
    document.body.classList.toggle("is-admin-locked", locked);
  }

  function isTranscribeModel(id) {
    const name = String(id || "").toLowerCase();
    return /transcribe|whisper|diarize|asr|speech|audio/.test(name);
  }

  function fillSetupLists() {
    const asrIds = setupCatalog.filter(isTranscribeModel);
    const llmIds = setupCatalog.filter((id) => !isTranscribeModel(id));
    const asrOpts = asrIds.length ? asrIds : setupCatalog;
    const llmOpts = llmIds.length ? llmIds : setupCatalog;
    asrList.innerHTML = asrOpts.map((id) => `<option value="${id.replace(/"/g, "&quot;")}"></option>`).join("");
    llmList.innerHTML = llmOpts.map((id) => `<option value="${id.replace(/"/g, "&quot;")}"></option>`).join("");
    validateSetupModel(asrInput, asrCheck, asrHint);
    validateSetupModel(llmInput, llmCheck, llmHint);
  }

  function validateSetupModel(input, checkEl, hintEl) {
    const value = (input.value || "").trim();
    if (!value) {
      checkEl.hidden = true;
      hintEl.textContent = "Type a model id from AvalAI";
      hintEl.classList.remove("is-bad");
      return false;
    }
    if (!setupCatalog.length) {
      checkEl.hidden = true;
      hintEl.textContent = "Paste token first to load AvalAI models";
      hintEl.classList.add("is-bad");
      return false;
    }
    const found = setupCatalog.some((id) => id.toLowerCase() === value.toLowerCase());
    checkEl.hidden = !found;
    hintEl.textContent = found ? "Present on AvalAI" : "Not in AvalAI catalog";
    hintEl.classList.toggle("is-bad", !found);
    return found;
  }

  async function loadSetupCatalog() {
    const params = new URLSearchParams();
    if (baseInput.value.trim()) params.set("base_url", baseInput.value.trim());
    if (tokenInput.value.trim()) params.set("api_token", tokenInput.value.trim());
    const query = params.toString() ? `?${params}` : "";
    try {
      const data = await adminFetch(`/api/admin/models${query}`);
      setupCatalog = Array.isArray(data.models) ? data.models : [];
      fillSetupLists();
    } catch (error) {
      setupCatalog = [];
      fillSetupLists();
      asrHint.textContent = error.message || "Could not load AvalAI models";
      llmHint.textContent = asrHint.textContent;
      asrHint.classList.add("is-bad");
      llmHint.classList.add("is-bad");
    }
  }

  function scheduleSetupCatalog() {
    clearTimeout(setupCatalogTimer);
    setupCatalogTimer = setTimeout(loadSetupCatalog, 400);
  }

  function showStep(next) {
    step = next;
    sheet.querySelectorAll(".login-panel").forEach((panel) => {
      const on = Number(panel.dataset.step) === step;
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
    sheet.querySelectorAll(".login-step-dot").forEach((dot) => {
      dot.classList.toggle("is-active", Number(dot.dataset.dot) <= step);
      dot.classList.toggle("is-current", Number(dot.dataset.dot) === step);
    });
    backBtn.hidden = step === 1;
    paintStep1Copy();
    if (step === 2) submitBtn.textContent = "Open app";
    errorEl.textContent = "";
    card.classList.remove("is-shake");
    requestAnimationFrame(() => {
      if (step === 1) username.focus();
      else baseInput.focus();
    });
  }

  async function refreshSetupFlag() {
    try {
      const status = await adminFetch("/api/admin/status");
      setupDone = Boolean(status.setup_done);
    } catch (_) {
      setupDone = false;
    }
    paintStep1Copy();
  }

  function openSheet() {
    errorEl.textContent = "";
    username.value = "";
    password.value = "";
    tokenInput.value = "";
    refreshSetupFlag().finally(() => {
      showStep(1);
      sheet.hidden = false;
      requestAnimationFrame(() => sheet.classList.add("is-open"));
    });
  }

  function closeSheet() {
    if (!admin) {
      openSheet();
      return;
    }
    if (sheet.hidden) return;
    sheet.classList.remove("is-open");
    window.setTimeout(() => {
      if (!sheet.classList.contains("is-open")) sheet.hidden = true;
    }, 300);
  }

  function shake(message) {
    errorEl.textContent = message || "Wrong username or password";
    card.classList.remove("is-shake");
    void card.offsetWidth;
    card.classList.add("is-shake");
  }

  function applyAdminState(next) {
    admin = Boolean(next);
    setButtons();
    setLocked(!admin);
    if (admin) {
      sheet.classList.remove("is-open");
      sheet.hidden = true;
    } else {
      openSheet();
    }
    document.dispatchEvent(new CustomEvent("admin:change", { detail: { admin, fromLogin: true } }));
  }

  async function fillSetupFromServer() {
    const data = await adminFetch("/api/admin/settings");
    baseInput.value = data.base_url || "https://api.avalai.ir/v1";
    asrInput.value = data.asr_model || ASR_PRESET;
    llmInput.value = data.llm_model || LLM_PRESET;
    tokenInput.value = "";
    tokenHint.textContent = data.has_token
      ? `Saved token ${data.token_hint || ""}`.trim()
      : "Paste your AvalAI token";
    await loadSetupCatalog();
  }

  async function refreshAdmin() {
    await refreshSetupFlag();
    try {
      await adminFetch("/api/admin/settings");
      applyAdminState(true);
    } catch (_) {
      applyAdminState(false);
    }
  }

  asrInput.addEventListener("input", () => validateSetupModel(asrInput, asrCheck, asrHint));
  llmInput.addEventListener("input", () => validateSetupModel(llmInput, llmCheck, llmHint));
  baseInput.addEventListener("change", scheduleSetupCatalog);
  tokenInput.addEventListener("input", scheduleSetupCatalog);
  tokenInput.addEventListener("change", scheduleSetupCatalog);

  backBtn.addEventListener("click", () => showStep(1));

  buttons.forEach((button) => {
    button.addEventListener("click", async () => {
      if (admin) {
        document.dispatchEvent(new CustomEvent("admin:open-settings"));
        return;
      }
      openSheet();
    });
  });

  sheet.addEventListener("click", (event) => {
    if (event.target === sheet && admin) closeSheet();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sheet.classList.contains("is-open") && admin) closeSheet();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.textContent = "";
    submitBtn.disabled = true;
    backBtn.disabled = true;
    try {
      if (step === 1) {
        const result = await adminFetch("/api/admin/login", {
          method: "POST",
          body: JSON.stringify({
            username: username.value.trim(),
            password: password.value,
          }),
        });
        setupDone = true;
        paintStep1Copy();
        await fillSetupFromServer();
        card.classList.add("is-swap");
        showStep(2);
        window.setTimeout(() => card.classList.remove("is-swap"), 360);
        if (result.created) {
          errorEl.textContent = "";
        }
      } else {
        const asr = (asrInput.value || "").trim() || ASR_PRESET;
        const llm = (llmInput.value || "").trim() || LLM_PRESET;
        if (setupCatalog.length) {
          const asrOk = setupCatalog.some((id) => id.toLowerCase() === asr.toLowerCase());
          const llmOk = setupCatalog.some((id) => id.toLowerCase() === llm.toLowerCase());
          if (!asrOk || !llmOk) {
            shake("Pick models that show a green ✓ (from AvalAI)");
            validateSetupModel(asrInput, asrCheck, asrHint);
            validateSetupModel(llmInput, llmCheck, llmHint);
            return;
          }
        }
        const payload = {
          base_url: baseInput.value.trim(),
          asr_model: asr,
          llm_model: llm,
        };
        if (tokenInput.value.trim()) payload.api_token = tokenInput.value.trim();
        await adminFetch("/api/admin/settings", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        applyAdminState(true);
      }
    } catch (error) {
      shake(error.message || "Could not continue");
    } finally {
      submitBtn.disabled = false;
      backBtn.disabled = false;
    }
  });

  document.addEventListener("admin:change", (event) => {
    if (event.detail?.fromLogin) return;
    const next = Boolean(event.detail?.admin);
    if (next === admin) return;
    admin = next;
    setButtons();
    setLocked(!admin);
    if (admin) {
      sheet.classList.remove("is-open");
      sheet.hidden = true;
    } else {
      openSheet();
    }
  });

  setButtons();
  setLocked(true);
  refreshAdmin();
}

bindAdminLogin();

function bindAdminLens() {
  if (document.getElementById("admin-lens")) return;

  const ASR_DEFAULT = "gpt-4o-transcribe-diarize";
  const LLM_DEFAULT = "gpt-4o-mini";
  const POS_KEY = "asrAdminLensPos";
  const COLLAPSE_KEY = "asrAdminLensCollapsed";

  const lens = document.createElement("aside");
  lens.id = "admin-lens";
  lens.className = "admin-lens";
  lens.hidden = true;
  lens.innerHTML = `
    <div class="admin-lens-bar" id="admin-lens-bar">
      <span class="admin-lens-dot" aria-hidden="true"></span>
      <span class="admin-lens-title">Settings</span>
      <button type="button" id="admin-collapse" aria-label="Collapse">–</button>
      <button type="button" id="admin-logout-lens" aria-label="Log out">×</button>
    </div>
    <form class="admin-lens-body" id="admin-form">
      <div class="admin-field" id="admin-server-field">
        <label for="admin-server-url">App server</label>
        <input id="admin-server-url" type="url" spellcheck="false" placeholder="http://192.168.1.10:8765" />
        <p class="hint">Phone/emulator URL for this FastAPI server</p>
      </div>
      <div class="admin-field">
        <label for="admin-base-url">AvalAI base URL</label>
        <input id="admin-base-url" name="base_url" type="url" spellcheck="false" />
      </div>
      <div class="admin-field">
        <label for="admin-token">Token</label>
        <input id="admin-token" name="api_token" type="password" autocomplete="off" placeholder="Leave blank to keep saved" />
        <p class="hint" id="admin-token-hint"></p>
      </div>
      <div class="admin-field">
        <label for="admin-asr-model">ASR model</label>
        <div class="model-pick">
          <input id="admin-asr-model" name="asr_model" list="admin-asr-list" spellcheck="false" placeholder="${ASR_DEFAULT}" />
          <span class="model-check" id="admin-asr-check" hidden title="On AvalAI">✓</span>
        </div>
        <datalist id="admin-asr-list"></datalist>
        <p class="hint" id="admin-asr-hint">Type a model id from AvalAI</p>
      </div>
      <div class="admin-field">
        <label for="admin-llm-model">LLM model</label>
        <div class="model-pick">
          <input id="admin-llm-model" name="llm_model" list="admin-llm-list" spellcheck="false" placeholder="${LLM_DEFAULT}" />
          <span class="model-check" id="admin-llm-check" hidden title="On AvalAI">✓</span>
        </div>
        <datalist id="admin-llm-list"></datalist>
        <p class="hint" id="admin-llm-hint">Type a model id from AvalAI</p>
      </div>
      <div class="admin-lens-actions">
        <button class="btn-neon sm" type="submit">Save</button>
        <button class="btn-ghost" type="button" id="admin-hide">Hide</button>
      </div>
      <p class="admin-lens-status" id="admin-status" aria-live="polite"></p>
    </form>`;
  document.body.appendChild(lens);

  const form = lens.querySelector("#admin-form");
  const serverField = lens.querySelector("#admin-server-field");
  const serverInput = lens.querySelector("#admin-server-url");
  const baseInput = lens.querySelector("#admin-base-url");
  const asrInput = lens.querySelector("#admin-asr-model");
  const llmInput = lens.querySelector("#admin-llm-model");
  const asrList = lens.querySelector("#admin-asr-list");
  const llmList = lens.querySelector("#admin-llm-list");
  const asrCheck = lens.querySelector("#admin-asr-check");
  const llmCheck = lens.querySelector("#admin-llm-check");
  const asrHint = lens.querySelector("#admin-asr-hint");
  const llmHint = lens.querySelector("#admin-llm-hint");
  const tokenInput = lens.querySelector("#admin-token");
  const tokenHint = lens.querySelector("#admin-token-hint");
  const statusEl = lens.querySelector("#admin-status");
  const collapseBtn = lens.querySelector("#admin-collapse");
  const logoutBtn = lens.querySelector("#admin-logout-lens");
  const hideBtn = lens.querySelector("#admin-hide");
  const bar = lens.querySelector("#admin-lens-bar");

  if (isStandaloneApp() && serverField) serverField.hidden = true;

  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let catalog = [];
  let catalogTimer = null;

  function isTranscribeModel(id) {
    const name = String(id || "").toLowerCase();
    return /transcribe|whisper|diarize|asr|speech|audio/.test(name);
  }

  function fillDatalist(listEl, ids) {
    listEl.innerHTML = ids.map((id) => `<option value="${id.replace(/"/g, "&quot;")}"></option>`).join("");
  }

  function paintCatalog() {
    const asrIds = catalog.filter(isTranscribeModel);
    const llmIds = catalog.filter((id) => !isTranscribeModel(id));
    fillDatalist(asrList, asrIds.length ? asrIds : catalog);
    fillDatalist(llmList, llmIds.length ? llmIds : catalog);
    validateModel(asrInput, asrCheck, asrHint, true);
    validateModel(llmInput, llmCheck, llmHint, false);
  }

  function validateModel(input, checkEl, hintEl, asr) {
    const value = (input.value || "").trim();
    if (!value) {
      checkEl.hidden = true;
      hintEl.textContent = catalog.length
        ? "Type a model id from AvalAI"
        : "Save a token, then models load from AvalAI";
      hintEl.classList.remove("is-bad");
      return false;
    }
    if (!catalog.length) {
      checkEl.hidden = true;
      hintEl.textContent = "Catalog not loaded yet — save token / check base URL";
      hintEl.classList.add("is-bad");
      return false;
    }
    const found = catalog.some((id) => id.toLowerCase() === value.toLowerCase());
    checkEl.hidden = !found;
    if (found) {
      hintEl.textContent = "Present on AvalAI";
      hintEl.classList.remove("is-bad");
    } else {
      hintEl.textContent = asr
        ? "Not in AvalAI catalog — pick a listed transcribe model"
        : "Not in AvalAI catalog — pick a listed chat model";
      hintEl.classList.add("is-bad");
    }
    return found;
  }

  async function loadCatalog() {
    const params = new URLSearchParams();
    if (baseInput.value.trim()) params.set("base_url", baseInput.value.trim());
    if (tokenInput.value.trim()) params.set("api_token", tokenInput.value.trim());
    const query = params.toString() ? `?${params}` : "";
    try {
      const data = await adminFetch(`/api/admin/models${query}`);
      catalog = Array.isArray(data.models) ? data.models : [];
      paintCatalog();
      if (!catalog.length) {
        asrHint.textContent = "No models returned from AvalAI";
        llmHint.textContent = "No models returned from AvalAI";
      }
    } catch (error) {
      catalog = [];
      paintCatalog();
      asrHint.textContent = error.message || "Could not load AvalAI models";
      llmHint.textContent = asrHint.textContent;
      asrHint.classList.add("is-bad");
      llmHint.classList.add("is-bad");
    }
  }

  function scheduleCatalog() {
    clearTimeout(catalogTimer);
    catalogTimer = setTimeout(loadCatalog, 450);
  }

  function placeLens(left, top) {
    const width = lens.offsetWidth || 320;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - 48);
    const x = Math.min(Math.max(8, left), maxLeft);
    const y = Math.min(Math.max(8, top), maxTop);
    lens.style.left = `${x}px`;
    lens.style.top = `${y}px`;
    lens.style.right = "auto";
    lens.style.bottom = "auto";
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ left: x, top: y }));
    } catch (_) {}
  }

  function restoreLensPos() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    } catch (_) {}
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      placeLens(saved.left, saved.top);
    } else {
      placeLens(window.innerWidth - 352, 96);
    }
  }

  function paintSettings(data) {
    serverInput.value = API || "";
    baseInput.value = data.base_url || "https://api.avalai.ir/v1";
    asrInput.value = data.asr_model || ASR_DEFAULT;
    llmInput.value = data.llm_model || LLM_DEFAULT;
    tokenInput.value = "";
    tokenHint.textContent = data.has_token
      ? `Saved token ${data.token_hint || ""}`.trim()
      : "No token saved yet";
    statusEl.textContent = "";
    validateModel(asrInput, asrCheck, asrHint, true);
    validateModel(llmInput, llmCheck, llmHint, false);
  }

  function applyCollapse(collapsed) {
    lens.classList.toggle("is-collapsed", collapsed);
    collapseBtn.textContent = collapsed ? "+" : "–";
    collapseBtn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch (_) {}
  }

  async function showLens() {
    try {
      const data = await adminFetch("/api/admin/settings");
      paintSettings(data);
      lens.hidden = false;
      let collapsed = false;
      try {
        collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
      } catch (_) {}
      applyCollapse(collapsed);
      restoreLensPos();
      loadCatalog();
    } catch (_) {
      lens.hidden = true;
    }
  }

  function hideLens() {
    lens.hidden = true;
    lens.classList.remove("is-dragging");
  }

  document.addEventListener("admin:change", (event) => {
    if (!event.detail?.admin) hideLens();
  });

  document.addEventListener("admin:open-settings", () => {
    showLens();
  });

  asrInput.addEventListener("input", () => validateModel(asrInput, asrCheck, asrHint, true));
  llmInput.addEventListener("input", () => validateModel(llmInput, llmCheck, llmHint, false));
  baseInput.addEventListener("change", scheduleCatalog);
  tokenInput.addEventListener("change", scheduleCatalog);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const asr = (asrInput.value || "").trim() || ASR_DEFAULT;
    const llm = (llmInput.value || "").trim() || LLM_DEFAULT;
    if (catalog.length) {
      const asrOk = catalog.some((id) => id.toLowerCase() === asr.toLowerCase());
      const llmOk = catalog.some((id) => id.toLowerCase() === llm.toLowerCase());
      if (!asrOk || !llmOk) {
        statusEl.textContent = "Choose models that exist on AvalAI (green ✓)";
        validateModel(asrInput, asrCheck, asrHint, true);
        validateModel(llmInput, llmCheck, llmHint, false);
        return;
      }
    }
    statusEl.textContent = "Saving…";
    if (!isStandaloneApp() && serverInput.value.trim()) setApiBase(serverInput.value.trim());
    const payload = {
      base_url: baseInput.value.trim(),
      asr_model: asr,
      llm_model: llm,
    };
    if (tokenInput.value.trim()) payload.api_token = tokenInput.value.trim();
    try {
      const data = await adminFetch("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      paintSettings(data);
      await loadCatalog();
      statusEl.textContent = "Saved";
      setTimeout(() => {
        if (statusEl.textContent === "Saved") statusEl.textContent = "";
      }, 1800);
    } catch (error) {
      statusEl.textContent = error.message || "Save failed";
    }
  });

  collapseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    applyCollapse(!lens.classList.contains("is-collapsed"));
  });

  hideBtn.addEventListener("click", () => {
    lens.hidden = true;
  });

  logoutBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await adminFetch("/api/admin/logout", { method: "POST", body: "{}" });
    } catch (_) {}
    hideLens();
    document.dispatchEvent(new CustomEvent("admin:change", { detail: { admin: false } }));
  });

  bar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    dragging = true;
    lens.classList.add("is-dragging");
    const rect = lens.getBoundingClientRect();
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    bar.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  window.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    placeLens(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
  });

  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    lens.classList.remove("is-dragging");
  });
}

bindAdminLens();

function bindFilters() {
  const row = document.getElementById("filters");
  if (!row || row.dataset.bound) return;
  row.dataset.bound = "1";
  row.addEventListener("click", (event) => {
    const pill = event.target.closest(".filter-pill");
    if (!pill) return;
    row.querySelectorAll(".filter-pill").forEach((item) => item.classList.remove("active"));
    pill.classList.add("active");
    const speaker = pill.dataset.speaker;
    if (!speaker) return;
    document.querySelectorAll(".seg[data-speaker], .turn[data-speaker]").forEach((el) => {
      el.style.display = speaker === "all" || el.dataset.speaker === speaker ? "" : "none";
    });
  });
}

bindFilters();

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file");
if (dropzone && fileInput) {
  const kicker = document.getElementById("drop-kicker");
  const fileName = document.getElementById("file-name");
  const hint = document.getElementById("drop-hint");
  const track = document.getElementById("progress-track");
  let busy = false;

  const phrases = [
    "Catching the recording",
    "Separating the voices",
    "Writing the transcript",
  ];

  function base64ToFile(b64, name, mimeType) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || "audio.mp3", { type: mimeType || "audio/mpeg" });
  }

  function getAudioPicker() {
    if (!window.Capacitor) return null;
    try {
      if (typeof window.Capacitor.registerPlugin === "function") {
        return window.Capacitor.registerPlugin("AudioPicker");
      }
    } catch (_) {}
    return window.Capacitor.Plugins?.AudioPicker || null;
  }

  function resultToFile(result) {
    if (!result?.data) throw new Error("No file data returned");
    return base64ToFile(result.data, result.name, result.mimeType);
  }

  function openCapacitorAudioSheet() {
    return new Promise((resolve, reject) => {
      const picker = getAudioPicker();
      if (!picker?.loadDemo) {
        reject(new Error("AudioPicker plugin missing — reinstall the APK"));
        return;
      }

      let sheet = document.getElementById("cap-audio-sheet");
      if (sheet) sheet.remove();
      sheet = document.createElement("div");
      sheet.id = "cap-audio-sheet";
      sheet.className = "cap-audio-sheet";
      sheet.innerHTML = `
        <div class="cap-audio-card" role="dialog" aria-modal="true" aria-label="Choose audio">
          <h3>Choose audio</h3>
          <p class="cap-audio-lead">Stays inside the app — no Files screen (that was closing the app).</p>
          <button type="button" class="btn-neon" data-act="demo">Use demo class (1 min)</button>
          <div class="cap-audio-list" id="cap-audio-list"><p class="hint">Looking in Downloads…</p></div>
          <button type="button" class="btn-ghost" data-act="cancel">Cancel</button>
        </div>`;
      document.body.appendChild(sheet);
      requestAnimationFrame(() => sheet.classList.add("is-open"));

      const listEl = sheet.querySelector("#cap-audio-list");
      const finish = (fn) => {
        sheet.classList.remove("is-open");
        setTimeout(() => sheet.remove(), 200);
        fn();
      };

      sheet.addEventListener("click", async (event) => {
        const target = event.target.closest("[data-act], [data-file]");
        if (!target) {
          if (event.target === sheet) finish(() => reject(new Error("cancelled")));
          return;
        }
        const act = target.getAttribute("data-act");
        if (act === "cancel") {
          finish(() => reject(new Error("cancelled")));
          return;
        }
        try {
          if (act === "demo") {
            const result = await picker.loadDemo();
            finish(() => resolve(resultToFile(result)));
            return;
          }
          const name = target.getAttribute("data-file");
          if (name) {
            const result = await picker.loadDownload({ name });
            finish(() => resolve(resultToFile(result)));
          }
        } catch (error) {
          finish(() => reject(error));
        }
      });

      picker
        .listDownloads()
        .then((data) => {
          const files = Array.isArray(data?.files) ? data.files : [];
          if (!files.length) {
            listEl.innerHTML = `<p class="hint">No other audio in Downloads. Use the demo button above.</p>`;
            return;
          }
          listEl.innerHTML = files
            .map((f) => {
              const kb = Math.max(1, Math.round((Number(f.size) || 0) / 1024));
              const safe = String(f.name || "").replace(/"/g, "&quot;");
              return `<button type="button" class="cap-audio-item" data-file="${safe}">${safe}<span>${kb} KB</span></button>`;
            })
            .join("");
        })
        .catch(() => {
          listEl.innerHTML = `<p class="hint">Could not list Downloads. Use the demo button.</p>`;
        });
    });
  }

  dropzone.addEventListener("click", async () => {
    if (busy || dropzone.classList.contains("is-done")) return;
    // Never use HTML <input type=file> or Android Files UI on Capacitor —
    // both were closing the WebView activity.
    if (window.Capacitor) {
      try {
        const file = await openCapacitorAudioSheet();
        if (file) begin(file);
      } catch (error) {
        const msg = String(error?.message || error || "");
        if (msg.includes("cancelled") || msg.includes("Cancel")) return;
        hint.textContent = msg || "Could not load audio";
        dropzone.classList.add("is-error");
      }
      return;
    }
    fileInput.click();
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (event) => {
      event.preventDefault();
      if (!busy) dropzone.classList.add("is-over");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-over");
    });
  });

  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) begin(file);
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) begin(fileInput.files[0]);
  });

  async function begin(file) {
    if (busy) return;
    busy = true;
    dropzone.classList.remove("is-error", "is-done");
    dropzone.classList.add("is-loading");
    fileName.textContent = file.name;
    hint.textContent = "Hold on. Nothing else to press.";
    track.hidden = false;
    let step = 0;
    kicker.textContent = phrases[0];
    const timer = setInterval(() => {
      step = (step + 1) % phrases.length;
      if (dropzone.classList.contains("is-loading")) kicker.textContent = phrases[step];
    }, 2200);

    try {
      const body = new FormData();
      body.append("file", file);
      const created = await apiRequest("/api/sessions", { method: "POST", body });
      const session = await waitUntilDone(created.id, (stage) => {
        if (stage) kicker.textContent = stage;
      });
      clearInterval(timer);
      dropzone.classList.remove("is-loading");
      dropzone.classList.add("is-done");
      track.hidden = true;
      kicker.textContent = "Saved";
      const speakers = new Set((session.segments || []).map((segment) => segment.speaker));
      fileName.textContent = file.name;
      const where = isStandaloneApp() ? "Saved on this phone" : "Voice is in MinIO. Transcript JSON is stored";
      hint.textContent = `${where}${speakers.size ? ` · ${speakers.size} speakers` : ""}.`;
    } catch (error) {
      clearInterval(timer);
      dropzone.classList.remove("is-loading");
      dropzone.classList.add("is-error");
      track.hidden = true;
      kicker.textContent = "Could not save";
      hint.textContent = error.message || "Try the drop again.";
      busy = false;
    }
  }

  async function waitUntilDone(id, onStage) {
    for (;;) {
      const session = await apiRequest(`/api/sessions/${id}`);
      if (session.stage) onStage(session.stage);
      if (session.status === "parsed") return session;
      if (session.status === "error") throw new Error(session.error || "Transcription failed");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

function updateSelectionCount() {
  const checks = document.querySelectorAll(".seg-check");
  const countEl = document.getElementById("sel-count");
  if (!countEl) return;
  const n = [...checks].filter((c) => c.checked).length;
  countEl.textContent = `${n} selected`;
}

function bindSelection() {
  document.querySelectorAll(".seg-check").forEach((c) => {
    c.addEventListener("change", () => {
      updateSelectionCount();
      const selected = [...document.querySelectorAll(".seg.selectable")]
        .filter((seg) => seg.querySelector(".seg-check")?.checked)
        .map((seg) => ({
          speaker: seg.dataset.speaker,
          time: seg.querySelector(".seg-time")?.textContent,
          text: seg.querySelector(".seg-text")?.textContent,
        }));
      try {
        sessionStorage.setItem("asrSelectedSections", JSON.stringify(selected));
      } catch (_) {}
    });
  });
  updateSelectionCount();
}

bindSelection();

const voicePicker = document.getElementById("voice-picker");
if (voicePicker) {
  const thread = document.getElementById("thread");
  const segList = document.getElementById("seg-list");
  const filters = document.getElementById("filters");
  const meta = document.getElementById("voice-meta");
  const talk = document.getElementById("talk-agent");
  const send = document.getElementById("send-agent");
  let sessions = [];
  let current = null;
  let player = null;
  let clipEnd = null;
  let activeId = null;

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clock(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const mins = Math.floor(total / 60);
    const secs = Math.floor(total % 60);
    const tenth = Math.floor((total % 1) * 10);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenth}`;
  }

  function durationLabel(seconds) {
    const total = Math.round(Number(seconds) || 0);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  function speakerClass(letter) {
    const index = String(letter || "A").toUpperCase().charCodeAt(0) - 65;
    return index === 1 ? "sp-b" : index === 2 ? "sp-c" : "sp-a";
  }

  function setActive(id) {
    activeId = id;
    document.querySelectorAll(".seg-play, .turn-play").forEach((button) => {
      const on = button.dataset.id === id;
      button.classList.toggle("is-playing", on);
      button.textContent = on ? "II" : "▶";
      button.setAttribute("aria-label", on ? "Pause this part" : "Play this part");
    });
  }

  function ensurePlayer(url) {
    if (!player || player.dataset.src !== url) {
      player = new Audio(url);
      player.dataset.src = url;
      player.preload = "auto";
      player.addEventListener("timeupdate", () => {
        if (clipEnd != null && player.currentTime >= clipEnd - 0.03) {
          player.pause();
          clipEnd = null;
          setActive(null);
        }
      });
    }
    return player;
  }

  async function playSlice(id, start, end) {
    if (!current?.audio_url && !current?.id) return;
    let url;
    try {
      url = await resolveSessionAudioUrl(current);
    } catch (_) {
      return;
    }
    const audio = ensurePlayer(url);
    if (activeId === id && !audio.paused) {
      audio.pause();
      clipEnd = null;
      setActive(null);
      return;
    }
    clipEnd = Number(end);
    setActive(id);
    const startAt = Number(start);
    const go = () => {
      if (Math.abs(audio.currentTime - startAt) < 0.08) {
        audio.play();
        return;
      }
      const onSeeked = () => {
        audio.removeEventListener("seeked", onSeeked);
        audio.play();
      };
      audio.addEventListener("seeked", onSeeked);
      audio.currentTime = startAt;
    };
    if (audio.readyState >= 1) go();
    else audio.addEventListener("loadedmetadata", go, { once: true });
  }

  function speakerCount(session) {
    return session.speakers?.length || new Set((session.segments || []).map((segment) => segment.speaker)).size;
  }

  function when(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function choose(session) {
    current = session;
    if (player) player.pause();
    clipEnd = null;
    setActive(null);
    voicePicker.querySelectorAll(".voice-card").forEach((card) => {
      card.classList.toggle("is-selected", card.dataset.id === session.id);
    });
    const count = speakerCount(session);
    if (meta) meta.textContent = `${session.filename} · ${durationLabel(session.duration)} · ${count} speaker${count === 1 ? "" : "s"}`;
    closePopup();
    const href = `agent.html?id=${session.id}`;
    if (talk) {
      talk.href = href;
      talk.classList.add("is-ready");
    }
    if (send) send.href = href;
    try {
      sessionStorage.setItem("asrSessionId", session.id);
    } catch (_) {}
    const navAgent = document.querySelector('nav a[href="agent.html"], nav a[href^="agent.html?"]');
    if (navAgent) navAgent.href = href;
    render(session);
    history.replaceState(null, "", `parser.html?id=${session.id}`);
  }

  function render(session) {
    current = session;
    const speakers = session.speakers?.length
      ? session.speakers
      : [...new Set((session.segments || []).map((segment) => segment.speaker))];
    filters.innerHTML = `<button class="filter-pill active" type="button" data-speaker="all">All speakers</button>` +
      speakers
        .map(
          (letter) =>
            `<button class="filter-pill" type="button" data-speaker="${esc(letter)}"><span class="speaker-chip ${speakerClass(letter)}"></span> Speaker ${esc(letter)}</button>`
        )
        .join("") +
      `<button class="filter-pill" type="button">Low confidence</button>`;
    thread.innerHTML = (session.segments || [])
      .map(
        (segment) => `
        <p class="turn" data-speaker="${esc(segment.speaker)}">
          <span class="turn-label ${speakerClass(segment.speaker)}">${esc(segment.speaker)}</span>
          <span class="turn-body">${esc(segment.text)}</span>
        </p>`
      )
      .join("");
    segList.innerHTML = (session.segments || [])
      .map(
        (segment) => `
        <label class="seg selectable" data-speaker="${esc(segment.speaker)}">
          <input type="checkbox" class="seg-check" />
          <span class="seg-time">${clock(segment.start)}</span>
          <span class="seg-speaker ${speakerClass(segment.speaker)}">${esc(segment.speaker)}</span>
          <span class="seg-text">${esc(segment.text)}</span>
          <button class="seg-play" type="button" data-id="${esc(segment.id)}" data-start="${segment.start}" data-end="${segment.end}" aria-label="Play this part">▶</button>
        </label>`
      )
      .join("");
    bindSelection();
    document.querySelectorAll(".seg-play, .turn-play").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        playSlice(button.dataset.id, button.dataset.start, button.dataset.end);
      });
    });
  }

  const libraryToggle = document.getElementById("library-toggle");
  const libraryPopup = document.getElementById("library-popup");
  const librarySearch = document.getElementById("library-search");

  function closePopup() {
    if (!libraryPopup) return;
    libraryPopup.hidden = true;
    libraryToggle?.setAttribute("aria-expanded", "false");
  }

  function paintCards(query) {
    const q = query.trim().toLowerCase();
    const list = sessions.filter((session) => {
      const letters = (session.speakers || []).join(" ");
      const line = `${session.filename} ${durationLabel(session.duration)} ${letters} ${when(session.created_at)}`.toLowerCase();
      return !q || line.includes(q);
    });
    voicePicker.innerHTML = list.length
      ? list
          .map((session) => {
            const letters = (session.speakers || []).join(" ");
            const on = current && current.id === session.id ? " is-selected" : "";
            return `<button class="voice-card${on}" type="button" data-id="${esc(session.id)}">
              <strong>${esc(session.filename)}</strong>
              <span>${durationLabel(session.duration)} · ${esc(letters || "—")} · ${esc(when(session.created_at))}</span>
            </button>`;
          })
          .join("")
      : `<p class="select-hint">No recording matches.</p>`;
  }

  function openPopup() {
    if (!libraryPopup) return;
    libraryPopup.hidden = false;
    libraryToggle?.setAttribute("aria-expanded", "true");
    if (librarySearch) {
      librarySearch.value = "";
      paintCards("");
      librarySearch.focus();
    }
  }

  libraryToggle?.addEventListener("click", () => openPopup());
  libraryPopup?.addEventListener("click", (event) => {
    if (event.target === libraryPopup) closePopup();
  });
  librarySearch?.addEventListener("input", () => paintCards(librarySearch.value));
  voicePicker.addEventListener("click", (event) => {
    const card = event.target.closest(".voice-card");
    if (!card) return;
    const session = sessions.find((item) => item.id === card.dataset.id);
    if (session) choose(session);
  });

  async function loadSessions() {
    try {
      const data = await apiRequest("/api/sessions");
      sessions = Array.isArray(data) ? data : [];
      if (!sessions.length) {
        thread.textContent = "No saved recording yet";
        return;
      }
      const wanted = new URLSearchParams(location.search).get("id");
      const chosen = sessions.find((session) => session.id === wanted) || sessions[0];
      choose(chosen);
    } catch (error) {
      thread.textContent = error.message || "Could not load saved recordings";
    }
  }

  document.addEventListener("admin:change", (event) => {
    if (event.detail?.admin) loadSessions();
  });
}

const evalRoot = document.getElementById("eval-root");
if (evalRoot) {
  const lead = document.getElementById("eval-lead");

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clock(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const mins = Math.floor(total / 60);
    const secs = Math.floor(total % 60);
    const tenth = Math.floor((total % 1) * 10);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenth}`;
  }

  function bars() {
    return `<span class="chunk-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;
  }

  function items(list, side, empty) {
    if (!list?.length) return `<p class="select-hint">${empty}</p>`;
    return list
      .map((item, index) => {
        const id = `${side}-${index}`;
        return `<article class="chunk-card" data-card="${id}">
          <div class="chunk-top">
            <button class="seg-play" type="button" data-id="${id}" data-start="${item.start}" data-end="${item.end}" aria-label="Play this chunk">▶</button>
            ${bars()}
            <span class="chunk-time">${clock(item.start)} – ${clock(item.end)}</span>
            <span class="chunk-tag">${esc(item.point || "Chunk")}</span>
          </div>
          <q class="chunk-quote">${esc(item.phrase)}</q>
          <p class="chunk-reason">${esc(item.reason || "")}</p>
          <button class="phrase-copy" type="button" data-phrase="${esc(item.phrase)}">Copy phrase</button>
        </article>`;
      })
      .join("");
  }

  function show(review) {
    const teacher = review.teacher || {};
    const who = [teacher.name, teacher.speaker ? `speaker ${teacher.speaker}` : ""].filter(Boolean).join(" · ");
    const verdict = review.verdict === "good" ? "Teacher is good" : review.verdict === "weak" ? "Teacher needs work" : "Teacher is mixed";
    if (lead) lead.textContent = `${review.filename || "This class"}${who ? " · " + who : ""}`;
    evalRoot.className = "";
    evalRoot.innerHTML = `
      <section class="eval-stage">
        <div>
          <p class="eval-kicker">English class · ASR chunks</p>
          <h2>${esc(verdict)}</h2>
          <p class="eval-summary">${esc(review.summary || "")}</p>
        </div>
        <div class="eval-pills">
          <span>gpt-4o-mini</span>
          <span>chunk by chunk</span>
          <span>${review.cached ? "saved review" : "new review"}</span>
        </div>
      </section>
      <div class="eval-layout">
        <section class="panel eval-column eval-good">
          <div class="panel-head"><h2 class="panel-title">What worked</h2></div>
          ${items(review.good, "good", "No strong chunks were tied to the teacher.")}
        </section>
        <section class="panel eval-column eval-bad">
          <div class="panel-head"><h2 class="panel-title">Needs work</h2></div>
          ${items(review.bad, "bad", "No problem chunks were tied to the teacher.")}
        </section>
      </div>`;

    let player = null;
    let clipEnd = null;
    let activeId = null;
    let audioUrlPromise = resolveSessionAudioUrl(sessionId);

    function setActive(id) {
      activeId = id;
      evalRoot.querySelectorAll(".chunk-card").forEach((card) => {
        card.classList.toggle("is-live", card.dataset.card === id);
      });
      evalRoot.querySelectorAll(".seg-play").forEach((button) => {
        const on = button.dataset.id === id;
        button.classList.toggle("is-playing", on);
        button.textContent = on ? "II" : "▶";
      });
    }

    async function playSlice(id, start, end) {
      if (!player) {
        let audioUrl;
        try {
          audioUrl = await audioUrlPromise;
        } catch (_) {
          return;
        }
        player = new Audio(audioUrl);
        evalRoot._player = player;
        player.preload = "auto";
        player.addEventListener("timeupdate", () => {
          if (clipEnd != null && player.currentTime >= clipEnd - 0.03) {
            player.pause();
            clipEnd = null;
            setActive(null);
          }
        });
      }
      if (activeId === id && !player.paused) {
        player.pause();
        clipEnd = null;
        setActive(null);
        return;
      }
      clipEnd = Number(end);
      setActive(id);
      const startAt = Number(start);
      const go = () => {
        if (Math.abs(player.currentTime - startAt) < 0.08) {
          player.play();
          return;
        }
        const onSeeked = () => {
          player.removeEventListener("seeked", onSeeked);
          player.play();
        };
        player.addEventListener("seeked", onSeeked);
        player.currentTime = startAt;
      };
      if (player.readyState >= 1) go();
      else player.addEventListener("loadedmetadata", go, { once: true });
    }

    evalRoot._player = null;
    evalRoot.querySelectorAll(".seg-play").forEach((button) => {
      button.addEventListener("click", () => playSlice(button.dataset.id, button.dataset.start, button.dataset.end));
    });
    evalRoot.querySelectorAll(".phrase-copy").forEach((button) => {
      button.addEventListener("click", async () => {
        const phrase = button.dataset.phrase || "";
        try {
          await navigator.clipboard.writeText(phrase);
          button.textContent = "Copied";
        } catch (_) {
          button.textContent = "Copy failed";
        }
      });
    });
  }

  const search = document.getElementById("agent-search");
  const list = document.getElementById("agent-list");
  const popup = document.getElementById("agent-popup");
  const toggle = document.getElementById("agent-toggle");
  const className = document.getElementById("agent-name");
  const classSub = document.getElementById("agent-sub");
  const classStatus = document.getElementById("agent-status");
  let sessions = [];
  let sessionId = new URLSearchParams(location.search).get("id");
  let requestToken = 0;
  let waitTimer = null;

  function setClassButton(session, forceSaved) {
    if (!className) return;
    const saved = forceSaved || Boolean(session.evaluation_key);
    className.textContent = session.filename || "Class";
    if (classSub) classSub.textContent = durationLabel(session.duration);
    if (classStatus) {
      classStatus.textContent = saved ? "Saved" : "Analyze";
      classStatus.className = saved ? "class-status" : "class-status is-new";
    }
  }

  function durationLabel(seconds) {
    const total = Math.round(Number(seconds) || 0);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  function closePopup() {
    if (!popup) return;
    popup.hidden = true;
    toggle?.setAttribute("aria-expanded", "false");
  }

  function openPopup() {
    if (!popup) return;
    popup.hidden = false;
    toggle?.setAttribute("aria-expanded", "true");
    if (search) {
      search.value = "";
      paintList();
      search.focus();
    }
  }

  function paintList() {
    if (!list) return;
    const query = (search?.value || "").trim().toLowerCase();
    const rows = sessions.filter((session) => !query || String(session.filename || "").toLowerCase().includes(query));
    if (!rows.length) {
      list.innerHTML = `<p class="select-hint">No class matches that search.</p>`;
      return;
    }
    list.innerHTML = rows
      .map((session) => {
        const saved = Boolean(session.evaluation_key);
        const on = session.id === sessionId ? " is-selected" : "";
        return `<button class="voice-card${on}" type="button" data-id="${esc(session.id)}">
          <strong>${esc(session.filename)}</strong>
          <span>${durationLabel(session.duration)} · ${saved ? "Saved review" : "Analyze"}</span>
        </button>`;
      })
      .join("");
  }

  function stopAudio() {
    if (evalRoot._player) {
      evalRoot._player.pause();
      evalRoot._player = null;
    }
  }

  function waitForAnalysis(name) {
    const lines = [
      `Listening to ${name}…`,
      "Reading the class one ASR chunk at a time…",
      "Writing what the teacher did well…",
      "Catching the lines that need work…",
      "Saving this review so the next open is instant…",
    ];
    let step = 0;
    evalRoot.className = "";
    evalRoot.innerHTML = `<div class="eval-wait"><div class="wait-ring"></div>${bars()}<p id="wait-line">${esc(lines[0])}</p><p class="select-hint">gpt-4o-mini runs once. The result stays saved.</p></div>`;
    clearInterval(waitTimer);
    waitTimer = setInterval(() => {
      step = (step + 1) % lines.length;
      const line = document.getElementById("wait-line");
      if (line) line.textContent = lines[step];
    }, 2200);
  }

  function openSession(session) {
    const token = ++requestToken;
    clearInterval(waitTimer);
    stopAudio();
    sessionId = session.id;
    try {
      sessionStorage.setItem("asrSessionId", session.id);
    } catch (_) {}
    const navAgent = document.querySelector('nav a[href="agent.html"], nav a[href^="agent.html?"]');
    if (navAgent) navAgent.href = `agent.html?id=${session.id}`;
    history.replaceState(null, "", `agent.html?id=${session.id}`);
    setClassButton(session);
    closePopup();
    paintList();
    if (session.evaluation_key) {
      evalRoot.className = "";
      evalRoot.innerHTML = `<div class="eval-wait"><p>Opening the saved review…</p></div>`;
    } else {
      waitForAnalysis(session.filename || "this class");
    }
    apiRequest(`/api/sessions/${session.id}/evaluation`)
      .then((review) => {
        if (token !== requestToken) return;
        clearInterval(waitTimer);
        session.evaluation_key = session.evaluation_key || "saved";
        setClassButton(session, true);
        paintList();
        show(review);
      })
      .catch((error) => {
        if (token !== requestToken) return;
        clearInterval(waitTimer);
        evalRoot.textContent = error.message;
      });
  }

  toggle?.addEventListener("click", () => openPopup());
  popup?.addEventListener("click", (event) => {
    if (event.target === popup) closePopup();
  });
  if (search) search.addEventListener("input", paintList);
  if (list) {
    list.addEventListener("click", (event) => {
      const row = event.target.closest(".voice-card");
      if (!row) return;
      const session = sessions.find((item) => item.id === row.dataset.id);
      if (session) openSession(session);
    });
  }

  async function loadClasses() {
    try {
      const data = await apiRequest("/api/sessions");
      if (!Array.isArray(data)) throw new Error("Could not load saved classes");
      sessions = data;
      paintList();
      const chosen = sessions.find((session) => session.id === sessionId);
      if (chosen) openSession(chosen);
    } catch (error) {
      evalRoot.textContent = error.message;
    }
  }

  document.addEventListener("admin:change", (event) => {
    if (event.detail?.admin) loadClasses();
  });
}

const ctx = document.getElementById("agent-context");
if (ctx) {
  try {
    const raw = sessionStorage.getItem("asrSelectedSections");
    const selected = raw ? JSON.parse(raw) : [];
    if (selected.length) {
      ctx.innerHTML = selected
        .map(
          (s) =>
            `<span class="ctx-chip"><span class="sp-${String(s.speaker || "a").toLowerCase()}">${s.speaker}</span> ${s.time} · ${s.text}</span>`
        )
        .join("");
    }
  } catch (_) {}
}
