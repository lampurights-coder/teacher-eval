/* ASR Parser UI interactions */

const API = location.port === "8765" ? "" : "http://127.0.0.1:8765";

function api(path) {
  if (!path) return path;
  return path.startsWith("http") ? path : API + path;
}

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

  dropzone.addEventListener("click", () => {
    if (!busy && !dropzone.classList.contains("is-done")) fileInput.click();
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
      const created = await request("/api/sessions", { method: "POST", body });
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
      hint.textContent = `Voice is in MinIO. Transcript JSON is stored${speakers.size ? ` · ${speakers.size} speakers` : ""}.`;
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
      const session = await request(`/api/sessions/${id}`);
      if (session.stage) onStage(session.stage);
      if (session.status === "parsed") return session;
      if (session.status === "error") throw new Error(session.error || "Transcription failed");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async function request(url, options) {
    const response = await fetch(api(url), options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.detail;
      throw new Error(typeof detail === "string" ? detail : "Request failed");
    }
    return data;
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

  function playSlice(id, start, end) {
    if (!current?.audio_url) return;
    const audio = ensurePlayer(api(current.audio_url));
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

  fetch(api("/api/sessions"))
    .then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error("Could not load saved recordings");
      return data;
    })
    .then((rows) => {
      sessions = Array.isArray(rows) ? rows : [];
      if (!sessions.length) {
        thread.textContent = "No saved recording yet";
        return;
      }
      const wanted = new URLSearchParams(location.search).get("id");
      const chosen = sessions.find((session) => session.id === wanted) || sessions[0];
      choose(chosen);
    })
    .catch((error) => {
      thread.textContent = error.message || "Could not load saved recordings";
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
    const audioUrl = api(`/api/sessions/${sessionId}/audio`);

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

    function playSlice(id, start, end) {
      if (!player) {
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
    fetch(api(`/api/sessions/${session.id}/evaluation`))
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Could not load the evaluation");
        return data;
      })
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

  fetch(api("/api/sessions"))
    .then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(data)) throw new Error("Could not load saved classes");
      return data;
    })
    .then((rows) => {
      sessions = rows;
      paintList();
      const chosen = sessions.find((session) => session.id === sessionId);
      if (chosen) openSession(chosen);
    })
    .catch((error) => {
      evalRoot.textContent = error.message;
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
