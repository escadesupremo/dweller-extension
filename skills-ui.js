// The Skills tab below the AI key: the installed skills, importing one from
// GitHub, and running one. Loaded after popup.js and uses its globals ($, esc,
// state, aiCard, docTypes, insertIntoQuery, newQueryTab, WINDOW_MODE). The
// service worker does the importing (skills.js) and the running
// (skill-runner.js); this page only asks and shows.

(() => {
  const area = document.getElementById("skills-area");
  if (!area) return;

  const GH_ORIGINS = ["https://api.github.com/*", "https://raw.githubusercontent.com/*"];
  const PROVIDER_NAMES = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini" };
  const KEEPALIVE_MS = 20000;

  const ICON = {
    play: '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
    check: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
    x: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    file: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
    link: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    download: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    wait: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke-dasharray="4 4"/></svg>',
  };

  const sk = {
    view: "library",   // library | choose | preview | run
    skills: [],
    models: null,      // { provider, models, selected } once asked
    choose: null,
    preview: null,
    msg: null,         // { text, kind: "info" | "error" }
    busy: false,
    run: null,         // the run on screen
  };

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => resolve(r || { success: false, error: chrome.runtime.lastError?.message || "No answer" }));
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });

  const aiReady = () => aiCard?.dataset.state === "ok";
  const providerName = () => PROVIDER_NAMES[sk.models?.provider] || "your AI provider";

  // ---- Markdown, the small safe subset an answer uses ----------------------------
  function inlineMd(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");
  }

  function renderMd(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre class="sk-md-pre">${esc(code.join("\n"))}</pre>`);
      } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
        const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        const num = (c) => /^-?[\d,.]+%?$/.test(c);
        out.push(
          '<table class="sk-table"><tr>' + head.map((h) => `<th>${inlineMd(h)}</th>`).join("") + "</tr>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td${num(c) ? ' class="n"' : ""}>${inlineMd(c)}</td>`).join("") + "</tr>").join("") +
          "</table>"
        );
      } else if (/^#{1,4}\s/.test(line)) {
        out.push(`<p class="sk-md-h">${inlineMd(line.replace(/^#+\s*/, ""))}</p>`);
        i++;
      } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s/, ""));
        out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      } else if (!line.trim()) {
        i++;
      } else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
        if (!para.length) para.push(lines[i++]);
        out.push(`<p>${inlineMd(para.join(" "))}</p>`);
      }
    }
    return out.join("");
  }

  // ---- Library ----------------------------------------------------------------------
  function sourceLabel(src) {
    return src?.type === "github" ? `github · ${src.owner}/${src.repo}` : "";
  }

  function msgHtml() {
    return sk.msg ? `<div class="sk-msg ${sk.msg.kind === "error" ? "error" : ""}" role="status">${esc(sk.msg.text)}</div>` : "";
  }

  function libraryHtml() {
    const ready = aiReady();
    const models = sk.models?.models || [];
    const modelSel = ready && models.length
      ? `<label class="sk-model">Model <select id="sk-model">${models.map((m) => `<option value="${esc(m)}"${m === sk.models.selected ? " selected" : ""}>${esc(m)}</option>`).join("")}</select></label>`
      : "";
    const n = sk.skills.length;
    const sub = n ? `${n} installed${ready ? ` · they run on your ${esc(providerName())} key` : ""}` : "None installed yet";
    const cards = sk.skills.map((s) => {
      const tag = s.access === "write" ? '<span class="sk-tag rw">Asks before changing data</span>' : '<span class="sk-tag ro">Read-only</span>';
      const src = s.source?.url
        ? `<a class="sk-src" href="${esc(s.source.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.source.url)}">${esc(sourceLabel(s.source))}${s.version ? ` · v${esc(s.version)}` : ""}</a>`
        : "";
      return (
        `<div class="sk-skill" data-id="${esc(s.id)}"><b>${esc(s.title)}</b><p>${esc(s.description)}</p><div class="sk-tags">${tag}</div>` +
        `<div class="sk-foot"><button class="sk-btn dark" type="button" data-act="run" ${ready ? "" : 'disabled title="Connect an AI provider above first"'}>${ICON.play} Run</button>` +
        `<button class="sk-link" type="button" data-act="update">Update</button><button class="sk-link" type="button" data-act="remove">Remove</button>${src}</div></div>`
      );
    }).join("");
    return (
      `<div class="sk-card"><div class="sk-head"><span class="sk-title">Skills</span><span class="sk-sub">${sub}</span>${modelSel}</div>` +
      (ready ? "" : '<p class="sk-note">Connect an AI provider above to run skills. You can import them now.</p>') +
      (n ? `<div class="sk-grid">${cards}</div>` : '<p class="sk-note">A skill is a folder with a SKILL.md: what to do, step by step, and what it may touch. Import one from a public GitHub repository.</p>') +
      `<form class="sk-import" id="sk-import"><span class="sk-field">${ICON.link}<input id="sk-gh" type="text" spellcheck="false" autocomplete="off" ` +
      `placeholder="github.com/owner/repo, or a folder in it" aria-label="GitHub repository or folder link" /></span>` +
      `<button class="sk-btn gold" type="submit" ${sk.busy ? "disabled" : ""}>${sk.busy ? "Importing…" : "Import from GitHub"}</button></form>` +
      msgHtml() +
      "</div>"
    );
  }

  // ---- Import: choose a folder, then the preview --------------------------------------
  function chooseHtml() {
    const c = sk.choose;
    return (
      `<div class="sk-card"><div class="sk-head"><span class="sk-title">Skills in ${esc(c.repo)}</span><span class="sk-sub">${c.choices.length} found on ${esc(c.ref)}${c.truncated ? " · a very large repository; some may be missing" : ""}</span>` +
      '<button class="sk-btn" type="button" data-act="cancel" style="margin-left:auto">Cancel</button></div>' +
      '<div class="sk-files" style="margin-top:12px">' +
      c.choices.map((ch) => `<div class="sk-file">${ICON.file}${esc(ch.label)}<button class="sk-btn" type="button" data-act="pick" data-dir="${esc(ch.dir)}" style="margin-left:auto" ${sk.busy ? "disabled" : ""}>Preview</button></div>`).join("") +
      "</div>" + msgHtml() + "</div>"
    );
  }

  function previewHtml() {
    const p = sk.preview;
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    const files =
      p.files.map((f) => `<div class="sk-file">${ICON.file}${esc(f.path)}<span class="note">${esc(f.note)} · ${kb(f.size)}</span></div>`).join("") +
      p.skipped.map((f) => `<div class="sk-file skip">${ICON.file}<span class="path">${esc(f.path)}</span><span class="note">Skipped: ${esc(f.reason)}</span></div>`).join("");
    const errors = p.errors.length ? `<div class="sk-warn error">${ICON.x}<span>${p.errors.map(esc).join(" ")}</span></div>` : "";
    const warnings = p.warnings.length ? `<div class="sk-warn">${p.warnings.map(esc).join(" ")}</div>` : "";
    const replacing = p.replaces ? sk.skills.find((s) => s.id === p.replaces) : null;
    const newWrite = replacing && replacing.access !== "write" && p.access === "write"
      ? '<div class="sk-warn">This version asks to change data, which the installed one didn\'t.</div>'
      : "";
    return (
      `<div class="sk-card"><div class="sk-head"><span class="sk-title">${replacing ? "Update" : "Add skill"}: ${esc(p.title)}</span>` +
      `<span class="sk-sub">from ${esc(p.source.owner)}/${esc(p.source.repo)}${p.source.path ? "/" + esc(p.source.path) : ""}${p.version ? ` · v${esc(p.version)}` : ""}</span></div>` +
      `<p class="sk-desc">${esc(p.description)}</p>` + errors + warnings + newWrite +
      `<div class="sk-sec">Files</div><div class="sk-files">${files}</div>` +
      '<div class="sk-sec">What it can do</div><div class="sk-perm">' +
      `<div class="sk-list can"><h4>It can</h4>${p.can.map((t) => `<div>${ICON.check}<span>${esc(t)}</span></div>`).join("")}</div>` +
      `<div class="sk-list cant"><h4>It can't</h4>${p.cant.map((t) => `<div>${ICON.x}<span>${esc(t)}</span></div>`).join("")}</div></div>` +
      msgHtml() +
      '<div class="sk-actions"><button class="sk-btn" type="button" data-act="cancel">Cancel</button>' +
      `<button class="sk-btn gold" type="button" data-act="install" ${p.errors.length || sk.busy ? "disabled" : ""}>${replacing ? "Install the update" : "Install skill"}</button></div></div>`
    );
  }

  // ---- Run ------------------------------------------------------------------------
  function inputHtml(inp, value) {
    const id = `sk-in-${inp.key}`;
    let control;
    if (inp.options) {
      control = `<select id="${id}" data-input="${esc(inp.key)}">${inp.options.map((o) => `<option${o === value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    } else if (inp.key === "doc_type" && typeof docTypes !== "undefined" && docTypes.length) {
      const sorted = [...docTypes].sort((a, b) => a.label.localeCompare(b.label));
      control = `<select id="${id}" data-input="doc_type">${sorted.map((t) => `<option value="${esc(t.name)}"${t.name === value ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select>`;
    } else {
      control = `<input id="${id}" type="text" data-input="${esc(inp.key)}" value="${esc(value || "")}" spellcheck="false" />`;
    }
    return `<label class="sk-inp" for="${id}">${esc(inp.label)}${control}</label>`;
  }

  function stepHtml(st) {
    const icon = st.status === "done" ? ICON.check : st.status === "error" ? ICON.x : ICON.wait;
    return (
      `<div class="sk-step ${esc(st.status)}">${icon}<span class="sk-step-text">${esc(st.title || "")}` +
      `${st.code ? ` <code title="${esc(st.code)}">${esc(st.code)}</code>` : ""}</span>` +
      `${st.meta ? `<span class="meta">${esc(st.meta)}</span>` : ""}</div>`
    );
  }

  const approveLabel = (n) => (n ? `Approve ${n} change${n === 1 ? "" : "s"}` : "Approve");

  function approvalHtml(a) {
    return (
      '<div class="sk-approve"><div class="sk-sec">The change it proposes</div>' +
      (a.reason ? `<p class="sk-desc">${esc(a.reason)}</p>` : "") +
      `<table class="sk-table"><tr><th></th><th>${a.object === "documents" ? "Document" : "Record"}</th><th>Field</th><th>Now</th><th>After</th></tr>` +
      a.changes.map((c, i) =>
        `<tr><td><input type="checkbox" checked data-change="${i}" aria-label="Include ${esc(c.label || c.id)}" /></td>` +
        `<td>${esc(c.label || "")} <code>${esc(c.id)}</code></td><td><code>${esc(c.field)}</code></td>` +
        `<td class="old">${c.current == null ? "—" : esc(c.current || "(empty)")}</td><td class="new">${esc(c.value)}</td></tr>`
      ).join("") +
      "</table>" +
      '<div class="sk-warn">Nothing changes until you approve. The extension makes the changes itself, as you, only for the ticked rows.</div>' +
      `<div class="sk-actions"><button class="sk-btn" type="button" data-act="reject">Reject</button>` +
      `<button class="sk-btn gold" type="button" data-act="approve">${approveLabel(a.changes.length)}</button></div></div>`
    );
  }

  function runHtml() {
    const r = sk.run;
    const s = r.skill;
    const who = r.model ? ` · ${esc(PROVIDER_NAMES[r.provider] || r.provider)} · ${esc(r.model)}` : "";
    const answer = r.answer != null
      ? `<div class="sk-answer">${renderMd(r.answer)}<div class="sk-actions start">` +
        r.actions.map((a, i) => a.kind === "excel"
          ? `<button class="sk-btn dark" type="button" data-act="excel" data-i="${i}">${ICON.download} ${esc(a.label)}</button>`
          : `<button class="sk-btn dark" type="button" data-act="open-query" data-i="${i}">${esc(a.label)}</button>`).join("") +
        (r.rows ? '<button class="sk-btn" type="button" data-act="csv">Copy the last rows as CSV</button>' : "") +
        "</div></div>"
      : "";
    return (
      `<div class="sk-card"><div class="sk-head"><span class="sk-title">${esc(s.title)}</span>` +
      `<span class="sk-sub">${s.access === "write" ? "asks before changing data" : "read-only"}${who}</span>` +
      '<button class="sk-btn" type="button" data-act="back" style="margin-left:auto">Back to skills</button></div>' +
      `<div class="sk-inputs">${s.inputs.map((i) => inputHtml(i, r.inputs[i.key])).join("")}` +
      `<label class="sk-inp grow" for="sk-extra">Anything to add<input id="sk-extra" type="text" value="${esc(r.extra)}" spellcheck="false" /></label>` +
      (r.running
        ? '<button class="sk-btn" type="button" data-act="stop">Stop</button>'
        : `<button class="sk-btn dark" type="button" data-act="start">${ICON.play} ${r.started ? "Run again" : "Run"}</button>`) +
      "</div>" +
      (r.steps.length || r.running ? `<div class="sk-sec">What it did</div><div class="sk-steps" aria-live="polite">${r.steps.map(stepHtml).join("")}${r.running && !r.approval ? `<div class="sk-step running">${ICON.wait}<span class="sk-step-text">Thinking…</span></div>` : ""}</div>` : "") +
      r.notes.map((n) => `<p class="sk-note">${esc(n)}</p>`).join("") +
      (r.approval ? approvalHtml(r.approval) : "") +
      (r.error ? `<div class="sk-warn error">${ICON.x}<span>${esc(r.error)}</span></div>` : "") +
      answer +
      "</div>"
    );
  }

  function render() {
    const html = sk.view === "choose" ? chooseHtml() : sk.view === "preview" ? previewHtml() : sk.view === "run" ? runHtml() : libraryHtml();
    area.innerHTML = html;
  }

  // ---- Data ---------------------------------------------------------------------------
  async function refreshList() {
    const r = await send({ action: "skillsList" });
    sk.skills = r.success ? r.skills : [];
  }

  async function refreshModels() {
    if (!aiReady()) {
      sk.models = null;
      return;
    }
    const r = await send({ action: "aiModels" });
    sk.models = r.success ? r : null;
  }

  async function showLibrary(msg = null) {
    sk.view = "library";
    sk.msg = msg;
    await refreshList();
    render();
  }

  // ---- Import --------------------------------------------------------------------------
  async function importUrl(url) {
    if (!url.trim()) return;
    // GitHub is an optional permission, asked for here, on the click.
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: GH_ORIGINS });
    } catch (e) {
      sk.msg = { kind: "error", text: `Chrome couldn't ask for GitHub access here (${e.message}). Try from the full window.` };
      return render();
    }
    if (!granted) {
      sk.msg = { kind: "error", text: "Importing needs permission to read GitHub. Nothing else is read from there." };
      return render();
    }
    sk.busy = true;
    sk.msg = null;
    render();
    const r = await send({ action: "skillsImport", url });
    sk.busy = false;
    takeImport(r);
  }

  function takeImport(r) {
    if (!r.success) {
      sk.msg = { kind: "error", text: r.error || "Import failed." };
      return render();
    }
    if (r.upToDate) return showLibrary({ kind: "info", text: "Already the latest version." });
    if (r.choose) {
      sk.choose = r.choose;
      sk.view = "choose";
      sk.msg = null;
      return render();
    }
    sk.preview = r.preview;
    sk.view = "preview";
    sk.msg = null;
    render();
  }

  // ---- Running ------------------------------------------------------------------------
  function readInputs() {
    const r = sk.run;
    for (const el of area.querySelectorAll("[data-input]")) r.inputs[el.dataset.input] = el.value;
    const extra = area.querySelector("#sk-extra");
    if (extra) r.extra = extra.value;
  }

  function openRun(skill) {
    const inputs = {};
    for (const i of skill.inputs) inputs[i.key] = i.options ? i.options[0] : "";
    sk.run = { skill, inputs, extra: "", steps: [], notes: [], actions: [], answer: null, error: null, running: false, started: false, approval: null, rows: null, port: null, timer: null };
    sk.view = "run";
    render();
  }

  function endRun() {
    const r = sk.run;
    if (!r) return;
    clearInterval(r.timer);
    r.timer = null;
    r.running = false;
    if (r.port) {
      try {
        r.port.disconnect();
      } catch (e) {
        /* already gone */
      }
      r.port = null;
    }
  }

  function startRun() {
    const r = sk.run;
    readInputs();
    if (!aiReady()) {
      r.error = "Connect an AI provider above first.";
      return render();
    }
    if (!state.sessionId || !state.domain) {
      r.error = "Connect to a Vault first.";
      return render();
    }
    endRun();
    Object.assign(r, { steps: [], notes: [], actions: [], answer: null, error: null, approval: null, rows: null, running: true, started: true });
    const port = chrome.runtime.connect({ name: "skill-run" });
    r.port = port;
    port.onMessage.addListener((m) => onRunEvent(r, m));
    port.onDisconnect.addListener(() => {
      if (r.running) {
        r.running = false;
        if (r.answer == null && !r.error) r.error = "The run stopped unexpectedly.";
        if (sk.run === r && sk.view === "run") render();
      }
    });
    // An open run keeps the service worker awake.
    r.timer = setInterval(() => {
      try {
        port.postMessage({ type: "ping" });
      } catch (e) {
        clearInterval(r.timer);
      }
    }, KEEPALIVE_MS);
    port.postMessage({
      type: "start",
      skillId: r.skill.id,
      inputs: r.inputs,
      extra: r.extra,
      vault: { domain: state.domain, sessionId: state.sessionId, version: state.apiVersion },
    });
    render();
  }

  function onRunEvent(r, m) {
    if (sk.run !== r) return;
    if (m.type === "started") {
      r.provider = m.provider;
      r.model = m.model;
    } else if (m.type === "step") {
      const i = r.steps.findIndex((s) => s.id === m.id);
      if (i >= 0) r.steps[i] = m;
      else r.steps.push(m);
      if (m.rows && m.columns) r.rows = { columns: m.columns, rows: m.rows };
    } else if (m.type === "note") {
      r.notes = [m.text.slice(0, 400)];
    } else if (m.type === "approve") {
      r.approval = m;
    } else if (m.type === "done") {
      r.answer = m.text;
      r.actions = m.actions || [];
      r.notes = [];
      endRun();
    } else if (m.type === "error") {
      r.error = m.error;
      endRun();
    } else if (m.type === "stopped") {
      r.error = "Stopped.";
      endRun();
    }
    if (sk.view === "run") {
      readInputsQuietly();
      render();
    }
  }

  // Keeps what's typed in the inputs across re-renders mid-run.
  function readInputsQuietly() {
    if (!sk.run) return;
    for (const el of area.querySelectorAll("[data-input]")) sk.run.inputs[el.dataset.input] = el.value;
    const extra = area.querySelector("#sk-extra");
    if (extra) sk.run.extra = extra.value;
  }

  function answerApproval(approve) {
    const r = sk.run;
    if (!r?.approval || !r.port) return;
    const picked = approve ? [...area.querySelectorAll("[data-change]")].filter((c) => c.checked).map((c) => Number(c.dataset.change)) : [];
    r.port.postMessage({ type: "approval", id: r.approval.id, approved: picked });
    r.approval = null;
    render();
  }

  function openQuery(query) {
    if (WINDOW_MODE) {
      if (typeof activeQueryToken !== "undefined" && activeQueryToken) return alert("A query is still running. Try again when it finishes.");
      if (vqlInput.value.trim()) newQueryTab();
    } else if (vqlInput.value.trim() && vqlInput.value.trim() !== query && !confirm("Replace the query in the editor?")) {
      return;
    }
    insertIntoQuery(query, true);
  }

  function rowsCsv(t) {
    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [t.columns.map(cell).join(","), ...t.rows.map((row) => row.map(cell).join(","))].join("\n");
  }

  // ---- Events -------------------------------------------------------------------------
  area.addEventListener("submit", (e) => {
    if (e.target.id !== "sk-import") return;
    e.preventDefault();
    importUrl(area.querySelector("#sk-gh").value);
  });

  area.addEventListener("change", async (e) => {
    if (e.target.matches("[data-change]")) {
      const n = area.querySelectorAll("[data-change]:checked").length;
      const btn = area.querySelector('[data-act="approve"]');
      if (btn) {
        btn.textContent = approveLabel(n);
        btn.disabled = !n;
      }
      return;
    }
    if (e.target.id === "sk-model") {
      await send({ action: "aiSetModel", model: e.target.value });
      if (sk.models) sk.models.selected = e.target.value;
    }
  });

  area.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const id = btn.closest("[data-id]")?.dataset.id;
    const skill = sk.skills.find((s) => s.id === id);

    if (act === "run" && skill) return openRun(skill);
    if (act === "remove" && skill) {
      if (!confirm(`Remove “${skill.title}”?`)) return;
      await send({ action: "skillsRemove", id });
      return showLibrary({ kind: "info", text: `Removed ${skill.title}.` });
    }
    if (act === "update" && skill) {
      try {
        if (!(await chrome.permissions.request({ origins: GH_ORIGINS }))) return;
      } catch (err) {
        /* falls through to the worker's own error */
      }
      sk.msg = { kind: "info", text: `Checking ${skill.title} on GitHub…` };
      render();
      return takeImport(await send({ action: "skillsCheckUpdate", id }));
    }
    if (act === "pick") {
      sk.busy = true;
      render();
      const r = await send({ action: "skillsPick", dir: btn.dataset.dir });
      sk.busy = false;
      return takeImport(r);
    }
    if (act === "cancel") return showLibrary();
    if (act === "install") {
      sk.busy = true;
      render();
      const r = await send({ action: "skillsInstall", previewId: sk.preview.id });
      sk.busy = false;
      if (!r.success) {
        sk.msg = { kind: "error", text: r.error };
        return render();
      }
      return showLibrary({ kind: "info", text: `Installed ${r.skill.title}.` });
    }
    if (act === "start") return startRun();
    if (act === "stop") {
      sk.run?.port?.postMessage({ type: "stop" });
      return;
    }
    if (act === "back") {
      endRun();
      sk.run = null;
      return showLibrary();
    }
    if (act === "approve") return answerApproval(true);
    if (act === "reject") return answerApproval(false);
    if (act === "excel") {
      const a = sk.run?.actions[Number(btn.dataset.i)];
      if (a?.sheets) downloadWorkbook(a.sheets, a.filename);
      return;
    }
    if (act === "open-query") {
      const a = sk.run?.actions[Number(btn.dataset.i)];
      if (a) openQuery(a.query);
      return;
    }
    if (act === "csv" && sk.run?.rows) {
      try {
        await navigator.clipboard.writeText(rowsCsv(sk.run.rows));
        btn.textContent = "Copied";
      } catch (err) {
        btn.textContent = "Couldn't copy";
      }
    }
  });

  // The key card above decides whether skills can run; follow it.
  new MutationObserver(async () => {
    await refreshModels();
    if (sk.view === "library") render();
  }).observe(aiCard, { attributes: true, attributeFilter: ["data-state"] });

  (async () => {
    await refreshList();
    await refreshModels();
    render();
  })();
})();
