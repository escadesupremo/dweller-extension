// ===================== STATE =====================
let state = {
  sessionId: null,
  domain: null,
  user: null,
  history: [],
  dataModel: null,
  // The Vault API version this vault is called at; set on connect.
  apiVersion: null,
};

// ===================== DOM REFS =====================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const connectionPanel = $("#connection-panel");
const vqlPanel = $("#vql-panel");
const statusPill = $("#status-pill");
const statusText = $("#status-text");
const domainInput = $("#vault-domain");
const disconnectBtn = $("#disconnect-btn");
const whoamiBtn = $("#whoami-btn");
const whoamiPopover = $("#whoami-popover");
const whoamiClose = $("#whoami-close");
const userDetails = $("#user-details");
const aiCard = $("#ai-card");
const aiProviderGroup = $("#ai-provider");
const aiConnLogo = $("#ai-conn-logo");
const aiKeyInput = $("#ai-key-input");
const aiKeyReveal = $("#ai-key-reveal");
const aiKeySave = $("#ai-key-save");
const aiKeyCancel = $("#ai-key-cancel");
const aiKeyDrop = $("#ai-key-drop");
const aiKeyError = $("#ai-key-error");
const aiConnName = $("#ai-conn-name");
const aiConnMeta = $("#ai-conn-meta");
const aiKeyReplace = $("#ai-key-replace");
const aiKeyClear = $("#ai-key-clear");
const vqlInput = $("#vql-input");
const runBtn = $("#run-btn");
const cancelBtn = $("#cancel-btn");
const clearBtn = $("#clear-btn");
const queryTime = $("#query-time");
const resultsPanel = $("#results-panel");
const resultsCount = $("#results-count");
const resultsContainer = $("#results-container");
const copyBtn = $("#copy-btn");
const exportCsvBtn = $("#export-csv-btn");
const historyBtn = $("#history-btn");
const historyPopover = $("#history-popover");
const historyList = $("#history-list");
const clearHistoryBtn = $("#clear-history-btn");
const acDropdown = $("#autocomplete-dropdown");

// INSERT refs: the pill and the chips it slides out
const insertChip = $("#insert-chip");
const insertRow = $("#insert-row");
const operatorBar = $("#operator-bar");

// Data model refs
const modelChip = $("#model-chip");
const modelChipLabel = $("#model-chip-label");
const dmPanel = $("#dm-panel");
const dmEmptyState = $("#dm-empty-state");
const dmCounts = $("#dm-counts");
const dmSearch = $("#dm-search");
const dmSearchField = $(".dm-search-field");
const dmSearchClear = $("#dm-search-clear");
const dmObjects = $("#dm-objects");
const dmSwitch = $("#dm-switch");
const dmTree = $("#dm-tree");
const dmMore = $("#dm-more");
const dmShowing = $("#dm-showing");
const dmShowMore = $("#dm-show-more");
const dmInsertAll = $("#dm-insert-all");

// Window-mode refs
const topbarUser = $("#topbar-user");
const expandBtn = $("#expand-btn");
const collapseBtn = $("#collapse-btn");
const closeBtn = $("#close-btn");
const editorTools = $("#editor-tools");
const editorHl = $("#editor-hl");
const editorGutter = $("#editor-gutter");

// popup.html serves both the overlay iframe and the full-window tab. The mode is
// fixed for the lifetime of the page, so layout decisions can be made once.
const PAGE_PARAMS = new URLSearchParams(location.search);
const WINDOW_MODE = PAGE_PARAMS.get("mode") === "window";

// Loads the previous view was part-way through when it handed over (see
// handoffLoads). Started again once this view has connected.
const handedLoads = new Set((PAGE_PARAMS.get("resume") || "").split(","));

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const RUN_KEY_LABEL = IS_MAC ? "⌘↵" : "Ctrl ↵";

// The run button's resting face. The workbench gives it the play glyph and its
// shortcut; runQuery swaps in progress text and puts this back when it's done.
const RUN_LABEL = WINDOW_MODE
  ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>' +
    `Run<span class="run-word"> query</span><span class="run-key">${RUN_KEY_LABEL}</span>`
  : "Run Query";

let lastResultData = null;
let acIndex = -1;
let acItems = [];

// History navigation: -1 means "not navigating"; 0..N-1 indexes into state.history.
const HISTORY_NAV_LIMIT = 10;
let historyNavIndex = -1;

// Cancellation token for the in-flight query. The cancel button flips
// `aborted = true`; the runQuery loops check it after every await and bail
// out gracefully. In-flight fetches are not cancelled at the network level —
// their responses are simply discarded once the flag is set.
let activeQueryToken = null;

// ===================== WINDOW MODE =====================
if (WINDOW_MODE) {
  document.body.classList.add("mode-window");
  // The workbench's status bar holds the vault identity on the left and the
  // model loads on the right; the top bar itself becomes the rail.
  $("#status-left").appendChild($(".topbar-conn"));
  $("#status-right").appendChild($("#chip-group"));
  expandBtn.classList.add("hidden");
  collapseBtn.classList.remove("hidden");
  // The editor's own actions sit on its toolbar, right of the operator chips.
  editorTools.append(clearBtn, cancelBtn, runBtn);
  runBtn.innerHTML = RUN_LABEL;
  runBtn.title =
    `Run (${IS_MAC ? "⌘" : "Ctrl"}+Enter). Fetches every page concurrently, up to the Limit when ` +
    "the query has no MAXROWS of its own. For stable paging on large sets, include an ORDER BY.";
  resultsContainer.dataset.empty = `Run a query to see its rows here · ${RUN_KEY_LABEL}`;
}

// Closing this view abandons any model or type load still running, so the next
// view is told to start it again rather than coming up without it.
function handoffLoads() {
  return [modelLoading && "model", dtLoading && "types"].filter(Boolean).join(",");
}

expandBtn.addEventListener("click", async () => {
  // Build the query string outside getURL — it takes a path, and a version that
  // escapes or drops the "?" would open the popup layout instead of the window one.
  // The vault goes along by name: from its own tab the window cannot tell which
  // of several open Vault tabs the panel was working in.
  const query = new URLSearchParams({ mode: "window" });
  if (state.domain) query.set("vault", state.domain);
  if (handoffLoads()) query.set("resume", handoffLoads());
  const url = `${chrome.runtime.getURL("popup.html")}?${query}`;
  await chrome.tabs.create({ url });
  closeOverlay();
});

// Only close this tab once the overlay is actually back up, so a missing Vault
// tab or an uninjected content script can't collapse the panel into nothing.
collapseBtn.addEventListener("click", async () => {
  const vaultTabs = await chrome.tabs.query({ url: "https://*.veevavault.com/*" });
  // Back into the vault this window was working in, not whichever Vault tab
  // happens to be listed first.
  const tab = vaultTabs.find((t) => hostOf(t.url) === state.domain) || vaultTabs[0];
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "openOverlay", resume: handoffLoads() });
  } catch (e) {
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  window.close();
});

closeBtn.addEventListener("click", () => {
  if (WINDOW_MODE) window.close();
  else closeOverlay();
});

// The overlay lives in an iframe owned by content.js on the Vault page; only it
// can tear the wrapper down.
function closeOverlay() {
  window.parent.postMessage({ type: "vault-dweller-close" }, "*");
}

// The iframe wrapper has no intrinsic height, so it would leave dead space below
// a short panel. Report the real content height and let content.js shrink-wrap.
// Absolutely-positioned overlays don't grow .shell, so measure them separately
// or they get clipped by the resized iframe.
if (!WINDOW_MODE) {
  const shell = document.querySelector(".shell");
  const floatingPanels = [acDropdown, historyPopover];
  let lastHeight = 0;

  const reportHeight = () => {
    let bottom = shell.getBoundingClientRect().bottom;
    for (const el of floatingPanels) {
      if (el && !el.classList.contains("hidden")) {
        bottom = Math.max(bottom, el.getBoundingClientRect().bottom + 12);
      }
    }
    const height = Math.ceil(bottom);
    if (height === lastHeight) return;
    lastHeight = height;
    window.parent.postMessage({ type: "vault-dweller-height", height }, "*");
  };

  // Polled rather than observed. The height changes from many places — results,
  // tree, popovers, dropdowns, inline edit rows — and a ResizeObserver on .shell
  // misses some of them, leaving the iframe the wrong size until the next
  // interaction. The check is a single rect read and only posts on a change.
  reportHeight();
  setInterval(reportHeight, 200);
}

// ===================== INIT =====================
document.addEventListener("DOMContentLoaded", async () => {
  const saved = await chrome.storage.local.get([
    "vaultDomain", "queryHistory", "queryTabs", "queryLimit",
    "valueMode", "explorerPanel", "editorHeight",
  ]);
  if (saved.vaultDomain) domainInput.value = saved.vaultDomain;
  if (VALUE_MODES.includes(saved.valueMode)) valueMode = saved.valueMode;
  paintValueMode();
  if (saved.queryHistory) state.history = saved.queryHistory;
  // Per-instance data model loading happens after autoConnect resolves the current domain.
  // Legacy single-key storage is migrated lazily inside loadDataModelForDomain().
  if (WINDOW_MODE) initWorkbench(saved);
  renderHistory();

  try {
    let domain = handedVault();
    if (!domain) {
      // Look for a Vault tab across all windows (popup runs in its own window).
      // From the full window the extension's own tab is the active one, so the
      // vault last connected to is a better guess than "active" there.
      const vaultTabs = await chrome.tabs.query({ url: "https://*.veevavault.com/*" });
      let tab =
        (WINDOW_MODE && vaultTabs.find((t) => hostOf(t.url) === saved.vaultDomain)) ||
        vaultTabs.find((t) => t.active) ||
        vaultTabs[0];
      if (!tab) {
        [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
      domain = hostOf(tab?.url);
    }
    if (isVaultHost(domain)) {
      domainInput.value = domain;
      autoConnect(domain);
    }
  } catch (e) {
    // user can connect manually
  }
});

// The vault this page was opened for, when that is known rather than guessed:
// the overlay from the Vault page it is embedded in, the full window from the
// panel that opened it. Guessing from open tabs picked the wrong vault whenever
// more than one was open.
function handedVault() {
  const known = [PAGE_PARAMS.get("vault")];
  if (!WINDOW_MODE && location.ancestorOrigins?.length) {
    known.unshift(hostOf(location.ancestorOrigins[0]));
  }
  return known.find(isVaultHost) || null;
}

// ===================== TABS =====================
function activatePane(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-content").forEach((c) => c.classList.toggle("active", c.id === `tab-${name}`));
  // Full-window mode force-shows panes as a sidebar plus a main column, so the
  // layout has to know which pane owns the main column.
  vqlPanel.dataset.activeTab = name;
  if (name === "datamodel") syncDmToQuery();
  // Read the stored key's state each time Skills opens, unless a key is half
  // typed: a refresh empties the field, and switching tabs shouldn't lose it.
  if (name === "skills" && !aiKeyInput.value) refreshAiKeyState();
}

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    // In the workbench rail, Models is a panel beside the editor, not a pane.
    if (WINDOW_MODE && tab.dataset.tab === "datamodel") return toggleExplorer("model");
    activatePane(tab.dataset.tab);
  });
});

// Segmented control: sliding thumb + drag-to-switch, used by the topbar tabs.
// The thumb is measured from real geometry rather than an equal-share
// calculation: options are flex:1 but cannot shrink below their label, so they
// are genuinely unequal, and the topbar hides one option in full-window mode.
// Whoever sets `.active` owns selection; this just follows it.
function initSegmented(rootEl, optSelector, thumbSelector) {
  if (!rootEl) return () => {};
  const thumb = rootEl.querySelector(thumbSelector);
  const opts = Array.from(rootEl.querySelectorAll(optSelector));
  if (!thumb || !opts.length) return () => {};

  const paint = () => {
    const active = opts.find((b) => b.classList.contains("active"));
    // No layout yet (panel still hidden) or the active option isn't rendered.
    if (!active || active.offsetParent === null) {
      thumb.style.opacity = "0";
      return;
    }
    // offsetLeft/offsetWidth, not getBoundingClientRect: rects are in
    // transformed coordinates, and the popover this can sit inside animates a
    // scale() on open — measuring mid-animation would bake the scale into the
    // CSS lengths. Both roots are position:relative, so an option's offsetParent
    // is the root, which is also the thumb's containing block.
    if (!active.offsetWidth) {
      thumb.style.opacity = "0";
      return;
    }
    thumb.style.opacity = "1";
    thumb.style.left = `${active.offsetLeft}px`;
    thumb.style.width = `${active.offsetWidth}px`;
  };

  paint();
  const obs = new MutationObserver(paint);
  opts.forEach((b) => obs.observe(b, { attributes: true, attributeFilter: ["class"] }));

  // Label widths move once the webfont lands, and the overlay is resizable.
  window.addEventListener("resize", paint);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(paint).catch(() => {});
  }

  // Press-and-drag across the bar to switch. The native click on pointerdown
  // handles the initial selection; pointermove fires .click() only when the
  // hit-tested option changes, so we don't double-trigger the active one.
  const optAtX = (clientX) => {
    const visible = opts.filter((b) => b.offsetParent !== null);
    if (!visible.length) return null;
    let nearest = visible[0];
    let nearestGap = Infinity;
    for (const b of visible) {
      const r = b.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) return b;
      const gap = clientX < r.left ? r.left - clientX : clientX - r.right;
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = b;
      }
    }
    return nearest;
  };

  rootEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // The full window stacks the tabs as a rail, where every option shares one
    // x position; dragging there would always land on the first.
    if (WINDOW_MODE && rootEl.classList.contains("tabs")) return;
    rootEl.classList.add("dragging");
    let last = optAtX(e.clientX);
    const onMove = (ev) => {
      const t = optAtX(ev.clientX);
      if (t && t !== last) { last = t; t.click(); }
    };
    const onUp = () => {
      rootEl.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  return paint;
}

const paintTabThumb = initSegmented($(".tabs"), ".tab", ".tab-thumb");

// ===================== CONNECTION =====================
async function autoConnect(domain) {
  // The one gate every connection passes through, whether the domain came from
  // a tab, from storage, or from the field.
  if (!isVaultHost(domain)) {
    setStatus("disconnected", "Not a Vault domain.");
    return;
  }
  setStatus("connecting", "Connecting...");
  chrome.storage.local.set({ vaultDomain: domain });

  const tokenResult = await chrome.runtime.sendMessage({
    action: "getToken",
    domain: domain,
  });

  if (!tokenResult.success) {
    setStatus("disconnected", tokenResult.error);
    return;
  }

  state.sessionId = tokenResult.token;
  state.domain = domain;
  setStatus("connecting", "Validating session via /objects/users/me...");

  const userResult = await chrome.runtime.sendMessage({
    action: "apiCall",
    domain: domain,
    sessionId: state.sessionId,
    endpoint: "/objects/users/me",
    method: "GET",
  });

  if (!userResult.success || userResult.data?.responseStatus === "FAILURE") {
    const errMsg =
      userResult.data?.errors?.[0]?.message || userResult.error || "Authentication failed";
    setStatus("disconnected", errMsg);
    state.sessionId = null;
    return;
  }

  state.user = userResult.data;
  // Called at the newest version both sides know, so newer VQL (SHOW, TRIM(),
  // the attachment functions…) works where the vault has it.
  await detectApiVersion();
  setStatus("connected", "Connected");
  showUserInfo(userResult.data);
  showVqlPanel();

  // Per-instance data model and document types: load from storage if present,
  // else the chips prompt the user.
  await loadDataModelForDomain(domain);
  await loadDocTypesForDomain(domain);
  resumeHandedLoads();
}

function resumeHandedLoads() {
  if (!handedLoads.has("model") && !handedLoads.has("types")) return;
  if (handedLoads.has("model")) loadDataModel();
  if (handedLoads.has("types")) loadDocTypes();
  handedLoads.clear();
  // Once only: a reload of this page shouldn't start the loads over again.
  const url = new URL(location.href);
  url.searchParams.delete("resume");
  history.replaceState(null, "", url);
}

// ---- Per-vault cache --------------------------------------------------------
// Each vault's data model, document types and field fill stats live under a
// storage key of their own ("dataModel:acme.veevavault.com"), so every vault
// worked in keeps its own until it's reloaded. They used to share one key per
// kind, which every save read, changed and wrote back whole: two views saving
// different vaults at once could drop one, and when a save didn't fit, the
// fallback kept only the current vault and erased the rest. The manifest asks
// for unlimitedStorage, so a save that fails now is a real failure and is
// reported, never "solved" by deleting another vault's data.
const VAULT_CACHE_KEYS = { dataModels: "dataModel", docTypeCache: "docTypes", fieldStats: "fieldStats" };

function vaultCacheKey(kind, domain) {
  return `${VAULT_CACHE_KEYS[kind]}:${domain}`;
}

async function saveVaultCache(kind, domain, entry) {
  await migrateVaultCaches();
  await chrome.storage.local.set({ [vaultCacheKey(kind, domain)]: entry });
}

async function readVaultCache(kind, domain) {
  await migrateVaultCaches();
  const key = vaultCacheKey(kind, domain);
  return (await chrome.storage.local.get([key]))[key] || null;
}

// One move from the shared maps (and the single-model key before them) to a
// key per vault, the first time any cache is read or written. An entry that
// already has its own key is newer and stays; then the old keys go.
let vaultCacheMigration = null;
function migrateVaultCaches() {
  vaultCacheMigration ||= (async () => {
    const old = await chrome.storage.local.get([...Object.keys(VAULT_CACHE_KEYS), "dataModel", "dataModelTime", "vaultDomain"]);
    const moved = {};
    for (const kind of Object.keys(VAULT_CACHE_KEYS)) {
      for (const [domain, entry] of Object.entries(old[kind] || {})) {
        if (entry && isVaultHost(domain)) moved[vaultCacheKey(kind, domain)] = entry;
      }
    }
    if (old.dataModel && isVaultHost(old.vaultDomain || "")) {
      const key = vaultCacheKey("dataModels", old.vaultDomain);
      if (!moved[key]) moved[key] = { model: old.dataModel, time: old.dataModelTime || null };
    }
    const keys = Object.keys(moved);
    if (keys.length) {
      const existing = await chrome.storage.local.get(keys);
      for (const k of Object.keys(existing)) delete moved[k];
      if (Object.keys(moved).length) await chrome.storage.local.set(moved);
    }
    const stale = [...Object.keys(VAULT_CACHE_KEYS), "dataModel", "dataModelTime"].filter((k) => k in old);
    if (stale.length) await chrome.storage.local.remove(stale);
  })().catch(() => {
    // Leave the old keys for the next try rather than lose them.
    vaultCacheMigration = null;
  });
  return vaultCacheMigration;
}

// Another view of the same vault — the panel in a Vault tab, the full window in
// its own tab — can load the model or the types while this one is open. Take
// what it saved instead of offering to load it again. A view's own saves come
// back here too; the timestamps tell them apart.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Names/Labels is one setting for every view; another view flipping it
  // repaints the switch here, and applies from this view's next run.
  const mode = changes.valueMode?.newValue;
  if (VALUE_MODES.includes(mode) && mode !== valueMode) {
    valueMode = mode;
    paintValueMode();
  }
  if (!state.domain) return;
  const model = changes[vaultCacheKey("dataModels", state.domain)]?.newValue;
  if (model?.model && model.time !== dataModelTime && !modelLoading) {
    state.dataModel = model.model;
    onDataModelLoaded(model.time);
  }
  const types = changes[vaultCacheKey("docTypeCache", state.domain)]?.newValue;
  if (types?.types?.length && types.time !== docTypesTime && !dtLoading && !dtCounting) {
    applyDocTypes(types.types, types.time);
  }
});

// ===================== PER-INSTANCE DATA MODEL =====================
async function loadDataModelForDomain(domain) {
  dmResetView();
  forgetLiveObjects();
  await loadFieldStatsForDomain(domain);
  const entry = await readVaultCache("dataModels", domain);
  if (entry && entry.model) {
    state.dataModel = entry.model;
    onDataModelLoaded(entry.time);
  } else {
    state.dataModel = null;
    setChipState("idle");
    renderDataModelTree("");
  }
}

function setStatus(type, text) {
  statusPill.className = `status-pill ${type}`;
  // Connected collapses to a bare dot in the overlay, so the message has to
  // survive as a tooltip. In the full window the pill names the vault instead.
  const connectedInWindow = type === "connected" && WINDOW_MODE && state.domain;
  statusText.textContent = connectedInWindow ? state.domain : text;
  const api = type === "connected" && state.apiVersion ? ` · using API ${state.apiVersion}` : "";
  statusPill.title = `${connectedInWindow ? `Connected to ${state.domain}` : text}${api}`;
  if (WINDOW_MODE) {
    $("#status-api").textContent = type === "connected" && state.apiVersion ? `API ${state.apiVersion}` : "";
  }
}

// Who, where, and with what rights — the three things worth knowing at a glance.
// user_name__v is the login and is usually the same string as user_email__v, so
// showing both said one thing twice; the rest (vault id, the duplicate address)
// moved into the tooltip rather than costing a row each.
function showUserInfo(data) {
  const u = data.users?.[0]?.user || data;
  const name = [u.user_first_name__v, u.user_last_name__v].filter(Boolean).join(" ");
  const login = u.user_name__v || u.user_email__v || "";
  const primary = name || login;

  if (!primary) {
    // Unexpected payload shape — show it rather than an empty panel.
    userDetails.innerHTML = `<div class="whoami-raw">${esc(
      JSON.stringify(data).slice(0, 200)
    )}</div>`;
  } else {
    const secondary = login && login !== primary ? login : "";
    const chips = [u.security_profile__v, state.domain, state.apiVersion && `API ${state.apiVersion}`].filter(Boolean);
    const tip = [
      name && login ? `${name} · ${login}` : primary,
      u.user_email__v && u.user_email__v !== login ? u.user_email__v : "",
      u.vault_id__v ? `Vault ID ${u.vault_id__v}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    userDetails.innerHTML =
      `<div class="whoami-who" title="${esc(tip)}">` +
      `<div class="whoami-name">${esc(primary)}</div>` +
      (secondary ? `<div class="whoami-login">${esc(secondary)}</div>` : "") +
      "</div>" +
      (chips.length
        ? `<div class="whoami-chips">${chips
            .map((c) => `<span class="whoami-chip">${esc(c)}</span>`)
            .join("")}</div>`
        : "");
  }
  whoamiBtn.classList.remove("hidden");

  // Only the full window shows this; the pill has room for the address, and the
  // security profile rides along in the tooltip.
  const who = [u.user_email__v || u.user_name__v, u.security_profile__v].filter(Boolean);
  topbarUser.textContent = who[0] || "";
  topbarUser.title = who.join(" · ");
}

function showVqlPanel() {
  connectionPanel.classList.add("hidden");
  vqlPanel.classList.remove("hidden");
  disconnectBtn.classList.remove("hidden");
  vqlInput.focus();
  paintTabThumb();
  // The editor was sized while hidden, when it measured nothing.
  if (WINDOW_MODE) paintEditor();
}

// ===================== DISCONNECT =====================
disconnectBtn.addEventListener("click", () => {
  state.sessionId = null;
  state.domain = null;
  state.user = null;
  state.dataModel = null;
  state.apiVersion = null;
  vqlPanel.classList.add("hidden");
  connectionPanel.classList.remove("hidden");
  disconnectBtn.classList.add("hidden");
  closeHistory();
  whoamiBtn.classList.add("hidden");
  whoamiPopover.classList.add("hidden");
  setStatus("disconnected", "Disconnected");
  topbarUser.textContent = "";
  dmCounts.textContent = "";
  setChipState("idle");
  dmPanel.classList.add("hidden");
  dmEmptyState.classList.remove("hidden");
  dmTree.innerHTML = "";
  dmResetView();
  forgetLiveObjects();
  fieldStats = {};
  fieldStatsFailed.clear();
  clearTimeout(fieldStatsTimer);
  clearDocTypes();
  dataModelTime = null;
  resultsContainer.innerHTML = "";
  setResultsShown(false);
  queryTime.textContent = "";
  lastResultData = null;
  resultValues = null;
  lastRunQuery = "";
  resultMeta = null;
  resultsCount.title = "";
  resetResultsView();
});

// Popover toggles — close others when opening one
function closeHistory() {
  historyPopover.classList.add("hidden");
  historyBtn.setAttribute("aria-expanded", "false");
}

function closeAllPopovers() {
  whoamiPopover.classList.add("hidden");
  closeHistory();
}

whoamiBtn.addEventListener("click", () => {
  const wasHidden = whoamiPopover.classList.contains("hidden");
  closeAllPopovers();
  if (wasHidden) whoamiPopover.classList.remove("hidden");
});

whoamiClose.addEventListener("click", closeAllPopovers);

// The pill in the editor's corner drops the list under itself. It sits inside
// the editor's wrapper, so autocomplete doesn't close by itself; close it here.
historyBtn.addEventListener("click", () => {
  const wasHidden = historyPopover.classList.contains("hidden");
  closeAllPopovers();
  hideAc();
  if (wasHidden) {
    historyPopover.classList.remove("hidden");
    historyBtn.setAttribute("aria-expanded", "true");
  }
});

// ===================== RUN VQL =====================
runBtn.addEventListener("click", runQuery);
cancelBtn.addEventListener("click", () => {
  if (!activeQueryToken) return;
  activeQueryToken.aborted = true;
  cancelBtn.disabled = true;
  cancelBtn.innerHTML = "Cancelling...";
  // resetButton() in runQuery will hide the button once the in-flight
  // request settles and restore its label/disabled state for next time.
});

// Clears the editor and the results together — a results table left standing
// under an empty editor no longer corresponds to anything, and its export
// buttons would hand back rows for a query that isn't on screen.
clearBtn.addEventListener("click", () => {
  vqlInput.value = "";
  editorChanged();
  historyNavIndex = -1;
  hideAc();
  resultsContainer.innerHTML = "";
  resultsContainer.style.maxHeight = "";
  setResultsShown(false);
  queryTime.textContent = "";
  lastResultData = null;
  queryRows = [];
  pendingEdits = {};
  resultValues = null;
  lastRunQuery = "";
  resultMeta = null;
  resultsCount.title = "";
  resetResultsView();
  updateSaveBar();
  vqlInput.focus();
});

vqlInput.addEventListener("keydown", (e) => {
  // Autocomplete navigation
  if (!acDropdown.classList.contains("hidden")) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      acIndex = Math.min(acIndex + 1, acItems.length - 1);
      renderAcSelection();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      acIndex = Math.max(acIndex - 1, 0);
      renderAcSelection();
      return;
    }
    if (e.key === "Tab" || e.key === "Enter") {
      if (acIndex >= 0 && acItems[acIndex]) {
        e.preventDefault();
        // Hidden first: a relationship ("rel.") opens the list again on its own.
        const chosen = acItems[acIndex];
        hideAc();
        insertAcItem(chosen);
        return;
      }
    }
    if (e.key === "Escape") {
      hideAc();
      return;
    }
  }

  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runQuery();
    return;
  }

  // Tab on an empty textarea fills it with the placeholder query as a starting
  // template. Only triggers when empty so Tab still works as focus-shift /
  // indent in normal editing.
  if (e.key === "Tab" && !e.shiftKey && vqlInput.value.length === 0) {
    const template = vqlInput.getAttribute("placeholder") || "";
    if (template) {
      e.preventDefault();
      vqlInput.value = template;
      vqlInput.setSelectionRange(template.length, template.length);
      editorChanged();
      return;
    }
  }

  // History navigation via Down/Up — only kicks in when the textarea is empty
  // (or when already cycling through history) so it never fights normal cursor
  // movement inside an in-progress query.
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const navigable = state.history.slice(0, HISTORY_NAV_LIMIT);
    if (navigable.length === 0) return;
    const isEmpty = vqlInput.value.length === 0;

    if (e.key === "ArrowDown") {
      if (historyNavIndex === -1 && !isEmpty) return;
      e.preventDefault();
      historyNavIndex = Math.min(historyNavIndex + 1, navigable.length - 1);
      vqlInput.value = navigable[historyNavIndex].query;
      vqlInput.setSelectionRange(vqlInput.value.length, vqlInput.value.length);
      editorChanged();
      return;
    }

    // ArrowUp only meaningful while already navigating.
    if (historyNavIndex === -1) return;
    e.preventDefault();
    historyNavIndex -= 1;
    if (historyNavIndex < 0) {
      historyNavIndex = -1;
      vqlInput.value = "";
    } else {
      vqlInput.value = navigable[historyNavIndex].query;
      vqlInput.setSelectionRange(vqlInput.value.length, vqlInput.value.length);
    }
    editorChanged();
  }
});

vqlInput.addEventListener("input", () => {
  // Any manual edit exits history-navigation mode.
  historyNavIndex = -1;
  editorChanged();
  showAutocomplete();
});

// INSERT chips — insert keyword at cursor with surrounding spaces, and (for
// value-taking operators) drop the cursor inside an empty literal so the user
// can type the value immediately.
const OPERATOR_TEMPLATES = {
  // [textToInsert, cursorOffsetFromStartOfInsert]
  // null offset = cursor goes to end of insert.
  WHERE:    ["WHERE ", null],
  AND:      ["AND ", null],
  CONTAINS: ["CONTAINS ('')", 11],
  LIKE:     ["LIKE ''", 6],
  EQ:       ["= ''", 3],
};

function insertAtCursor(text, cursorOffset = null) {
  const pos = vqlInput.selectionStart;
  const before = vqlInput.value.slice(0, pos);
  const after = vqlInput.value.slice(pos);
  const needsSpace =
    before.length > 0 && !/[\s(]$/.test(before);
  const lead = needsSpace ? " " : "";
  vqlInput.value = before + lead + text + after;
  const insertStart = pos + lead.length;
  const newPos = cursorOffset != null
    ? insertStart + cursorOffset
    : insertStart + text.length;
  vqlInput.setSelectionRange(newPos, newPos);
  vqlInput.focus();
  editorChanged();
  // Reset history navigation since the user is now editing.
  historyNavIndex = -1;
}

// ===================== INSERT =====================
// The pill slides the chips out in the toolbar row itself; while they're out
// the row's other chips step aside (CSS, on .inserting). An insert, the pill
// again, or Esc puts them back.
function setInsertOpen(open) {
  insertRow.hidden = !open;
  operatorBar.classList.toggle("inserting", open);
  insertChip.setAttribute("aria-expanded", String(open));
  insertChip.title = open ? "Close" : "Insert VQL at the cursor";
  if (open) hideAc();
}

insertChip.addEventListener("click", () => setInsertOpen(insertRow.hidden));

// Vault wants an ISO-8601 instant; toISOString() already emits exactly the
// 2024-03-02T15:47:44.000Z shape. Anchoring to midnight UTC keeps a query
// stable when it is re-run later the same day.
function isoMidnightDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

insertRow.addEventListener("click", (e) => {
  const op = e.target.closest("[data-op]");
  const day = e.target.closest("[data-days]");
  if (op) {
    const tpl = OPERATOR_TEMPLATES[op.dataset.op];
    if (tpl) insertAtCursor(tpl[0], tpl[1]);
  } else if (day) {
    insertAtCursor(`'${isoMidnightDaysAgo(Number(day.dataset.days))}'`);
  } else {
    return;
  }
  setInsertOpen(false);
});

document.addEventListener("click", (e) => {
  if (!historyPopover.classList.contains("hidden") && !e.target.closest("#history-popover, #history-btn")) {
    closeHistory();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!insertRow.hidden) {
    const inside = insertRow.contains(document.activeElement);
    setInsertOpen(false);
    if (inside) insertChip.focus();
  }
  if (!historyPopover.classList.contains("hidden")) {
    const inside = historyPopover.contains(document.activeElement);
    closeHistory();
    if (inside) historyBtn.focus();
  }
});

// ===================== QUERY CLAUSES =====================
// Used by the error hints to read what a failed query asked for.

// Top-level tokens only: a string literal is one token, so "order by" inside
// quotes never reads as a clause.
function topTokens(q) {
  return vqlTokens(q).filter((x) => x.depth === 0);
}

// The top-level ORDER BY [RANK], as token positions, or null.
function vqlOrderBy(q) {
  const toks = topTokens(q);
  const i = toks.findIndex((x, j) => /^order$/i.test(x.t) && /^by$/i.test(toks[j + 1]?.t || ""));
  if (i < 0) return null;
  return { at: toks[i].at, rank: /^rank$/i.test(toks[i + 2]?.t || ""), rankEnd: toks[i + 2]?.end };
}

const FETCH_ALL_PAGE_SIZE = 1000;
const FETCH_ALL_CONCURRENCY = 5;
// Vault rejects PAGEOFFSET values above 10,000. With PAGESIZE 1000 the highest
// safe offset is 9,000 (returns rows 9000-9999). Beyond that, follow
// responseDetails.next_page tokens, which have no cap but are sequential.
const VAULT_PAGEOFFSET_LIMIT = 10000;
// Beyond this many pages (~100k rows), in-popup table rendering becomes
// painfully slow, so we skip the table and auto-download the results as xlsx.
const AUTO_EXPORT_PAGE_THRESHOLD = 100;

// Strip trailing top-level paging/sizing clauses so we can inject our own.
// Only strips what's at the very end of the statement — subqueries are untouched.
function stripVqlTrailingPaging(q) {
  let out = q.trim().replace(/[;\s]+$/, "");
  while (true) {
    const m = out.match(/\s+(PAGESIZE|PAGEOFFSET|LIMIT|OFFSET|MAXROWS|SKIP)\s+\d+\s*$/i);
    if (!m) break;
    out = out.slice(0, m.index).trim();
  }
  return out;
}

// A trailing SKIP n. It comes off with the paging clauses — Veeva doesn't
// document SKIP alongside PAGEOFFSET, which every page here sends — and is
// applied to the fetched rows instead: rows n+1 onwards, then the cap.
function extractVqlSkip(q) {
  let out = q.trim().replace(/[;\s]+$/, "");
  let skip = 0;
  while (true) {
    const m = out.match(/\s+(PAGESIZE|PAGEOFFSET|LIMIT|OFFSET|MAXROWS|SKIP)\s+(\d+)\s*$/i);
    if (!m) break;
    if (/^SKIP$/i.test(m[1])) skip = parseInt(m[2], 10);
    out = out.slice(0, m.index).trim();
  }
  return skip;
}

// The cap on total rows the query sets for itself, from the trailing clauses
// stripVqlTrailingPaging takes off: MAXROWS, or LIMIT. VQL deprecated LIMIT in
// v20.3, where it meant rows per page; here it has always meant "this many in
// all", as people who write SQL expect. Paging is ours to drive, so the cap is
// applied to what's fetched instead of being sent.
function extractVqlTopLimit(q) {
  let out = q.trim().replace(/[;\s]+$/, "");
  let cap = null;
  while (true) {
    const m = out.match(/\s+(PAGESIZE|PAGEOFFSET|LIMIT|OFFSET|MAXROWS|SKIP)\s+(\d+)\s*$/i);
    if (!m) break;
    if (/^(LIMIT|MAXROWS)$/i.test(m[1])) {
      const n = parseInt(m[2], 10);
      cap = cap == null ? n : Math.min(cap, n);
    }
    out = out.slice(0, m.index).trim();
  }
  return cap;
}

async function runQuery() {
  const raw = vqlInput.value.trim();
  if (!raw) return;
  if (!state.sessionId) {
    showError("Not connected. Please connect first.");
    return;
  }

  hideAc();
  runBtn.disabled = true;
  runBtn.innerHTML = '<span class="spinner"></span> Running...';
  cancelBtn.classList.remove("hidden");
  queryTime.textContent = "";
  resultsContainer.innerHTML = "";
  setResultsShown(false);
  lastResultData = null;
  resetResultsView();

  const token = { aborted: false };
  activeQueryToken = token;
  setQueryBusy(true);

  // A LIMIT written in the query wins over the toolbar's Limit.
  const rowCap = extractVqlTopLimit(raw) ?? uiRowLimit();
  const skipRows = extractVqlSkip(raw);
  // What has to be fetched to hand back `rowCap` rows after skipping.
  const userLimit = rowCap != null ? rowCap + skipRows : null;
  const baseQuery = stripVqlTrailingPaging(raw);
  const startTime = performance.now();
  lastRunQuery = raw;
  resultValues = null;
  resultMeta = null;

  // The Names/Labels switch acts on the query as it goes out: eligible fields
  // are wrapped in TONAME() or TOLABEL(). The editor keeps what was typed.
  const shape = vqlShape(baseQuery);
  const isShow = !!shape.show;
  const rewrite = rewriteForValueMode(baseQuery);
  let sentQuery = rewrite.query;
  let valueFallback = false;

  // Per-record permissions come back alongside the rows when asked for: which
  // fields this user can edit on each record, after Atomic Security. Only
  // worth asking when the rows can be edited at all — they carry an id, and
  // they aren't every version of a document.
  // Documents have their own header from v26.2; the objects one lists editable
  // fields from v24.2 (before that it only reports hidden and redacted ones).
  const editableRun = !isShow && shape.target && shape.select.includes("id") && shape.option !== "ALLVERSIONS";
  let propsHeaders = null;
  if (editableRun && isDocumentsTarget(shape.target)) {
    if (apiAtLeast("v26.2")) propsHeaders = { "X-VaultAPI-DocumentProperties": "all" };
  } else if (editableRun && apiAtLeast("v24.2")) {
    propsHeaders = { "X-VaultAPI-RecordProperties": "all" };
  }

  // --- First page: also tells us responseDetails.total ---
  // Under a limit smaller than a page, ask for just that many rows; the page
  // count below then comes out as one and nothing more is fetched. SHOW takes
  // no other clauses, so it goes out exactly as typed.
  const firstPageSize = userLimit != null && userLimit > 0
    ? Math.min(FETCH_ALL_PAGE_SIZE, userLimit)
    : FETCH_ALL_PAGE_SIZE;
  const pageQuery = (q, size, offset) =>
    isShow ? `q=${encodeURIComponent(q)}` : `q=${encodeURIComponent(`${q} PAGESIZE ${size} PAGEOFFSET ${offset}`)}`;
  // The first page also asks Vault to describe the columns: labels and types
  // for exactly what came back, lookups included.
  const firstPage = (q, props) =>
    apiCall("/query", "POST", pageQuery(q, firstPageSize, 0), { "X-VaultAPI-DescribeQuery": "true", ...(props || {}) });
  const refused = (r) => r.success && r.data?.responseStatus === "FAILURE";

  // Asked in order until Vault takes one. A vault that won't take the
  // permissions header still runs the query without it; and Vault can refuse
  // the Names/Labels form where the typed one works — a raw object, a field it
  // won't take the function on — so that runs as typed rather than failing a
  // query that was fine. A query that's simply wrong fails every attempt and
  // reports the last.
  // The refused function is the likelier cause, so the typed form goes next.
  const attempts = [{ q: sentQuery, props: propsHeaders, plain: false }];
  if (rewrite.fields.length) attempts.push({ q: baseQuery, props: propsHeaders, plain: true });
  if (propsHeaders) {
    attempts.push({ q: sentQuery, props: null, plain: false });
    if (rewrite.fields.length) attempts.push({ q: baseQuery, props: null, plain: true });
  }
  let firstResult = null;
  for (const a of attempts) {
    firstResult = await firstPage(a.q, a.props);
    if (token.aborted || !refused(firstResult)) {
      sentQuery = a.q;
      propsHeaders = a.props;
      valueFallback = a.plain && firstResult.success;
      break;
    }
  }

  const resetButton = () => {
    runBtn.disabled = false;
    runBtn.innerHTML = RUN_LABEL;
    cancelBtn.classList.add("hidden");
    cancelBtn.disabled = false;
    cancelBtn.innerHTML = "Cancel";
    if (activeQueryToken === token) activeQueryToken = null;
    setQueryBusy(false);
  };

  const handleAbort = () => {
    resultsContainer.innerHTML = '<div class="result-message info">Query cancelled.</div>';
    resetButton();
  };

  if (token.aborted) { handleAbort(); return; }

  if (!firstResult.success) {
    showError(firstResult.error);
    resetButton();
    return;
  }

  const firstData = firstResult.data;
  if (firstData.responseStatus === "FAILURE") {
    const errMsg = firstData.errors?.map((e) => `${e.type}: ${e.message}`).join("\n") || "Query failed";
    showError(errMsg + vqlLimitAdvice(baseQuery));
    addToHistory(raw, false);
    resetButton();
    return;
  }

  const reportedTotal = firstData.responseDetails?.total;
  const firstPageRows = firstData.data || [];
  const effectiveTotal = userLimit != null
    ? Math.min(userLimit, reportedTotal ?? firstPageRows.length)
    : (reportedTotal ?? firstPageRows.length);
  // Vault scales a page down for wide rows or long text, with or without a
  // PAGESIZE ("expecting 1000 results per page but the system only returned
  // 400"), so the page it actually sent sets the step. Stepping by 1000 over
  // 400-row pages would skip 600 rows each time.
  const step = !isShow && firstPageRows.length > 0 && firstPageRows.length < firstPageSize && firstPageRows.length < effectiveTotal
    ? firstPageRows.length
    : FETCH_ALL_PAGE_SIZE;
  // SHOW can't be paged by offset; anything past its first page comes by next_page.
  const pagesNeeded = isShow ? 1 : Math.max(1, Math.ceil(effectiveTotal / step));

  // Phase 1: parallel PAGEOFFSET fan-out, capped at Vault's 10,000 ceiling.
  const maxParallelPages = Math.max(1, Math.floor(VAULT_PAGEOFFSET_LIMIT / step));
  const parallelPages = Math.min(pagesNeeded, maxParallelPages);
  // Store full responses so we can read next_page from the last one for Phase 2.
  const parallelResponses = new Array(parallelPages);
  parallelResponses[0] = firstData;

  let failure = null;
  let completed = 1;
  const totalLabel = pagesNeeded > maxParallelPages ? `${pagesNeeded}+` : `${pagesNeeded}`;
  const updateProgress = () => {
    runBtn.innerHTML = `<span class="spinner"></span> ${completed}/${totalLabel} pages`;
  };

  if (parallelPages > 1) {
    updateProgress();
    const offsetsToFetch = [];
    for (let p = 1; p < parallelPages; p++) offsetsToFetch.push(p * step);

    const worker = async () => {
      while (offsetsToFetch.length && !failure && !token.aborted) {
        const off = offsetsToFetch.shift();
        const pageIndex = off / step;
        const res = await apiCall("/query", "POST", pageQuery(sentQuery, step, off), propsHeaders);
        if (failure || token.aborted) return;
        if (!res.success) { failure = res.error || "Network error"; return; }
        if (res.data?.responseStatus === "FAILURE") {
          failure = res.data.errors?.map((e) => `${e.type}: ${e.message}`).join("\n") || "Page query failed";
          return;
        }
        parallelResponses[pageIndex] = res.data;
        completed++;
        updateProgress();
      }
    };

    const workerCount = Math.min(FETCH_ALL_CONCURRENCY, parallelPages - 1);
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  if (token.aborted) { handleAbort(); return; }

  if (failure) {
    showError(`Query failed: ${failure}`);
    resetButton();
    return;
  }

  const merged = [];
  const pageProps = [];
  for (const resp of parallelResponses) {
    if (resp?.data) merged.push(...resp.data);
    pageProps.push(resp);
  }
  // A later page that Vault scaled down further than the first leaves a gap.
  const expectedRows = isShow ? merged.length : Math.min(effectiveTotal, parallelPages * step);
  const shortBy = Math.max(0, expectedRows - merged.length);

  // Phase 2: follow next_page tokens for results beyond the 10,000-row cap.
  // Sequential by necessity — each page's URL is only known from the previous response.
  if (isShow || pagesNeeded > parallelPages || (userLimit == null && reportedTotal == null)) {
    let nextPage = parallelResponses[parallelPages - 1]?.responseDetails?.next_page;
    while (nextPage && !token.aborted && (userLimit == null || merged.length < userLimit)) {
      // Veeva: "Call these URLs with a POST request."
      let res = await apiCall(nextPage, "POST", null, propsHeaders);
      if (propsHeaders && res.success && res.data?.responseStatus === "FAILURE" && !token.aborted) {
        res = await apiCall(nextPage, "POST", null, null);
        if (res.success && res.data?.responseStatus !== "FAILURE") propsHeaders = null;
      }
      if (token.aborted) break;
      if (!res.success) { failure = res.error || "Network error"; break; }
      if (res.data?.responseStatus === "FAILURE") {
        failure = res.data.errors?.map((e) => `${e.type}: ${e.message}`).join("\n") || "Page query failed";
        break;
      }
      const pageRows = res.data?.data || [];
      if (pageRows.length === 0) break;
      merged.push(...pageRows);
      pageProps.push(res.data);
      completed++;
      updateProgress();
      nextPage = res.data?.responseDetails?.next_page;
    }
  }

  if (token.aborted) { handleAbort(); return; }

  if (failure) {
    showError(`Query failed: ${failure}`);
    resetButton();
    return;
  }

  const wrapped = valueFallback ? [] : rewrite.fields;
  const finalRows = normalizeWrappedKeys(
    merged.slice(skipRows, userLimit != null ? userLimit : undefined),
    wrapped
  );
  // The documents permissions header adds document_version to every row;
  // drop it unless the query asked for it.
  if (propsHeaders?.["X-VaultAPI-DocumentProperties"] && !shape.select.includes("document_version")) {
    for (const row of finalRows) delete row.document_version;
  }
  resultMeta = buildResultMeta(shape, firstData.queryDescribe, pageProps);
  resultValues = {
    mode: valueMode,
    fn: rewrite.fn,
    fields: new Set(wrapped.map((f) => f.toLowerCase())),
    fallback: valueFallback,
    sent: sentQuery,
  };

  const elapsedMs = performance.now() - startTime;
  const elapsed = (elapsedMs / 1000).toFixed(2);
  queryTime.textContent = completed > 1
    ? `${elapsed}s · ${completed} pages`
    : `${elapsed}s`;

  resetButton();

  // Combined response so Copy/CSV/Excel operate on the full set. The
  // per-record properties were for this view's editing; the first page's
  // share of them alone would read as the whole set's.
  lastResultData = {
    ...firstData,
    data: finalRows,
    responseDetails: {
      ...(firstData.responseDetails || {}),
      total: finalRows.length,
      pagesize: finalRows.length,
      pageoffset: 0,
    },
  };
  delete lastResultData.record_properties;
  delete lastResultData.document_properties;
  addToHistory(raw, true);

  if (finalRows.length > 0) {
    const ofTotal = reportedTotal != null && reportedTotal > finalRows.length ? ` of ${reportedTotal}` : "";
    if (WINDOW_MODE) {
      // Rows and time in one readout; the run button no longer has a line under
      // it for the timing to sit on.
      const n = finalRows.length;
      const pages = completed > 1 ? ` · ${completed} pages` : "";
      const of = ofTotal ? ` of ${reportedTotal.toLocaleString()}` : "";
      resultsCount.textContent =
        `${n.toLocaleString()}${of} row${n !== 1 ? "s" : ""} · ${formatMs(elapsedMs)}${pages}`;
    } else {
      resultsCount.textContent = `${finalRows.length} record${finalRows.length !== 1 ? "s" : ""}${ofTotal}`;
    }
    resultsCount.textContent += valueModeNote(resultValues);
    resultsCount.title = valueModeTitle(resultValues);
    if (shortBy) {
      resultsCount.textContent += ` · ${shortBy.toLocaleString()} missing`;
      resultsCount.title = [
        `Vault counted ${expectedRows.toLocaleString()} rows for these pages but sent ${(expectedRows - shortBy).toLocaleString()}: it made some pages smaller than the first. Selecting fewer or shorter fields, or adding ORDER BY, usually avoids it.`,
        resultsCount.title,
      ].filter(Boolean).join("\n\n");
    }
    setResultsShown(true);
    // Large result sets: skip the in-popup table render (it would freeze the UI)
    // and stream straight to an xlsx download. Copy/CSV/Excel buttons remain
    // available so the user can re-export from lastResultData if needed.
    const autoExport = pagesNeeded > AUTO_EXPORT_PAGE_THRESHOLD || completed > AUTO_EXPORT_PAGE_THRESHOLD;
    if (autoExport) {
      downloadXlsx(finalRows);
      resultsContainer.innerHTML = `<div class="result-message info">Large result set (${finalRows.length} records, ${completed} pages) &mdash; auto-downloaded as Excel. Table render skipped to keep the popup responsive.</div>`;
    } else {
      renderTable(finalRows);
    }
  } else {
    resultsContainer.innerHTML = '<div class="result-message info">Query returned no results.</div>';
    setResultsShown(false);
  }
}

// Every caller that hid or showed the header now goes through here, because the
// full window keeps the "Results" heading up and only hides the controls.
function setResultsShown(on) {
  resultsPanel.classList.toggle("has-results", on);
}

// ===================== VALUES: NAMES OR LABELS =====================
// Vault answers these fields in opposite forms depending on the target:
// documents give labels ("Approved") unless a field is wrapped in TONAME()
// (v20.3+); objects give names ("approved__c") unless it is wrapped in
// TOLABEL() (v24.1+; not on raw objects). One switch hides that difference:
// "names" or "labels" means the same thing for any query, and the extension
// picks the function. Source: the TONAME() and TOLABEL() pages of Veeva's VQL
// reference.
const VALUE_MODES = ["names", "labels"];
// What the toggle calls each mode.
const VALUE_MODE_LABELS = { names: "Field Names", labels: "Field Values" };
let valueMode = "names";

// What the last run applied — which columns came back rewritten, and how —
// so they can be held read-only and the readout can say so.
let resultValues = null;
// The query text the results on screen came from, as typed.
let lastRunQuery = "";

// The fields each function takes besides picklists, which come from the model.
const VALUE_SYSTEM_FIELDS = {
  documents: ["lifecycle__v", "status__v", "type__v", "subtype__v", "classification__v"],
  objects: ["lifecycle__v", "state__v", "object_type__v"],
};

const valueField = $("#value-field");
const valueChipLabel = $("#value-chip-label");

// The query target: the word after the top-level FROM, past ALLVERSIONS and the
// other options that can sit in front of it.
function vqlTarget(query, fromAt) {
  const re = new RegExp(VQL_TOKEN_RE.source, "g");
  re.lastIndex = fromAt;
  const words = [];
  let m;
  while (words.length < 3 && (m = re.exec(query))) {
    if (!/^\s/.test(m[0])) words.push(m[0]);
  }
  const i = /^(ALLVERSIONS|LATESTVERSION|RECENT|FAVORITES)$/i.test(words[1] || "") ? 2 : 1;
  return /^[A-Za-z_]\w*$/.test(words[i] || "") && !VQL_NOT_TARGET_RE.test(words[i]) ? words[i].toLowerCase() : null;
}

// Wraps the eligible fields of the top-level SELECT list for the current mode.
// Only bare field names are touched: WHERE, ORDER BY and subqueries keep
// meaning exactly what was typed, a field the query already wraps itself is
// left alone (a second copy would come back under the same key), and nothing
// is aliased — AS needs v24.2 on a plain field, which an older vault is still
// called below, and an alias can't reuse the field's own name anyway.
// Returns the query to send, the function used and the fields it wrapped.
function rewriteForValueMode(query) {
  const none = { query, fn: null, fields: [] };
  const span = vqlSelectListSpan(query);
  if (!span) return none;
  const target = vqlTarget(query, span.end);
  if (!target) return none;

  const isDocs = target === "documents";
  // Documents already come back as labels and objects as names, so each mode
  // only has work to do on one side. Object names carry a suffix (product__v,
  // user__sys); targets without one (users, groups, binders) are left as they are.
  const fn = valueMode === "names"
    ? (isDocs ? "TONAME" : null)
    : (!isDocs && /__[a-z]+$/.test(target) ? "TOLABEL" : null);
  if (!fn) return none;

  const obj = state.dataModel?.objects.find((o) => o.name.toLowerCase() === target);
  if (fn === "TOLABEL" && obj?.dataStore === "raw") return none;
  const eligible = new Set(VALUE_SYSTEM_FIELDS[isDocs ? "documents" : "objects"]);
  for (const f of obj?.fields || []) {
    if (/^picklist$/i.test(f.type || "")) eligible.add(f.name.toLowerCase());
  }

  let out = query;
  const fields = [];
  // Back to front, so earlier offsets stay valid as text is inserted.
  const items = vqlListItems(query, span);
  for (const item of [...items].reverse()) {
    const name = item.text.trim();
    if (!/^[A-Za-z_]\w*$/.test(name) || !eligible.has(name.toLowerCase())) continue;
    const wrappedRe = new RegExp(`\\b(TONAME|TOLABEL)\\s*\\(\\s*${name}\\s*\\)`, "i");
    if (items.some((it) => wrappedRe.test(it.text))) continue;
    const at = item.start + item.text.indexOf(name);
    out = `${out.slice(0, at)}${fn}(${name})${out.slice(at + name.length)}`;
    fields.unshift(name);
  }
  return fields.length ? { query: out, fn, fields } : none;
}

// Veeva's examples always alias a wrapped field, so the key an unaliased one
// comes back under isn't documented; the expectation is the field's own name.
// If it arrives as anything else ("TONAME(status__v)"), file it back under the
// name, so the table, exports and editing see the column the query asked for.
function normalizeWrappedKeys(rows, fields) {
  if (!rows.length || !fields.length) return rows;
  const keys = Object.keys(rows[0]);
  const renames = new Map();
  for (const f of fields) {
    if (keys.includes(f)) continue;
    const k = keys.find(
      (key) => /toname|tolabel|\(/i.test(key) && key.toLowerCase().includes(f.toLowerCase())
    );
    if (k) renames.set(k, f);
  }
  if (!renames.size) return rows;
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [renames.get(k) || k, v]))
  );
}

// The readout's suffix. The toggle already says which form the rows are in,
// so the readout only speaks up when Vault wouldn't give that form.
function valueModeNote(v) {
  return v?.fallback ? ` · ${VALUE_MODE_LABELS[v.mode]} unavailable` : "";
}

function valueModeTitle(v) {
  if (!v) return "";
  if (v.fallback) return `Vault refused ${v.fn}() on this query, so it ran as typed.`;
  if (!v.fields.size) return "";
  return `Sent as: ${v.sent}\n\n${[...v.fields].join(", ")} came back as ${VALUE_MODE_LABELS[v.mode]} and are read-only here.`;
}

// Whether a result column was rewritten by the switch — those stay read-only:
// an object picklist saves by name, and what a document picklist save expects
// isn't documented, so writing back what's on screen could store the wrong form.
function isWrappedColumn(key) {
  return !!resultValues?.fields.has(String(key).toLowerCase());
}

// The chip names the setting in force; its tooltip says what a click does.
function paintValueMode() {
  const names = valueMode === "names";
  valueChipLabel.textContent = VALUE_MODE_LABELS[valueMode].toUpperCase();
  // Field Values reads as switched on (see .value-chip.on).
  valueField.classList.toggle("on", !names);
  const tip = names
    ? "Showing field names: picklist, lifecycle state and type values as VQL writes them " +
      "(approved__c). Click for field values, as the Vault UI shows them (Approved)."
    : "Showing field values: picklist, lifecycle state and type values as the Vault UI shows " +
      "them (Approved). Click for field names, as VQL writes them (approved__c).";
  valueField.title = `${tip} Documents get TONAME(), objects TOLABEL(). Changing it runs the shown results again.`;
  valueField.setAttribute("aria-label", `${VALUE_MODE_LABELS[valueMode]}. ${names ? "Click for field values." : "Click for field names."}`);
}

function setValueMode(mode) {
  if (!VALUE_MODES.includes(mode) || mode === valueMode) return;
  valueMode = mode;
  paintValueMode();
  chrome.storage.local.set({ valueMode: mode });
  rerunForValueMode();
}

// The values come from Vault in one form or the other, so showing the other
// means asking again — but only for results that are still what the editor
// says, and only when the query would actually go out differently.
function rerunForValueMode() {
  if (activeQueryToken || !state.sessionId || !lastResultData) return;
  const raw = vqlInput.value.trim();
  if (raw !== lastRunQuery) return;
  if (rewriteForValueMode(stripVqlTrailingPaging(raw)).query === resultValues?.sent) return;
  const unsaved = Object.keys(pendingEdits).length;
  if (unsaved && !confirm(`Run the query again to show ${VALUE_MODE_LABELS[valueMode]}? That discards ${unsaved} unsaved change${unsaved === 1 ? "" : "s"}.`)) return;
  runQuery();
}

valueField.addEventListener("click", () => setValueMode(valueMode === "names" ? "labels" : "names"));

function showError(msg) {
  resultsContainer.innerHTML = `<div class="result-message error" role="alert">${esc(msg)}</div>`;
}

// ===================== COPY / EXPORT =====================
copyBtn.addEventListener("click", () => {
  if (lastResultData) {
    navigator.clipboard.writeText(JSON.stringify(lastResultData, null, 2));
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy JSON"), 1500);
  }
});

exportCsvBtn.addEventListener("click", () => {
  if (!lastResultData?.data?.length) return;
  const rows = lastResultData.data;
  const keys = resultColumns(rows);
  let csv = keys.map(csvEsc).join(",") + "\n";
  for (const row of rows) csv += keys.map((k) => csvEsc(exportText(row[k]))).join(",") + "\n";
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vql_results_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// A CSV field for Vault itself (the object update body): quoted when it has
// to be, and nothing else — the formula guard below is for spreadsheets.
function csvField(val) {
  const str = String(val ?? "");
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Excel, Sheets and LibreOffice treat a leading =, +, @, tab or CR as the
// start of a formula, so a value stored in Vault can run on whoever opens the
// export. The apostrophe forces the cell to text and is stripped on display.
// A leading "-" is left alone for a plain negative number — prefixing those
// would turn real figures into text.
function csvEsc(val) {
  let str = String(val);
  const formulaRisk =
    /^[=+@\t\r]/.test(str) || (str.startsWith("-") && !/^-\d+(\.\d+)?$/.test(str));
  if (formulaRisk) str = `'${str}`;
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// ===================== EXPORT EXCEL =====================
const exportXlsxBtn = $("#export-xlsx-btn");

// Every key across the rows, in first-seen order: a lookup can be missing from
// a row whose related record is empty.
function resultColumns(rows) {
  const keys = [];
  const seen = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return keys;
}

// A cell as text for CSV and for Excel's main sheet. Related records from a
// subquery go out as JSON so nothing is lost; Excel also gives them a sheet.
function exportText(val) {
  if (val === null || val === undefined) return "";
  if (isSubValue(val)) return JSON.stringify(val.data);
  if (typeof val === "object") return JSON.stringify(val);
  return val;
}

// Excel sheet names: at most 31 characters, none of : \ / ? * [ ], unique.
function sheetName(want, used) {
  const base = String(want).replace(/[:\\/?*\[\]]/g, "_").slice(0, 31) || "Sheet";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)}~${i}`;
  used.add(name.toLowerCase());
  return name;
}

// The main sheet, then one per subquery: each related record on its own row,
// led by the row it belongs to and that row's id.
function xlsxSheets(rows) {
  const keys = resultColumns(rows);
  const used = new Set();
  const sheets = [{ name: sheetName("Results", used), keys, rows }];
  for (const k of keys) {
    if (!rows.some((r) => isSubValue(r[k]))) continue;
    const childRows = [];
    rows.forEach((r, i) => {
      if (!isSubValue(r[k])) return;
      for (const child of r[k].data) childRows.push({ "parent row": i + 1, "parent id": r.id ?? "", ...child });
    });
    sheets.push({ name: sheetName(k, used), keys: resultColumns(childRows.length ? childRows : [{ "parent row": "", "parent id": "" }]), rows: childRows });
  }
  return sheets;
}

// XML 1.0 has no place for most control characters (a Word line break comes
// through as \u000B); one left in makes Excel call the whole file corrupt.
function xmlSafe(s) {
  return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "");
}

// Every cell, header included, uses cellXfs entry 1: a thin black border on all
// four sides (so the whole table gets an inner and an outer grid) and wrapped
// text, top-aligned so a tall wrapped cell doesn't push the rest of its row to
// the bottom. Entry 0 is the plain default every workbook must have.
const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// Wrapping needs a set width to wrap at: Excel's default (8.43 characters)
// would break most headers and values over several lines. Each column fits its
// longest line, header included, within these bounds in Excel's character
// units; anything longer wraps inside the cap.
const XLSX_COL_MIN = 10;
const XLSX_COL_MAX = 60;

function longestLine(s) {
  if (s.indexOf("\n") === -1) return s.length;
  let n = 0;
  for (const line of s.split("\n")) n = Math.max(n, line.length);
  return n;
}

function sheetXml(keys, rows) {
  const xmlEsc = (s) => xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const widths = keys.map((k) => longestLine(String(k)));
  let sheetRows = "<row>";
  for (const key of keys) sheetRows += `<c s="1" t="inlineStr"><is><t>${xmlEsc(key)}</t></is></c>`;
  sheetRows += "</row>";
  for (const row of rows) {
    sheetRows += "<row>";
    for (let i = 0; i < keys.length; i++) {
      const val = row[keys[i]];
      const text = typeof val === "number" ? String(val) : String(exportText(val));
      if (widths[i] < XLSX_COL_MAX) widths[i] = Math.max(widths[i], longestLine(text));
      if (typeof val === "number") {
        sheetRows += `<c s="1"><v>${val}</v></c>`;
      } else {
        sheetRows += `<c s="1" t="inlineStr"><is><t>${xmlEsc(text)}</t></is></c>`;
      }
    }
    sheetRows += "</row>";
  }
  // +2 for the cell's padding, so a value at exactly the measured width fits.
  const cols = widths
    .map((w, i) => {
      const width = Math.min(XLSX_COL_MAX, Math.max(XLSX_COL_MIN, w + 2));
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

function buildXlsxBlob(rows) {
  const sheets = xlsxSheets(rows);
  const xmlAttr = (s) => xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((sh, i) => `<sheet name="${xmlAttr(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`;

  // The styles part takes the id after the last sheet's.
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  // Build ZIP using minimal zip implementation
  const zip = new SimpleZip();
  zip.addFile("[Content_Types].xml", contentTypes);
  zip.addFile("_rels/.rels", rels);
  zip.addFile("xl/workbook.xml", workbook);
  zip.addFile("xl/_rels/workbook.xml.rels", workbookRels);
  zip.addFile("xl/styles.xml", XLSX_STYLES);
  sheets.forEach((sh, i) => zip.addFile(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh.keys, sh.rows)));

  return zip.toBlob();
}

function downloadXlsx(rows, filename) {
  const blob = buildXlsxBlob(rows);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `vql_results_${Date.now()}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

exportXlsxBtn.addEventListener("click", () => {
  if (!lastResultData?.data?.length) return;
  downloadXlsx(lastResultData.data);
});

// Minimal ZIP builder (no compression, store only — works for xlsx)
class SimpleZip {
  constructor() { this.files = []; }

  addFile(name, content) {
    const data = new TextEncoder().encode(content);
    this.files.push({ name: new TextEncoder().encode(name), data });
  }

  toBlob() {
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const file of this.files) {
      const crc = this._crc32(file.data);
      const localHeader = this._buildLocalHeader(file.name, file.data, crc);
      localHeaders.push(localHeader, file.data);

      const centralHeader = this._buildCentralHeader(file.name, file.data, crc, offset);
      centralHeaders.push(centralHeader);

      offset += localHeader.byteLength + file.data.byteLength;
    }

    const centralDirSize = centralHeaders.reduce((s, h) => s + h.byteLength, 0);
    const endRecord = this._buildEndRecord(this.files.length, centralDirSize, offset);

    return new Blob([...localHeaders, ...centralHeaders, endRecord], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  _buildLocalHeader(name, data, crc) {
    const buf = new ArrayBuffer(30 + name.byteLength);
    const view = new DataView(buf);
    view.setUint32(0, 0x04034b50, true); // signature
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true);  // flags
    view.setUint16(8, 0, true);  // compression (store)
    view.setUint16(10, 0, true); // mod time
    view.setUint16(12, 0, true); // mod date
    view.setUint32(14, crc, true);
    view.setUint32(18, data.byteLength, true); // compressed
    view.setUint32(22, data.byteLength, true); // uncompressed
    view.setUint16(26, name.byteLength, true);
    view.setUint16(28, 0, true); // extra field length
    new Uint8Array(buf, 30).set(name);
    return new Uint8Array(buf);
  }

  _buildCentralHeader(name, data, crc, localOffset) {
    const buf = new ArrayBuffer(46 + name.byteLength);
    const view = new DataView(buf);
    view.setUint32(0, 0x02014b50, true); // signature
    view.setUint16(4, 20, true);  // version made by
    view.setUint16(6, 20, true);  // version needed
    view.setUint16(8, 0, true);   // flags
    view.setUint16(10, 0, true);  // compression
    view.setUint16(12, 0, true);  // mod time
    view.setUint16(14, 0, true);  // mod date
    view.setUint32(16, crc, true);
    view.setUint32(20, data.byteLength, true);
    view.setUint32(24, data.byteLength, true);
    view.setUint16(28, name.byteLength, true);
    view.setUint16(30, 0, true);  // extra
    view.setUint16(32, 0, true);  // comment
    view.setUint16(34, 0, true);  // disk
    view.setUint16(36, 0, true);  // internal attrs
    view.setUint32(38, 0, true);  // external attrs
    view.setUint32(42, localOffset, true);
    new Uint8Array(buf, 46).set(name);
    return new Uint8Array(buf);
  }

  _buildEndRecord(count, centralSize, centralOffset) {
    const buf = new ArrayBuffer(22);
    const view = new DataView(buf);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);  // disk
    view.setUint16(6, 0, true);  // central dir disk
    view.setUint16(8, count, true);
    view.setUint16(10, count, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true); // comment length
    return new Uint8Array(buf);
  }

  _crc32(data) {
    if (!SimpleZip._table) {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      SimpleZip._table = t;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = SimpleZip._table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
}

// ===================== HISTORY =====================
function addToHistory(query, success) {
  state.history = state.history.filter((h) => h.query !== query);
  const entry = { query, success, ts: Date.now() };
  // Which query tab ran it, so the recent list can say where it came from.
  if (WINDOW_MODE && activeTabId) entry.tab = activeTabId;
  state.history.unshift(entry);
  state.history = state.history.slice(0, 20);
  chrome.storage.local.set({ queryHistory: state.history });
  renderHistory();
}

function renderHistory() {
  renderRecent();
  if (state.history.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No queries yet</div>';
    return;
  }
  historyList.innerHTML = state.history
    .map(
      (h, i) =>
        `<div class="history-item" data-index="${i}" title="${esc(h.query)}">${esc(h.query)}</div>`
    )
    .join("");
}

historyList.addEventListener("click", (e) => {
  const item = e.target.closest(".history-item");
  if (item) {
    closeHistory();
    loadHistoryQuery(parseInt(item.dataset.index));
  }
});

// Puts a past query in the editor — in the full window, the current tab's —
// without running it.
function loadHistoryQuery(index) {
  const entry = state.history[index];
  if (!entry) return;
  vqlInput.value = entry.query;
  historyNavIndex = -1;
  activatePane("query");
  vqlInput.focus();
  vqlInput.setSelectionRange(vqlInput.value.length, vqlInput.value.length);
  editorChanged();
}

clearHistoryBtn.addEventListener("click", () => {
  state.history = [];
  chrome.storage.local.set({ queryHistory: [] });
  renderHistory();
});

// ===================== DATA MODEL =====================
// The chip is the only load affordance and the only readout of model state, so
// it carries all four phases: idle, loading (with progress), loaded, failed.
let modelLoading = false;

// Both loaders — the data model and the document types — are long, progress-
// bearing fetches, so they share one chip with four phases. Parameterised rather
// than duplicated so the two can't drift apart.
function applyChipState(chip, labelEl, phase, labels, opts = {}) {
  chip.classList.remove("loading", "loaded", "failed");
  chip.style.backgroundImage = "";

  if (phase === "loading") {
    const { done = 0, total = 0 } = opts;
    const pct = total ? Math.round((done / total) * 100) : 0;
    chip.classList.add("loading");
    chip.style.backgroundImage =
      `linear-gradient(90deg, rgba(192,138,46,.45) ${pct}%, transparent ${pct}%)`;
    labelEl.textContent = total ? `${done}/${total}` : "LOADING";
    chip.title = opts.title || labels.loadingTitle;
  } else if (phase === "loaded") {
    chip.classList.add("loaded");
    labelEl.textContent = labels.loaded;
    chip.title = opts.title || labels.loadedTitle;
  } else if (phase === "failed") {
    chip.classList.add("failed");
    labelEl.textContent = "FAILED";
    chip.title = opts.title || "Load failed — click to retry";
  } else {
    labelEl.textContent = labels.idle;
    chip.title = labels.idleTitle;
  }
}

const MODEL_CHIP_LABELS = {
  idle: "LOAD MODEL",
  idleTitle: "Load data model — enables autocomplete",
  loading: "LOADING",
  loadingTitle: "Loading data model",
  loaded: "MODELS",
  loadedTitle: "Reload data model",
};

function setChipState(phase, opts = {}) {
  applyChipState(modelChip, modelChipLabel, phase, MODEL_CHIP_LABELS, opts);
}

modelChip.addEventListener("click", () => {
  if (modelLoading) return;
  loadDataModel();
});

async function loadDataModel() {
  if (!state.sessionId) {
    dmTree.innerHTML = '<div class="dm-empty">Connect to a Vault first.</div>';
    return;
  }

  modelLoading = true;
  setChipState("loading", { title: "Fetching object list…" });
  dmTree.innerHTML = "";

  try {
    // Step 1: Get all vobjects
    const objListResult = await apiCall("/metadata/vobjects");
    if (!objListResult.success) throw new Error(objListResult.error);

    const objListData = objListResult.data;
    let objectNames = [];

    if (objListData.objects) {
      objectNames = objListData.objects.map((o) => ({
        name: o.name || o.object_name || o.name__v,
        label: o.label || o.label__v || o.name || "",
        url: o.url || "",
      }));
    }

    // Also add "documents" as a queryable object (standard Vault object)
    const hasDocuments = objectNames.some((o) => o.name === "documents");
    if (!hasDocuments) {
      objectNames.unshift({ name: "documents", label: "Documents", url: "" });
    }

    const total = objectNames.length;
    setChipState("loading", { done: 0, total, title: `Loading fields for ${total} objects…` });

    // Step 2: Fetch fields for each object in batches
    const BATCH_SIZE = 5;
    const objects = [];
    let completed = 0;

    for (let i = 0; i < objectNames.length; i += BATCH_SIZE) {
      const batch = objectNames.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (obj) => {
          try {
            let endpoint;
            if (obj.name === "documents") {
              endpoint = "/metadata/objects/documents/properties";
            } else {
              endpoint = `/metadata/vobjects/${obj.name}`;
            }
            const res = await apiCall(endpoint);
            return { obj, res };
          } catch (e) {
            return { obj, res: { success: false, error: e.message } };
          }
        })
      );

      for (const { obj, res } of results) {
        completed++;
        setChipState("loading", {
          done: completed,
          total,
          title: `Loading fields… ${completed}/${total} (${obj.name})`,
        });

        const fields = extractFields(obj.name, res);
        const rels = extractRelationships(res);
        objects.push({
          name: obj.name,
          label: obj.label,
          fields: fields,
          relationships: rels.own,
          inboundElsewhere: rels.elsewhere,
          // "raw" objects don't take TOLABEL(); Names/Labels skips them.
          dataStore: res.success ? res.data?.object?.data_store : undefined,
        });
      }
    }

    // v25.2+: SHOW lists what the metadata crawl can't see — users, groups,
    // workflows, binders and the other non-object targets, and the documents
    // relationships with their exact names. Then both ends get linked.
    if (apiAtLeast("v25.2")) await addShowTargets(objects);
    linkRelationships(objects);

    // Sort objects alphabetically
    objects.sort((a, b) => a.name.localeCompare(b.name));

    state.dataModel = { objects };
    const loadTime = new Date().toISOString();
    // Save under the current vault domain so each instance has its own model,
    // and the panel and the full window both start with it. A failed save only
    // costs the next view; the model is loaded here either way.
    let unsaved = null;
    if (state.domain) {
      try {
        await saveVaultCache("dataModels", state.domain, { model: state.dataModel, time: loadTime });
      } catch (e) {
        unsaved = e;
      }
    }

    onDataModelLoaded(loadTime);
    if (unsaved) {
      setChipState("loaded", { title: `Loaded, but not saved for next time: ${unsaved.message}` });
    }
  } catch (err) {
    setChipState("failed", { title: `Load failed: ${err.message} — click to retry` });
    dmTree.innerHTML = `<div class="dm-empty">Could not load the data model.<br />${esc(err.message)}</div>`;
  } finally {
    modelLoading = false;
  }
}

function extractFields(objName, res) {
  if (!res.success || !res.data) return [];

  const data = res.data;
  let rawFields = [];

  // vobjects response: data.object.fields
  if (data.object?.fields) {
    rawFields = data.object.fields;
  }
  // Documents properties response: data.properties
  else if (data.properties) {
    rawFields = data.properties;
  }
  // Some responses have fields at top level
  else if (data.fields) {
    rawFields = data.fields;
  }
  // Array response
  else if (Array.isArray(data)) {
    rawFields = data;
  }

  return rawFields.map((f) => ({
    name: f.name || f.name__v || "",
    label: f.label || f.label__v || "",
    type: f.type || f.type__v || "unknown",
    required: f.required || f.required__v || false,
    editable: f.editable || f.editable__v || false,
    queryable: f.queryable !== undefined ? f.queryable : true,
    helpContent: f.help_content || f.help_content__v || "",
    maxLength: f.max_length || f.max_length__v || null,
    objectName: objName,
    picklist: f.picklist || f.picklist__v || null,
    relationship: f.relationship_type || f.lookup_relationship_name || null,
  }));
}

// ---- Relationships ------------------------------------------------------------
// The metadata loadDataModel already fetches carries every relationship: an
// object's `relationships` list (name, direction, field, target object) and,
// on documents, `relationshipName` on each object reference field. Kept as
// { name, dir, target, field, label }: "out" is a lookup (rel.field, one
// record), "in" a subquery ((SELECT … FROM rel), many records).
function relDirection(type) {
  return /inbound|child/i.test(String(type || "")) ? "in" : "out";
}

function extractRelationships(res) {
  const own = new Map();
  const elsewhere = [];
  if (!res?.success || !res.data) return { own: [], elsewhere };
  const add = (name, dir, target, field, label) => {
    if (!name || own.has(name.toLowerCase())) return;
    own.set(name.toLowerCase(), { name, dir, target: target || null, field: field || null, label: label || null });
  };
  const obj = res.data.object;
  for (const r of obj?.relationships || []) {
    add(r.relationship_name, relDirection(r.relationship_type), r.object?.name, r.field, r.relationship_label);
  }
  for (const f of obj?.fields || []) {
    const target = f.object?.name || null;
    if (f.relationship_outbound_name) add(f.relationship_outbound_name, "out", target, f.name, f.label);
    // The inbound side belongs to the object the field points at.
    if (f.relationship_inbound_name && target) {
      elsewhere.push({ owner: target, name: f.relationship_inbound_name, field: f.name, label: f.relationship_inbound_label || null });
    }
  }
  // A document object field makes a document_…__vr (or __cr, for a custom
  // field) relationship that VQL treats as a collection from both ends, so it
  // is always a subquery.
  for (const p of res.data.properties || []) {
    if (p.relationshipName) add(p.relationshipName, "in", p.objectType, p.name, p.label);
  }
  return { own: [...own.values()], elsewhere };
}

// Fills in the far side of each relationship the crawl saw from one end only:
// a field's inbound name on the object it points at, and documents'
// document_x__vr on x.
function linkRelationships(objects) {
  const byName = new Map(objects.map((o) => [o.name.toLowerCase(), o]));
  const addTo = (obj, rel) => {
    if (!obj) return;
    obj.relationships = obj.relationships || [];
    if (!obj.relationships.some((r) => r.name.toLowerCase() === rel.name.toLowerCase())) obj.relationships.push(rel);
  };
  for (const o of objects) {
    for (const e of o.inboundElsewhere || []) {
      addTo(byName.get(e.owner.toLowerCase()), { name: e.name, dir: "in", target: o.name, field: e.field, label: e.label });
    }
    delete o.inboundElsewhere;
    if (o.name === "documents") {
      for (const r of o.relationships || []) {
        if (r.target) addTo(byName.get(r.target.toLowerCase()), { name: r.name, dir: "in", target: "documents", field: r.field, label: r.label });
      }
    }
  }
}

async function showQuery(q) {
  const res = await apiCall("/query", "POST", `q=${encodeURIComponent(q)}`);
  return apiOk(res) ? res.data?.data || [] : null;
}

const SHOW_TARGETS_MAX = 80;

function showRelationships(rows) {
  return (rows || []).map((r) => ({
    name: r.name,
    dir: /inbound/i.test(r.type || "") ? "in" : "out",
    target: r.target || null,
    field: null,
    label: null,
  }));
}

function showFields(name, rows) {
  return (rows || []).map((f) => ({
    name: f.name,
    label: f.label || "",
    type: f.type || "unknown",
    required: false,
    editable: false,
    queryable: true,
    helpContent: "",
    maxLength: null,
    objectName: name,
    picklist: null,
    relationship: f.relationship_name || null,
  }));
}

async function addShowTargets(objects) {
  const known = new Set(objects.map((o) => o.name.toLowerCase()));
  const docs = objects.find((o) => o.name === "documents");
  if (docs) {
    const rels = await showQuery("SHOW RELATIONSHIPS FROM documents");
    if (rels) {
      for (const r of showRelationships(rels)) {
        if (!docs.relationships.some((x) => x.name.toLowerCase() === r.name.toLowerCase())) docs.relationships.push(r);
      }
    }
  }
  const targets = await showQuery("SHOW TARGETS");
  if (!targets) return;
  const extra = targets.filter((t) => t?.name && !known.has(t.name.toLowerCase())).slice(0, SHOW_TARGETS_MAX);
  let done = 0;
  for (let i = 0; i < extra.length; i += 5) {
    await Promise.all(
      extra.slice(i, i + 5).map(async (t) => {
        const [fields, rels] = await Promise.all([
          showQuery(`SHOW FIELDS FROM ${t.name}`),
          showQuery(`SHOW RELATIONSHIPS FROM ${t.name}`),
        ]);
        objects.push({
          name: t.name,
          label: t.label && t.label !== t.name ? t.label : "",
          fields: showFields(t.name, fields),
          relationships: showRelationships(rels),
          // Not a Vault object: users, groups, workflows, binders and the like.
          kind: "target",
        });
        done++;
        setChipState("loading", { done, total: extra.length, title: `Other query targets… ${done}/${extra.length} (${t.name})` });
      })
    );
  }
}

// A model object by name, any case; null for anything the model doesn't hold.
function modelObject(name) {
  if (!name || !state.dataModel) return null;
  const n = String(name).toLowerCase();
  return state.dataModel.objects.find((o) => o.name.toLowerCase() === n) || null;
}

function objectRelationships(obj, dir) {
  return (obj?.relationships || []).filter((r) => !dir || r.dir === dir);
}

function relationshipOf(obj, relName) {
  if (!obj || !relName) return null;
  return objectRelationships(obj).find((x) => x.name.toLowerCase() === String(relName).toLowerCase()) || null;
}

// The object a relationship of `obj` leads to.
function relationshipTarget(obj, relName) {
  const r = relationshipOf(obj, relName);
  return r ? knownObject(r.target) : null;
}

// Before the FROM is typed there's no object to ask, but a lookup name
// usually means one thing across the whole model: use that when it does.
function relationshipTargetAnywhere(relName, dir) {
  const n = String(relName || "").toLowerCase();
  const targets = new Set();
  for (const o of [...(state.dataModel?.objects || []), ...liveObjects.values()]) {
    for (const r of o?.relationships || []) {
      if (r.name.toLowerCase() === n && (!dir || r.dir === dir) && r.target) targets.add(r.target.toLowerCase());
    }
  }
  return targets.size === 1 ? knownObject([...targets][0]) : null;
}

// ---- Objects looked up on demand ----------------------------------------------
// Suggestions shouldn't wait for the whole data model, which on a big vault is
// minutes of metadata calls. When the query names an object the model doesn't
// hold — or there is no model yet, or it was saved before relationships were
// kept — that one object is asked about: two SHOW queries on v25.2+, its
// metadata call before. Kept for the page's life, per vault. They feed
// autocomplete and the MORE menu only; editing still goes by the model.
const liveObjects = new Map();      // name -> { name, label, fields, relationships } | null (no such object)
const liveObjectsPending = new Map();
let liveTargets = null;             // [{ name, label }] for FROM suggestions with no model
let liveTargetsPending = null;

function knownObject(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  const m = modelObject(n);
  const live = liveObjects.get(n);
  if (m && (m.relationships || !live)) return m;
  // An older saved model: its fields, the relationships looked up now.
  if (m && live) return { ...m, relationships: live.relationships };
  return live || null;
}

// Targets without a namespace suffix; anything else has to look like one
// (product__v, user__sys) before it's worth a call.
const PLAIN_TARGETS = new Set([
  "documents", "archived_documents", "users", "groups", "relationships", "binders",
  "workflows", "events", "renditions", "matched_documents",
]);

function plausibleTarget(n) {
  if (state.dataModel?.objects.some((o) => o.name.toLowerCase() === n)) return true;
  if (liveTargets) return liveTargets.some((t) => t.name.toLowerCase() === n);
  return /__[a-z]+$/.test(n) || PLAIN_TARGETS.has(n);
}

// Whether an object still has to be asked about before it can be suggested
// from: a plausible name, not already known with its relationships, not
// already asked about.
function needsLookup(name, trusted = false) {
  if (!name || !state.sessionId || !/^[a-z_][a-z0-9_]*$/i.test(name)) return false;
  const n = String(name).toLowerCase();
  if (liveObjects.has(n) || liveObjectsPending.has(n)) return false;
  if (!trusted && !plausibleTarget(n)) return false;
  const m = modelObject(n);
  return !m || !m.relationships;
}

async function fetchObjectInfo(n) {
  if (apiAtLeast("v25.2")) {
    const [fields, rels] = await Promise.all([
      showQuery(`SHOW FIELDS FROM ${n}`),
      showQuery(`SHOW RELATIONSHIPS FROM ${n}`),
    ]);
    if (fields || rels) return { name: n, label: "", fields: showFields(n, fields), relationships: showRelationships(rels) };
  }
  const res = await apiCall(n === "documents" ? "/metadata/objects/documents/properties" : `/metadata/vobjects/${encodeURIComponent(n)}`);
  if (!apiOk(res)) return null;
  return { name: n, label: res.data?.object?.label || "", fields: extractFields(n, res), relationships: extractRelationships(res).own };
}

// Looks the objects up (once each); resolves when all have answered.
function ensureObjects(names) {
  const jobs = [];
  for (const name of new Set(names.filter(Boolean).map((x) => String(x).toLowerCase()))) {
    if (liveObjectsPending.has(name)) {
      jobs.push(liveObjectsPending.get(name));
      continue;
    }
    if (!needsLookup(name, true)) continue;
    const domain = state.domain;
    const job = fetchObjectInfo(name)
      .catch(() => null)
      .then((info) => {
        liveObjectsPending.delete(name);
        if (state.domain === domain) liveObjects.set(name, info);
      });
    liveObjectsPending.set(name, job);
    jobs.push(job);
  }
  return Promise.all(jobs);
}

// The targets FROM can take, for suggestions before any model is loaded.
function ensureTargetList() {
  if (liveTargets || liveTargetsPending || !state.sessionId) return liveTargetsPending || Promise.resolve();
  const domain = state.domain;
  liveTargetsPending = (async () => {
    let list = null;
    if (apiAtLeast("v25.2")) {
      const rows = await showQuery("SHOW TARGETS");
      if (rows) list = rows.map((t) => ({ name: t.name, label: t.label && t.label !== t.name ? t.label : "" }));
    }
    if (!list) {
      const res = await apiCall("/metadata/vobjects");
      list = (res?.data?.objects || []).map((o) => ({ name: o.name, label: o.label || "" }));
      if (!list.some((o) => o.name === "documents")) list.unshift({ name: "documents", label: "Documents" });
    }
    if (state.domain === domain) liveTargets = list.filter((o) => o.name);
  })()
    .catch(() => {})
    .finally(() => {
      liveTargetsPending = null;
    });
  return liveTargetsPending;
}

// A new vault, or a disconnect: nothing looked up for the last one carries over.
function forgetLiveObjects() {
  picklistNames.clear();
  picklistValueSets.clear();
  liveObjects.clear();
  liveObjectsPending.clear();
  liveTargets = null;
  liveTargetsPending = null;
}

// When the model on screen was loaded, so a save echoed back by
// storage.onChanged can be told from one made by another view.
let dataModelTime = null;

function onDataModelLoaded(timeStr) {
  if (!state.dataModel) return;
  dataModelTime = timeStr || null;

  const objCount = state.dataModel.objects.length;
  const fieldCount = state.dataModel.objects.reduce((s, o) => s + o.fields.length, 0);
  const loadedAt = timeStr
    ? ` — loaded ${new Date(timeStr).toLocaleDateString()} ${new Date(timeStr).toLocaleTimeString()}`
    : "";

  dmCounts.textContent = `${objCount} objects · ${fieldCount.toLocaleString()} fields`;
  const summary = `${objCount} objects · ${fieldCount.toLocaleString()} fields${loadedAt}`;
  dmCounts.title = summary;
  setChipState("loaded", { title: `${summary} — click to reload` });

  renderDataModelTree(dmSearch.value.trim().toLowerCase());
  // Untitled tabs are named after their object's label, which only the model has.
  if (WINDOW_MODE) renderQueryTabs();
}

// ===================== DATA MODEL =====================
// One object at a time. The objects you use sit as chips under the search; the
// chosen one's fields, lookups or child relationships fill the list below, one
// line each, switched by Fields | Lookups | Children. It starts on the object
// the query is FROM and follows the FROM when it changes. Search gives one flat
// list in the same rows; "All objects" lists every object.
const DM_PAGE = 25;
// A vault carries hundreds of objects, but day-to-day work happens in a handful.
// These are always chips. Names are matched case-insensitively and silently
// skipped when a vault lacks one, so suffixed and bare spellings can both be
// listed — whichever exists shows, in the order given.
const DM_DEFAULT_OBJECTS = [
  "documents",
  "user__sys",
  "user",
  "document_usage__v",
  "activity__v",
  "activity",
];
// Chips beyond those, brought in by the query or a pick, oldest dropped first.
const DM_EXTRA_CHIPS = 4;

let dmSelected = null;    // the object on show
let dmView = "fields";    // fields | out (lookups) | in (child relationships)
let dmAllObjects = false; // the list of every object is showing instead
let dmExtra = [];         // chip objects beyond the defaults
let dmFromSeen = null;    // the FROM object the panel last followed
let dmShown = DM_PAGE;
let dmLastKey = "";       // what the list showed last, to keep its scroll

function dmResetView() {
  dmSelected = null;
  dmView = "fields";
  dmAllObjects = false;
  dmExtra = [];
  dmFromSeen = null;
  dmShown = DM_PAGE;
  dmLastKey = "";
}

dmSearch.addEventListener("input", () => {
  dmShown = DM_PAGE;
  renderDataModelTree(dmSearch.value.trim().toLowerCase());
});

dmSearchClear.addEventListener("click", () => {
  dmSearch.value = "";
  dmShown = DM_PAGE;
  renderDataModelTree("");
  dmSearch.focus();
});

dmShowMore.addEventListener("click", () => {
  dmShown += DM_PAGE;
  renderDataModelTree(dmSearch.value.trim().toLowerCase());
});

dmInsertAll.addEventListener("click", () => {
  if (dmSelected) insertSelectTemplate(dmSelected);
});

function matchesField(f, filter) {
  return (
    f.name.toLowerCase().includes(filter) ||
    f.label.toLowerCase().includes(filter) ||
    f.type.toLowerCase().includes(filter)
  );
}

function matchesObject(o, filter) {
  return o.name.toLowerCase().includes(filter) || o.label.toLowerCase().includes(filter);
}

function dmFeatured() {
  const out = [];
  for (const want of DM_DEFAULT_OBJECTS) {
    const o = modelObject(want);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

// What the editor is querying, else what last ran.
function dmQueryObject() {
  return modelObject(vqlShape(vqlInput.value).target) || modelObject(vqlShape(lastRunQuery).target);
}

function dmPin(name) {
  if (dmFeatured().some((o) => o.name === name)) return;
  dmExtra = dmExtra.filter((n) => n !== name);
  dmExtra.push(name);
  while (dmExtra.length > DM_EXTRA_CHIPS) {
    dmExtra.splice(dmExtra.findIndex((n) => n !== dmSelected), 1);
  }
}

function dmSelect(name, view = "fields") {
  const obj = modelObject(name);
  if (!obj) return;
  dmSelected = obj.name;
  dmView = view;
  dmAllObjects = false;
  dmPin(obj.name);
  // Ranking needs usage data; ask for it the moment the object is shown.
  scheduleFieldStats(obj.name);
}

// Start somewhere: the query's object, else the first everyday one, else the
// list of all of them.
function dmEnsureSelection() {
  if (dmSelected && modelObject(dmSelected)) return;
  dmSelected = null;
  const from = dmQueryObject();
  dmFromSeen = from?.name || null;
  const obj = from || dmFeatured()[0];
  if (obj) dmSelect(obj.name);
  else dmAllObjects = true;
}

// Follow the query's FROM when it changes. A pick made since stays until the
// FROM moves again, and a search in progress is left alone.
function syncDmToQuery() {
  if (!state.dataModel) return;
  const obj = dmQueryObject();
  const name = obj?.name || null;
  if (name === dmFromSeen) return;
  dmFromSeen = name;
  if (!obj || dmSearch.value.trim()) return;
  if (obj.name === dmSelected && !dmAllObjects) return;
  dmSelect(obj.name);
  renderDataModelTree("");
}

// ---- Rows ----------------------------------------------------------------------
const DM_CHEVRON =
  '<svg class="dm-orow-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

const DM_SEL = '<span class="dm-row-sel" title="Add to SELECT">+ SELECT</span>';

// Label, API name, type: one line. The full window drops the label (it's
// narrow) unless the search matched the label alone. `inObj` names the object
// a search hit belongs to.
function fieldRowHtml(f, objName, filter, inObj = "") {
  const type = wbTypeLabel(f.type);
  const tip = [f.label && f.label !== f.name ? f.label : "", type, f.required ? "required" : ""]
    .filter(Boolean)
    .join(" · ");
  const labelHit =
    filter && f.label && !f.name.toLowerCase().includes(filter) && f.label.toLowerCase().includes(filter);
  return (
    `<button type="button" class="dm-row${labelHit ? " label-hit" : ""}" data-field="${esc(f.name)}" ` +
    `data-obj="${esc(objName)}" title="${esc(`${tip}. Click to insert, ⇧-click to add to SELECT.`)}">` +
    `<span class="dm-row-label">${highlight(f.label || f.name, filter)}</span>` +
    `<span class="dm-row-name">${highlight(f.name, filter)}</span>` +
    (f.required ? '<span class="dm-row-req" aria-label="required">*</span>' : "") +
    (inObj ? `<span class="dm-row-in">in ${esc(inObj)}</span>` : "") +
    `<span class="dm-row-type">${esc(type)}</span>${DM_SEL}</button>`
  );
}

// The field a shift-clicked lookup adds: the related record's name, else its id.
function lookupDefaultField(objName, relName) {
  const target = relationshipTarget(knownObject(objName), relName) || relationshipTargetAnywhere(relName, "out");
  // Not looked up yet: nearly every Vault object has a name__v.
  if (!target?.fields?.length) return "name__v";
  return target.fields.some((f) => f.name === "name__v") ? "name__v" : "id";
}

// A lookup (→, one related record, inserted as rel.) or a child relationship
// (↓, many records, inserted as a subquery), in the field rows' shape.
function relRowHtml(r, objName, filter, inObj = "") {
  const lookup = r.dir === "out";
  const target = r.target || "";
  const tip = lookup
    ? `Lookup to ${target || "a related record"}. Click to insert ${r.name}. and pick a field. ` +
      `⇧-click to add ${r.name}.${lookupDefaultField(objName, r.name)} to SELECT.`
    : `Child records${target ? ` from ${target}` : ""} (a subquery). Click to insert (SELECT id FROM ${r.name}). ` +
      "⇧-click to add it to SELECT.";
  return (
    `<button type="button" class="dm-row dm-rel" data-rel="${esc(r.name)}" data-dir="${r.dir}" ` +
    `data-obj="${esc(objName)}" title="${esc(tip)}">` +
    `<span class="dm-row-label">${highlight(r.label || target || r.name, filter)}</span>` +
    `<span class="dm-row-name">${highlight(r.name, filter)}</span>` +
    `<span class="sr-only">${lookup ? "lookup to" : "child records from"}</span>` +
    (inObj ? `<span class="dm-row-in">in ${esc(inObj)}</span>` : "") +
    `<span class="dm-row-type">${lookup ? "→" : "↓"} ${highlight(target || (lookup ? "lookup" : "subquery"), filter)}</span>` +
    `${DM_SEL}</button>`
  );
}

function objectRowHtml(o, filter) {
  const n = o.fields?.length || 0;
  return (
    `<button type="button" class="dm-orow" data-pick="${esc(o.name)}" title="${esc(`Show ${o.label || o.name}`)}">` +
    `<span class="dm-row-label">${highlight(o.label || o.name, filter)}</span>` +
    `<span class="dm-row-name">${highlight(o.name, filter)}</span>` +
    `<span class="dm-orow-count">${n ? `${n.toLocaleString()} field${n === 1 ? "" : "s"}` : ""}</span>${DM_CHEVRON}</button>`
  );
}

function sortedRelationships(obj) {
  return [...(obj.relationships || [])].sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir === "out" ? -1 : 1
  );
}

// Click: a lookup goes in as "rel." with its fields offered, a child
// relationship as a subquery. Shift-click adds either to the SELECT list.
function insertRelationship(name, dir, objName, addToSelect) {
  if (dir === "out") {
    if (addToSelect) {
      addFieldToSelect(`${name}.${lookupDefaultField(objName, name)}`, objName);
      return;
    }
    insertIntoQuery(`${name}.`);
    // After this click has finished, or the page's click-outside rule closes it.
    setTimeout(showAutocomplete, 0);
    return;
  }
  const sub = `(SELECT id FROM ${name})`;
  if (addToSelect) addFieldToSelect(sub, objName);
  else insertIntoQuery(sub);
}

// ---- Chips, the switch, the lists ----------------------------------------------
function dmChipsHtml() {
  const objs = [...dmFeatured()];
  for (const n of dmExtra) {
    const o = modelObject(n);
    if (o && !objs.includes(o)) objs.push(o);
  }
  let h = "";
  for (const o of objs) {
    const on = !dmAllObjects && o.name === dmSelected;
    h +=
      `<button type="button" class="dm-ochip${on ? " on" : ""}" data-pick="${esc(o.name)}" ` +
      `aria-pressed="${on}" title="${esc(o.name)}">${esc(o.label || o.name)}` +
      ` <span class="dm-n">${(o.fields?.length || 0).toLocaleString()}</span></button>`;
  }
  const total = state.dataModel.objects.length;
  h +=
    `<button type="button" class="dm-ochip dm-ochip-all${dmAllObjects ? " on" : ""}" data-all="1" ` +
    `aria-pressed="${dmAllObjects}" title="List every object">All objects <span class="dm-n">${total.toLocaleString()}</span></button>`;
  return h;
}

function paintDmSwitch(obj) {
  const rels = obj.relationships;
  const count = {
    fields: obj.fields.length,
    out: rels ? rels.filter((r) => r.dir === "out").length : null,
    in: rels ? rels.filter((r) => r.dir === "in").length : null,
  };
  // A view with nothing to show falls back to the fields.
  if (dmView !== "fields" && !count[dmView]) dmView = "fields";
  for (const btn of dmSwitch.querySelectorAll("[data-view]")) {
    const v = btn.dataset.view;
    const on = v === dmView;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.querySelector(".dm-n").textContent = count[v] == null ? "" : count[v].toLocaleString();
    btn.disabled = v !== "fields" && !count[v];
    // A model saved before relationships were kept has none to show yet.
    btn.title = count[v] == null ? "Reload the data model to see relationships" : "";
  }
}

// Every object: the everyday ones, the rest, then the other query targets
// (users, groups, workflows, binders and the rest that SHOW TARGETS lists).
function dmObjectListHtml() {
  const featured = dmFeatured();
  const rest = state.dataModel.objects.filter((o) => !featured.includes(o));
  const objs = rest.filter((o) => o.kind !== "target");
  const targets = rest.filter((o) => o.kind === "target");
  let h = "";
  if (featured.length) {
    h += '<div class="dm-section">Most used</div>';
    for (const o of featured) h += objectRowHtml(o, "");
  }
  h += `<div class="dm-section">${featured.length ? "All objects" : "Objects"} · ${objs.length.toLocaleString()}</div>`;
  for (const o of objs) h += objectRowHtml(o, "");
  if (targets.length) {
    h += `<div class="dm-section" title="Query targets that aren't Vault objects, from SHOW TARGETS">Other query targets · ${targets.length.toLocaleString()}</div>`;
    for (const o of targets) h += objectRowHtml(o, "");
  }
  return h;
}

function dmPaintList(key, html) {
  const keep = key === dmLastKey ? dmTree.scrollTop : 0;
  dmTree.innerHTML = html;
  dmTree.scrollTop = keep;
  dmLastKey = key;
}

function renderDataModelTree(filter) {
  // Before anything is loaded the panel chrome says nothing useful, so it stays
  // out of the way entirely — same shape as the Doc Types tab.
  if (!state.dataModel) {
    dmPanel.classList.add("hidden");
    dmEmptyState.classList.remove("hidden");
    dmMore.classList.add("hidden");
    dmTree.innerHTML = "";
    dmLastKey = "";
    return;
  }

  dmPanel.classList.remove("hidden");
  dmEmptyState.classList.add("hidden");
  dmSearchField.classList.toggle("filled", !!filter);
  dmSearchClear.classList.toggle("hidden", !filter);
  dmInsertAll.classList.add("hidden");
  dmShowMore.classList.add("hidden");

  if (filter) {
    renderDmSearch(filter);
    return;
  }

  dmEnsureSelection();
  dmObjects.innerHTML = dmChipsHtml();
  dmObjects.classList.remove("hidden");

  if (dmAllObjects || !dmSelected) {
    dmSwitch.classList.add("hidden");
    dmMore.classList.add("hidden");
    dmPaintList("all", dmObjectListHtml());
    return;
  }

  const obj = modelObject(dmSelected);
  paintDmSwitch(obj);
  dmSwitch.classList.remove("hidden");

  let html;
  if (dmView === "fields") {
    const ranked = [...obj.fields].sort(fieldRanker(obj));
    html = ranked.map((f) => fieldRowHtml(f, obj.name, "")).join("") ||
      `<div class="dm-empty">No fields known for ${esc(obj.name)}.</div>`;
    dmInsertAll.textContent = `Insert all ${obj.fields.length.toLocaleString()} fields`;
    dmInsertAll.title = `Replace the query with SELECT of every field FROM ${obj.name}`;
    dmInsertAll.classList.toggle("hidden", !obj.fields.length);
    dmShowing.textContent = hasFieldStats(obj.name) ? "Most-filled first" : "";
  } else {
    html = sortedRelationships(obj)
      .filter((r) => r.dir === dmView)
      .map((r) => relRowHtml(r, obj.name, ""))
      .join("");
    dmShowing.textContent = dmView === "out" ? "Click inserts rel. and offers its fields" : "Click inserts a subquery";
  }
  dmMore.classList.remove("hidden");
  dmPaintList(`${obj.name}|${dmView}`, html);
}

// One flat list: matching objects first, then fields and relationships with
// the object each belongs to — the object on show first.
function renderDmSearch(filter) {
  dmObjects.classList.add("hidden");
  dmSwitch.classList.add("hidden");

  const objects = state.dataModel.objects;
  const hits = [];
  for (const o of objects) if (matchesObject(o, filter)) hits.push({ o });
  const current = modelObject(dmSelected);
  const order = current ? [current, ...objects.filter((o) => o !== current)] : objects;
  for (const obj of order) {
    for (const f of obj.fields) if (matchesField(f, filter)) hits.push({ obj, f });
    for (const r of sortedRelationships(obj)) {
      if (r.name.toLowerCase().includes(filter) || (r.target || "").toLowerCase().includes(filter)) hits.push({ obj, r });
    }
  }

  const shown = hits.slice(0, dmShown);
  const html = hits.length
    ? shown
        .map((h) =>
          h.o ? objectRowHtml(h.o, filter)
          : h.f ? fieldRowHtml(h.f, h.obj.name, filter, h.obj.name)
          : relRowHtml(h.r, h.obj.name, filter, h.obj.name)
        )
        .join("")
    : `<div class="dm-empty">Nothing matches &ldquo;${esc(filter)}&rdquo;</div>`;
  dmPaintList(`search|${filter}`, html);

  dmMore.classList.toggle("hidden", !hits.length);
  dmShowing.textContent =
    shown.length < hits.length ? `Showing ${shown.length} of ${hits.length}` : `${hits.length} result${hits.length === 1 ? "" : "s"}`;
  dmShowMore.classList.toggle("hidden", shown.length >= hits.length);
}

function highlight(text, filter) {
  if (!filter || !text) return esc(text || "");
  const escaped = esc(text);
  const idx = text.toLowerCase().indexOf(filter);
  if (idx === -1) return escaped;
  const before = esc(text.slice(0, idx));
  const match = esc(text.slice(idx, idx + filter.length));
  const after = esc(text.slice(idx + filter.length));
  return `${before}<span class="dm-highlight">${match}</span>${after}`;
}

function insertSelectTemplate(objName) {
  const obj = state.dataModel?.objects.find((o) => o.name === objName);
  if (!obj || !obj.fields.length) return;
  const fieldList = obj.fields.map((f) => `    ${f.name}`).join(",\n");
  insertIntoQuery(`SELECT\n${fieldList}\nFROM ${obj.name}`, true);
}

// A keyboard click rebuilt what held the focus; put it back on the same thing.
function dmRefocus(e, sel) {
  if (e.detail !== 0) return;
  const el = dmPanel.querySelector(sel);
  if (el) el.focus();
}

dmObjects.addEventListener("click", (e) => {
  const chip = e.target.closest(".dm-ochip");
  if (!chip) return;
  if (chip.dataset.all) {
    // A second click goes back to the object on show.
    dmAllObjects = !dmAllObjects || !dmSelected;
  } else {
    const same = chip.dataset.pick === dmSelected && !dmAllObjects;
    dmSelect(chip.dataset.pick, same ? dmView : "fields");
  }
  renderDataModelTree("");
  dmRefocus(e, chip.dataset.all ? ".dm-ochip-all" : `.dm-ochip[data-pick="${CSS.escape(chip.dataset.pick)}"]`);
});

dmSwitch.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (!btn || btn.disabled || btn.dataset.view === dmView) return;
  dmView = btn.dataset.view;
  renderDataModelTree("");
  dmRefocus(e, `#dm-switch [data-view="${btn.dataset.view}"]`);
});

dmTree.addEventListener("click", (e) => {
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    dmSelect(pick.dataset.pick);
    if (dmSearch.value) {
      dmSearch.value = "";
      dmShown = DM_PAGE;
    }
    renderDataModelTree("");
    dmRefocus(e, `.dm-ochip[data-pick="${CSS.escape(pick.dataset.pick)}"]`);
    return;
  }

  // ⇧-click, or the + SELECT a row shows on hover, adds to the SELECT list.
  const toSelect = e.shiftKey || !!e.target.closest(".dm-row-sel");
  const rel = e.target.closest(".dm-rel");
  if (rel) {
    insertRelationship(rel.dataset.rel, rel.dataset.dir, rel.dataset.obj, toSelect);
    return;
  }

  const row = e.target.closest(".dm-row");
  if (!row) return;
  if (toSelect) addFieldToSelect(row.dataset.field, row.dataset.obj);
  else insertIntoQuery(row.dataset.field);
});

function insertIntoQuery(text, replace = false) {
  activatePane("query");
  paintTabThumb();

  if (replace) {
    vqlInput.value = text;
  } else {
    const pos = vqlInput.selectionStart;
    const before = vqlInput.value.slice(0, pos);
    const after = vqlInput.value.slice(pos);
    // Add a space before if needed
    const needsSpace = before.length > 0 && !before.endsWith(" ") && !before.endsWith(",") && !before.endsWith("\n");
    vqlInput.value = before + (needsSpace ? " " : "") + text + after;
    const newPos = pos + (needsSpace ? 1 : 0) + text.length;
    vqlInput.setSelectionRange(newPos, newPos);
  }
  vqlInput.focus();
  editorChanged();
}

// Shift-click on a field: append it to the SELECT list rather than dropping it
// wherever the cursor happens to be. An empty editor gets a fresh statement.
function addFieldToSelect(field, objName) {
  const q = vqlInput.value;
  if (!q.trim()) {
    insertIntoQuery(`SELECT ${field}\nFROM ${objName}`, true);
    vqlInput.setSelectionRange(7 + field.length, 7 + field.length);
    return;
  }
  const span = vqlSelectListSpan(q);
  if (!span) {
    insertIntoQuery(field);
    return;
  }
  const list = q.slice(span.start, span.end);
  activatePane("query");
  vqlInput.focus();
  // Already selected — show where, rather than adding it twice. Whole items
  // only, so name__v doesn't match inside product__v.name__v.
  const listed = vqlListItems(q, span).find((it) => it.text.trim().toLowerCase() === field.toLowerCase());
  if (listed) {
    const at = listed.start + listed.text.indexOf(listed.text.trim());
    vqlInput.setSelectionRange(at, at + field.length);
    return;
  }
  const end = span.start + list.replace(/\s+$/, "").length;
  vqlInput.value = `${q.slice(0, end)}, ${field}${q.slice(end)}`;
  const caret = end + 2 + field.length;
  vqlInput.setSelectionRange(caret, caret);
  historyNavIndex = -1;
  editorChanged();
}

// ===================== FIELD FILL STATS =====================
// Ranks autocomplete suggestions by how often a field is actually populated.
// Measured by sampling rather than scanning: ordering only needs the relative
// rank, so a couple hundred rows separates a 90%-filled field from a 5% one.
//
// Cost is bounded by only ever measuring the object the query is actually
// against — never the whole model — and caching the result per vault, so the
// first use of an object costs a handful of background queries and every use
// after that costs nothing.
const FIELD_STATS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FIELD_STATS_SAMPLE = 200;
const FIELD_STATS_CHUNK = 20;      // Vault rejects very wide SELECTs
const FIELD_STATS_CONCURRENCY = 3;
const FIELD_STATS_MAX_OBJECTS = 50;

let fieldStats = {};
const fieldStatsPending = new Set();
const fieldStatsFailed = new Set();
let fieldStatsTimer = null;

async function loadFieldStatsForDomain(domain) {
  fieldStats = (await readVaultCache("fieldStats", domain)) || {};
}

async function persistFieldStats() {
  if (!state.domain) return;
  // Keep the most recently measured objects only, so the cache can't grow
  // without bound across a large vault.
  fieldStats = Object.fromEntries(
    Object.entries(fieldStats)
      .sort((a, b) => b[1].time - a[1].time)
      .slice(0, FIELD_STATS_MAX_OBJECTS)
  );
  await saveVaultCache("fieldStats", state.domain, fieldStats);
}

// Shared ordering for "most useful field first": required, then how often the
// field is actually populated, then the model's own order. Used by both the
// autocomplete and the Models panel so the two never disagree.
function fieldRanker(obj) {
  const rates = fieldStats[obj.name]?.rates || {};
  const modelOrder = new Map(obj.fields.map((f, i) => [f.name, i]));
  return (a, b) => {
    const byRequired = (b.required === true) - (a.required === true);
    if (byRequired) return byRequired;
    const byFill = (rates[b.name] ?? -1) - (rates[a.name] ?? -1);
    if (byFill) return byFill;
    return modelOrder.get(a.name) - modelOrder.get(b.name);
  };
}

function hasFieldStats(objName) {
  return !!fieldStats[objName];
}

function scheduleFieldStats(objName) {
  if (!objName || !state.sessionId) return;
  const entry = fieldStats[objName];
  if (entry && Date.now() - entry.time < FIELD_STATS_TTL_MS) return;
  if (fieldStatsPending.has(objName) || fieldStatsFailed.has(objName)) return;
  clearTimeout(fieldStatsTimer);
  fieldStatsTimer = setTimeout(() => computeFieldStats(objName), 500);
}

async function computeFieldStats(objName) {
  if (fieldStatsPending.has(objName)) return;
  const obj = state.dataModel?.objects.find((o) => o.name === objName);
  if (!obj || !state.sessionId) return;

  // Required fields already rank above everything else, so measuring them is
  // wasted work — skip them and spend the queries on the rest.
  const names = obj.fields
    .filter((f) => f.queryable !== false && !f.required && f.name && !f.name.startsWith("__"))
    .map((f) => f.name);
  if (!names.length) return;

  fieldStatsPending.add(objName);
  try {
    const chunks = [];
    for (let i = 0; i < names.length; i += FIELD_STATS_CHUNK) {
      chunks.push(names.slice(i, i + FIELD_STATS_CHUNK));
    }

    const rates = {};
    let measured = false;

    for (let i = 0; i < chunks.length; i += FIELD_STATS_CONCURRENCY) {
      const batch = chunks.slice(i, i + FIELD_STATS_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (fields) => {
          const q = `SELECT ${fields.join(", ")} FROM ${objName} MAXROWS ${FIELD_STATS_SAMPLE}`;
          const res = await apiCall("/query", "POST", `q=${encodeURIComponent(q)}`);
          return { fields, res };
        })
      );

      for (const { fields, res } of results) {
        const rows =
          res.success && res.data?.responseStatus !== "FAILURE" ? res.data?.data : null;
        if (!rows || !rows.length) continue;
        measured = true;
        for (const f of fields) {
          let filled = 0;
          for (const row of rows) {
            const v = row[f];
            if (v !== null && v !== undefined && v !== "") filled++;
          }
          rates[f] = Math.round((filled / rows.length) * 100);
        }
      }
    }

    // A vault that rejects these queries shouldn't be retried on every keystroke.
    if (!measured) {
      fieldStatsFailed.add(objName);
      return;
    }

    fieldStats[objName] = { time: Date.now(), rates };
    await persistFieldStats();

    // The panel may be showing this object's fields in fallback order; re-rank
    // now that real usage numbers exist.
    if (dmSelected === objName && dmView === "fields" && !dmAllObjects && !dmSearch.value.trim()) {
      renderDataModelTree("");
    }
  } finally {
    fieldStatsPending.delete(objName);
  }
}

// ===================== AUTOCOMPLETE =====================
// What autocomplete offers besides the model's own names: VQL's clauses,
// options and functions as Veeva's VQL reference lists them, each with what it
// does and the API version it needs. LIMIT and OFFSET were deprecated in v20.3
// (MAXROWS and PAGEOFFSET replace them) — the editor still honours a LIMIT it
// finds, but doesn't teach it.
// [text, what it does, kind ("kw" or "fn"), minimum version, text to insert]
const VQL_WORDS = [
  ["SELECT", "fields to return", "kw"],
  ["FROM", "query target", "kw"],
  ["WHERE", "filter", "kw"],
  ["AND", "", "kw"],
  ["OR", "", "kw"],
  ["NOT", "", "kw"],
  ["IN", "WHERE id IN (SELECT id FROM rel): only records that have related records", "kw"],
  ["LIKE", "% matches any characters", "kw"],
  ["BETWEEN", "BETWEEN a AND b", "kw"],
  ["CONTAINS", "any of a list: CONTAINS ('a', 'b')", "kw"],
  ["NULL", "", "kw"],
  ["TRUE", "", "kw"],
  ["FALSE", "", "kw"],
  ["ORDER BY", "sort", "kw"],
  ["ASC", "", "kw"],
  ["DESC", "", "kw"],
  ["AS", "alias a function, or any field from v24.2", "kw"],
  ["MAXROWS", "most rows to return", "kw"],
  ["SKIP", "skip the first N rows", "kw"],
  ["FIND", "full-text search: FIND ('term')", "kw", null, "FIND ('')"],
  ["SCOPE ALL", "FIND in fields and document content", "kw"],
  ["SCOPE CONTENT", "FIND in document content only", "kw"],
  ["SCOPE PROPERTIES", "FIND in text fields and picklists (the default)", "kw"],
  ["ORDER BY RANK", "sort FIND results by relevance (documents only)", "kw"],
  ["DISTANCE", "fuzzy FIND with SCOPE {field}: DISTANCE 1 or 2", "kw", "v26.1"],
  ["ALLVERSIONS", "every document version: FROM ALLVERSIONS documents", "kw"],
  ["LATESTVERSION", "SELECT LATESTVERSION … FROM ALLVERSIONS documents: latest matching version", "kw"],
  ["RECENT", "your 20 most recently viewed: FROM RECENT …", "kw"],
  ["FAVORITES", "your favorites: FROM FAVORITES …", "kw"],
  ["SHOW TARGETS", "every target you can query", "kw", "v25.2"],
  ["SHOW FIELDS FROM", "a target's queryable fields", "kw", "v25.2"],
  ["SHOW RELATIONSHIPS FROM", "a target's relationships", "kw", "v25.2"],
  ["TONAME", "documents: names instead of labels", "fn"],
  ["TOLABEL", "objects: labels instead of names", "fn"],
  ["CASEINSENSITIVE", "case-insensitive WHERE on objects", "fn"],
  ["LONGTEXT", "the full Long Text value", "fn"],
  ["RICHTEXT", "the full Rich Text value, with HTML", "fn"],
  ["TODISPLAYFORMAT", "the formatted value (objects)", "fn"],
  ["TRIM", "picklist value without its __c / __v suffix", "fn", "v25.1"],
  ["STATETYPE", "objects in a state type: state__v = STATETYPE('…')", "fn", null, "STATETYPE('')"],
  ["STEADYSTATE", "documents in a steady state: status__v = STEADYSTATE()", "fn", null, "STEADYSTATE()"],
  ["SUPERSEDEDSTATE", "documents in a superseded state", "fn", null, "SUPERSEDEDSTATE()"],
  ["OBSOLETESTATE", "documents in an obsolete state", "fn", null, "OBSOLETESTATE()"],
  ["DELETEDSTATE", "documents in a deleted state", "fn", null, "DELETEDSTATE()"],
  ["FILENAME", "an Attachment field's file name", "fn", "v24.3"],
  ["FILESIZE", "an Attachment field's size in bytes", "fn", "v24.3"],
  ["MIMETYPE", "an Attachment field's MIME type", "fn", "v24.3"],
  ["MD5CHECKSUM", "an Attachment field's MD5 checksum", "fn", "v24.3"],
];

// Words the highlighter colours. The deprecated LIMIT and OFFSET stay here:
// the editor still honours LIMIT, so neither should look like a typo.
const VQL_KEYWORDS = [
  ...VQL_WORDS.map((w) => w[0]),
  "LIMIT", "OFFSET", "RANK", "SCOPE", "CONTENT", "PROPERTIES", "ALL", "SHOW", "TARGETS", "FIELDS", "RELATIONSHIPS",
];

function vqlWordItems(word) {
  const out = [];
  for (const [text, detail, kind, min, insert] of VQL_WORDS) {
    if (min && !apiAtLeast(min)) continue;
    if (!text.toLowerCase().includes(word)) continue;
    const fn = kind === "fn";
    const ins = insert || (fn ? `${text}()` : text);
    // A function lands with the caret inside its parens, a template inside its
    // quotes; the no-argument state functions are complete as inserted.
    let caret = null;
    if (ins.includes("''")) caret = ins.indexOf("''") + 1;
    else if (fn && !insert) caret = text.length + 1;
    out.push({ type: fn ? "fn" : "kw", name: text, label: "", detail: detail || (fn ? "function" : "keyword"), insert: ins, caret });
  }
  return out;
}

function objectItem(obj) {
  return {
    type: "obj",
    name: obj.name,
    label: obj.label && obj.label !== obj.name ? obj.label : "",
    detail: obj.kind === "target" ? "query target" : obj.fields ? `${obj.fields.length} fields` : "target",
  };
}

function lookupItem(r) {
  return {
    type: "rel",
    name: `${r.name}.`,
    label: r.label || "",
    detail: `lookup → ${r.target || "?"}`,
    insert: `${r.name}.`,
    reopen: true,
  };
}

function subqueryItem(r) {
  const ins = `(SELECT id FROM ${r.name})`;
  return {
    type: "sub",
    name: r.name,
    label: r.label || "",
    detail: `subquery → ${r.target || "?"}`,
    insert: ins,
    // Caret after "id", ready to list more child fields.
    caret: "(SELECT id".length,
  };
}

function fieldItem(f, insert) {
  return { type: "field", name: insert || f.name, label: f.label, detail: f.type, required: f.required, insert: insert || f.name };
}

// The object the caret is writing about: the subquery's relationship target
// when inside one, else the top-level FROM target.
// The object the caret is writing about: the subquery's relationship target
// when inside one, else the top-level FROM target. `want` collects the names
// that have to be looked up first; the list is drawn again once they answer.
function autocompleteScope(text, pos, want = [], typingTarget = false) {
  const shape = vqlShape(text);
  let outerName = shape.target;
  // An unclosed "(SELECT …" pushes the outer FROM a level down, so the query
  // seems to have no target. The shallowest FROM after the caret is it.
  if (!outerName) {
    const after = vqlTokens(text).map((x, i, all) => ({ ...x, next: all[i + 1] })).filter((x) => x.at >= pos && /^from$/i.test(x.t));
    const from = after.sort((a, b) => a.depth - b.depth)[0];
    let word = from?.next;
    if (word && VQL_TARGET_OPTION_RE.test(word.t)) word = vqlTokens(text).find((x) => x.at > word.at);
    if (word && !VQL_NOT_TARGET_RE.test(word.t)) outerName = word.t.toLowerCase();
  }
  // Not while the caret is still on the target word: "p", "pr", "pro" aren't objects.
  if (!typingTarget && needsLookup(outerName)) want.push(outerName);
  const outer = knownObject(outerName);
  const sub = vqlSubqueryAt(shape, pos);
  let obj = outer;
  if (sub) {
    const r = relationshipOf(outer, sub.rel);
    if (r && needsLookup(r.target)) want.push(r.target);
    obj = r ? knownObject(r.target) : null;
  }
  return { shape, outer, sub, obj };
}

// Every target FROM can take: the model's, or the list asked for without one.
function fromTargets(want) {
  if (state.dataModel) return state.dataModel.objects;
  if (!liveTargets) want.push(ensureTargetList);
  return liveTargets || [];
}

function showAutocomplete() {
  const cursorPos = vqlInput.selectionStart;
  const text = vqlInput.value;
  const beforeCursor = text.slice(0, cursorPos);
  const wordMatch = beforeCursor.match(/[\w.]+$/);
  const raw = wordMatch ? wordMatch[0] : "";
  const word = raw.toLowerCase();
  const dot = word.lastIndexOf(".");
  // Inside a string literal the words are values, not names to complete.
  const lastTok = (beforeCursor.match(VQL_TOKEN_RE) || []).pop() || "";
  if (lastTok[0] === "'" && (lastTok.length === 1 || !lastTok.endsWith("'") || /(^|[^\\])\\'$/.test(lastTok))) {
    hideAc();
    return;
  }
  const fromCtx = /\bFROM\s+(?:(ALLVERSIONS|RECENT|FAVORITES)\s+)?(\w*)$/i.exec(beforeCursor);
  // Two characters before offering anything, except right after "rel." or FROM.
  if (!(word.length >= 2 || dot >= 0 || (fromCtx && word.length >= 1))) {
    hideAc();
    return;
  }

  const want = [];
  const { outer, sub, obj } = autocompleteScope(text, cursorPos, want, !!fromCtx);
  const suggestions = [];
  const push = (item) => suggestions.length < 15 && suggestions.push(item);

  if (fromCtx) {
    const partial = fromCtx[2].toLowerCase();
    if (sub) {
      // Inside a subquery, FROM takes one of the outer target's child relationships.
      for (const r of objectRelationships(outer, "in")) {
        if (r.name.toLowerCase().includes(partial)) push({ ...subqueryItem(r), name: r.name, insert: r.name, caret: null, detail: `→ ${r.target || "?"}` });
      }
    } else {
      if (!fromCtx[1]) for (const it of vqlWordItems(partial)) if (VQL_TARGET_OPTION_RE.test(it.name)) push(it);
      const objs = fromTargets(want).filter((o) => o.name.toLowerCase().includes(partial));
      // Vault objects first, then the other targets SHOW found.
      objs.sort((a, b) => (a.kind === "target") - (b.kind === "target"));
      for (const o of objs) push(objectItem(o));
    }
  } else if (dot > 0) {
    // rel.field: the fields of the record a lookup reaches.
    const relName = word.slice(0, dot);
    const rest = word.slice(dot + 1);
    const r = relationshipOf(obj, relName);
    if (r && needsLookup(r.target)) want.push(r.target);
    const target = (r ? knownObject(r.target) : null) || (obj ? null : relationshipTargetAnywhere(relName, "out"));
    if (target) {
      const matched = target.fields.filter((f) => f.name.toLowerCase().includes(rest));
      matched.sort(fieldRanker(target));
      for (const f of matched) push(fieldItem(f, `${raw.slice(0, dot + 1)}${f.name}`));
    }
  } else {
    if (obj) {
      scheduleFieldStats(obj.name);
      const matched = obj.fields.filter((f) => f.name.toLowerCase().includes(word));
      matched.sort(fieldRanker(obj));
      for (const f of matched.slice(0, 10)) push(fieldItem(f));
      for (const r of objectRelationships(obj, "out")) if (r.name.toLowerCase().includes(word)) push(lookupItem(r));
      // A subquery can't hold another, so child relationships are offered only
      // at the top level.
      if (!sub) for (const r of objectRelationships(obj, "in")) if (r.name.toLowerCase().includes(word)) push(subqueryItem(r));
    }
    for (const it of vqlWordItems(word)) push(it);
    if (!obj) {
      for (const o of fromTargets(want)) if (o.name.toLowerCase().includes(word)) push(objectItem(o));
    }
  }

  // Ask Vault about what isn't known yet, then draw the list again if the
  // editor is still where it was.
  if (want.length) {
    const lists = want.filter((w) => typeof w === "function").map((fn) => fn());
    const names = want.filter((w) => typeof w === "string");
    Promise.all([ensureObjects(names), ...lists]).then(() => {
      if (document.activeElement === vqlInput && vqlInput.value === text && vqlInput.selectionStart === cursorPos) {
        showAutocomplete();
      }
    });
  }

  if (suggestions.length === 0) {
    hideAc();
    return;
  }

  acItems = suggestions;
  acIndex = 0;
  renderAcDropdown();
}

const AC_BADGES = { obj: "OBJ", field: "FLD", kw: "KW", fn: "FN", rel: "REL", sub: "SUB" };

function renderAcDropdown() {
  let html = "";
  for (let i = 0; i < acItems.length; i++) {
    const item = acItems[i];
    const sel = i === acIndex ? " selected" : "";
    html += `<div class="ac-item${sel}" data-ac-index="${i}">`;
    html += `<span class="ac-badge ${item.type}">${AC_BADGES[item.type] || "KW"}</span>`;
    html += `<span class="ac-name">${esc(item.name)}</span>`;
    if (item.required) html += `<span class="ac-required">*</span>`;
    if (item.label) html += `<span class="ac-label">${esc(item.label)}</span>`;
    html += `<span class="ac-type">${esc(item.detail)}</span>`;
    html += `</div>`;
  }
  acDropdown.innerHTML = html;
  acDropdown.classList.remove("hidden");
}

function renderAcSelection() {
  const items = acDropdown.querySelectorAll(".ac-item");
  items.forEach((el, i) => el.classList.toggle("selected", i === acIndex));
  // Scroll into view
  if (items[acIndex]) items[acIndex].scrollIntoView({ block: "nearest" });
}

acDropdown.addEventListener("click", (e) => {
  const item = e.target.closest(".ac-item");
  if (item) {
    const idx = parseInt(item.dataset.acIndex);
    if (acItems[idx]) {
      const chosen = acItems[idx];
      hideAc();
      insertAcItem(chosen);
    }
  }
});

function insertAcItem(item) {
  const cursorPos = vqlInput.selectionStart;
  const text = vqlInput.value;
  const beforeCursor = text.slice(0, cursorPos);
  const afterCursor = text.slice(cursorPos);

  // Find the word to replace
  const wordMatch = beforeCursor.match(/[\w.]+$/);
  let wordStart = cursorPos - (wordMatch ? wordMatch[0].length : 0);
  const ins = item.insert ?? item.name;
  // "ORDER BY RANK" picked after "ORDER BY RA" replaces all three words, not
  // just the last: the longest typed stretch it starts with, from a word start.
  if (/\s/.test(ins)) {
    const up = ins.toUpperCase();
    for (let k = Math.min(ins.length, beforeCursor.length); k > cursorPos - wordStart; k--) {
      const at = cursorPos - k;
      if (up.startsWith(beforeCursor.slice(at).toUpperCase()) && (at === 0 || /[\s(,]/.test(text[at - 1]))) {
        wordStart = at;
        break;
      }
    }
  }
  vqlInput.value = text.slice(0, wordStart) + ins + afterCursor;
  const newPos = wordStart + (item.caret != null ? item.caret : ins.length);
  vqlInput.setSelectionRange(newPos, newPos);
  vqlInput.focus();
  editorChanged();
  // "rel." goes straight on to the fields behind it.
  if (item.reopen) setTimeout(showAutocomplete, 0);
}

function hideAc() {
  acDropdown.classList.add("hidden");
  acItems = [];
  acIndex = -1;
}

// Hide autocomplete when clicking outside
document.addEventListener("click", (e) => {
  // A click inside the list, even on an item it has since redrawn, isn't outside.
  if (!e.target.isConnected || acDropdown.contains(e.target)) return;
  if (!e.target.closest(".textarea-wrapper")) hideAc();
});

// ===================== INLINE EDITING =====================
const saveBar = $("#save-bar");
const saveBarCount = $("#save-bar-count");
const saveBtn = $("#save-btn");
const discardBtn = $("#discard-btn");

// Track edits: { "rowIndex:fieldName": { rowIdx, field, oldVal, newVal } }
let pendingEdits = {};
let queryObjectName = null; // detected from the FROM clause
let queryRows = []; // raw data rows from last query

// The target of the query the rows came from — past ALLVERSIONS, RECENT and
// the rest, and not fooled by a subquery's FROM coming first.
function detectObjectFromQuery() {
  return vqlShape(lastRunQuery || vqlInput.value).target;
}

// ---- Result metadata ----------------------------------------------------------
// What one run knows beyond the values: Vault's description of each column
// (label, type, function), each record's permissions, and what the query
// itself says — its target, and whether the rows are every version of a
// document. Editing and the column tooltips read it.
let resultMeta = null;

function propsEntry(p, isDoc) {
  const fp = p.field_properties || {};
  const lower = (list) => new Set((Array.isArray(list) ? list : []).map((f) => String(f).toLowerCase()));
  return {
    canEdit: isDoc ? p.permissions?.edit_fields !== false : p.permissions?.edit !== false,
    edit: Array.isArray(fp.edit) ? lower(fp.edit) : null,
    hidden: lower(fp.hidden),
    redacted: lower(fp.redacted),
  };
}

function buildResultMeta(shape, describe, pages) {
  const columns = new Map();
  for (const f of describe?.fields || []) {
    if (f?.name) columns.set(String(f.name).toLowerCase(), f);
  }
  const rows = new Map();
  for (const page of pages) {
    for (const p of page?.record_properties || []) if (p?.id != null) rows.set(String(p.id), propsEntry(p, false));
    for (const p of page?.document_properties || []) if (p?.id != null) rows.set(String(p.id), propsEntry(p, true));
  }
  // Long and rich text the query asked for in full: field -> the function used.
  // LONGTEXT() on a Rich Text field returns it whole but without its markup,
  // so only RICHTEXT() makes a Rich Text value safe to save back.
  const fullText = new Map();
  // Columns renamed with AS: a save would send the alias, not the field.
  const aliases = new Set();
  for (const item of shape.select) {
    // Unaliased only: an aliased call comes back under the alias, and the
    // plain column beside it is still the 250-character one.
    const m = /^(longtext|richtext)\s*\(\s*(\w+)\s*\)\s*$/i.exec(item);
    if (m) fullText.set(m[2].toLowerCase(), m[1].toLowerCase());
    const a = /\s+as\s+(\w+)\s*$/i.exec(item);
    if (a) aliases.add(a[1].toLowerCase());
  }
  // A target that isn't a Vault object (users, groups, workflows) has no
  // object record endpoint to save to.
  const notObject = modelObject(shape.target)?.kind === "target";
  return { target: shape.target, option: shape.option, show: shape.show, columns, rows, fullText, aliases, notObject, subKeys: new Set() };
}

// A subquery's value: its own page of related records.
function isSubValue(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.data);
}

function subSummary(v) {
  const n = v.data.length;
  const total = Number(v.responseDetails?.total);
  const of = Number.isFinite(total) && total > n ? ` of ${total.toLocaleString()}` : "";
  return `${n.toLocaleString()}${of} row${n === 1 && !of ? "" : "s"}`;
}

function columnDescribe(key) {
  return resultMeta?.columns.get(String(key).toLowerCase()) || null;
}

function columnModelField(key) {
  const obj = modelObject(resultMeta?.target || queryObjectName);
  const k = String(key).toLowerCase();
  return obj?.fields.find((f) => f.name.toLowerCase() === k) || null;
}

function columnType(key) {
  return columnDescribe(key)?.type || columnModelField(key)?.type || "";
}

// Why a whole column can't be edited here, or "" when it can.
function columnLockReason(key) {
  if (!resultMeta) return "";
  // SHOW rows have no id, so they're never editable; nothing to explain.
  if (resultMeta.show) return "";
  if (resultMeta.option === "ALLVERSIONS") {
    return "Read-only: these rows are every version (ALLVERSIONS), and a save would change only the latest one.";
  }
  if (resultMeta.subKeys.has(key)) return "Read-only: related records from a subquery. To edit them, query that object directly.";
  if (resultMeta.notObject) return `Read-only: ${resultMeta.target} isn't a Vault object, so there's no record to save to from here.`;
  if (resultMeta.target === "archived_documents") return "Read-only: archived documents can't be edited from here.";
  if (key.includes(".")) return "Read-only: comes from the related record through a lookup. Edit it on that record.";
  if (key.includes("(")) return "Read-only: a function's result, not a stored value.";
  if (resultMeta.aliases?.has(key.toLowerCase())) return "Read-only: renamed with AS, so a save wouldn't know the field. Select it without the alias to edit it.";
  if (isWrappedColumn(key)) {
    return `Read-only: shown as ${resultValues.mode} via ${resultValues.fn}(). Switch Values to ${resultValues.mode === "labels" ? "Names" : "Labels"} to edit it.`;
  }
  const type = columnType(key);
  const full = resultMeta.fullText.get(key.toLowerCase());
  if (/^richtext$/i.test(type) && full !== "richtext") {
    return `Read-only: VQL sends only the first 250 characters of a Rich Text field, without formatting. Select RICHTEXT(${key}) to get the full value.`;
  }
  if (/^longtext$/i.test(type) && !full) {
    return `Read-only: VQL sends only the first 250 characters of a Long Text field, so a save could cut it short. Select LONGTEXT(${key}) to get the full value.`;
  }
  return "";
}

// Why one cell can't be edited when its column can: the record's own
// permissions, as Vault reported them for this user.
function cellLockReason(ri, key) {
  const props = resultMeta?.rows.get(String(queryRows[ri]?.id));
  if (!props) return "";
  const k = key.toLowerCase();
  if (props.redacted.has(k)) return "Redacted for you on this record (protected personal data).";
  if (props.hidden.has(k)) return "Hidden from you on this record (Atomic Security).";
  if (!props.canEdit) return "You don't have edit permission on this record.";
  if (props.edit && !props.edit.has(k)) return "Read-only for you on this record.";
  return "";
}

function cellEditable(ri, key, editable) {
  if (key === "id" || !resultKeys.includes("id") || resultMeta?.show) return false;
  if (!(editable === "all" || editable?.has(key))) return false;
  return !columnLockReason(key) && !cellLockReason(ri, key);
}

// A header's tooltip: Vault's label and type for the column, then why it's
// read-only if it is.
function columnHeaderAttr(key) {
  const d = columnDescribe(key);
  const f = columnModelField(key);
  const label = d?.label || f?.label || "";
  const type = wbTypeLabel(d?.type || f?.type || "");
  const fn = d?.function ? `${String(d.function).toUpperCase()}()` : "";
  const lines = [[label && label !== key ? label : "", type, fn].filter(Boolean).join(" · ")];
  const lock = key === "id" ? "" : columnLockReason(key);
  if (lock) lines.push(lock);
  const tip = lines.filter(Boolean).join("\n");
  return tip ? ` title="${esc(tip)}"` : "";
}

// Related records, as a small table: under the row in the panel, in the
// inspector in the full window.
function subTableHtml(v, max = 50) {
  const rows = v.data || [];
  if (!rows.length) return '<div class="sub-empty">No related records.</div>';
  const keys = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  let h = '<div class="sub-table-wrap"><table class="sub-table"><thead><tr>';
  for (const k of keys) h += `<th${k === "id" ? ' class="col-id"' : ""}>${esc(k)}</th>`;
  h += "</tr></thead><tbody>";
  for (const r of rows.slice(0, max)) {
    h += "<tr>";
    for (const k of keys) {
      const val = r[k];
      const text = isSubValue(val) ? subSummary(val) : displayValue(val);
      h += `<td${k === "id" ? ' class="col-id"' : ""} title="${esc(text)}">${esc(text)}</td>`;
    }
    h += "</tr>";
  }
  h += "</tbody></table></div>";
  const total = Number(v.responseDetails?.total);
  const notes = [];
  const n = rows.length.toLocaleString();
  if (rows.length > max) notes.push(`Showing ${max} of ${n}. Copy JSON and the exports include all ${n}.`);
  if (Number.isFinite(total) && total > rows.length) {
    notes.push(`Vault returned ${n} of ${total.toLocaleString()}: a subquery sends one page of related records per row. Query the related object directly to get them all.`);
  }
  if (notes.length) h += `<div class="sub-note">${esc(notes.join(" "))}</div>`;
  return h;
}

// No related records: plain muted text, not a button that opens an empty list.
function subCellHtml(ri, key, v) {
  if (!v.data.length && !(Number(v.responseDetails?.total) > 0)) {
    return `<td class="cell-subq"><span class="sub-none">0 rows</span></td>`;
  }
  const tip = WINDOW_MODE ? `Related records (${key}). Shown in the inspector.` : `Related records (${key}). Click to show them.`;
  return (
    `<td class="cell-subq"><button type="button" class="sub-chip" data-row="${ri}" data-sub="${esc(key)}" ` +
    `${WINDOW_MODE ? "" : 'aria-expanded="false" '}title="${esc(tip)}">${esc(subSummary(v))}</button></td>`
  );
}

// A cell's tooltip: its value, then why it can't be edited if it can't.
function cellTip(display, why) {
  return [display, why].filter(Boolean).join("\n");
}

// Clicking a cell that won't edit says why, where the edit hint sits.
function explainLockedCell(td) {
  const tr = td.closest("tr[data-row]");
  const ri = parseInt(tr?.dataset.row);
  const keys = WINDOW_MODE ? resultKeys.filter((k) => !resultsView.hidden.has(k)) : resultKeys;
  const ci = [...tr.children].indexOf(td) - (WINDOW_MODE ? 1 : 0);
  const key = keys[ci];
  if (!key || key === "id" || !resultKeys.includes("id") || !Number.isInteger(ri)) return;
  const why = columnLockReason(key) || cellLockReason(ri, key);
  if (!why) return;
  const hint = WINDOW_MODE ? resultsHint : resultsContainer.querySelector(".edit-hint");
  if (!hint) return;
  clearTimeout(explainLockedCell.timer);
  const was = hint.dataset.was ?? hint.innerHTML;
  hint.dataset.was = was;
  hint.textContent = `${key}: ${why}`;
  hint.classList.add("hint-lock");
  explainLockedCell.timer = setTimeout(() => {
    hint.innerHTML = hint.dataset.was;
    delete hint.dataset.was;
    hint.classList.remove("hint-lock");
  }, 6000);
}

function getEditableFields(objectName) {
  // If we have data model, check for explicitly non-editable fields to exclude
  if (state.dataModel && objectName) {
    const obj = state.dataModel.objects.find(
      (o) => o.name.toLowerCase() === objectName.toLowerCase()
    );
    if (obj?.kind === "target") return new Set();
    if (obj) {
      const editable = new Set();
      for (const f of obj.fields) {
        // Include field unless explicitly marked non-editable
        const isEditable = f.editable === true || f.editable === "true" || f.editable === undefined;
        if (isEditable) editable.add(f.name);
      }
      // If the set is empty (metadata didn't have editable info), return all fields
      if (editable.size === 0) return "all";
      return editable;
    }
  }
  // No data model — still allow editing, API will reject if not allowed
  return "all";
}

const RESULT_ROW_CAP = 15;

function renderTable(rows) {
  queryObjectName = detectObjectFromQuery();
  queryRows = rows;
  pendingEdits = {};
  updateSaveBar();

  const keys = [];
  const keySet = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keySet.has(key)) {
        keySet.add(key);
        keys.push(key);
      }
    }
  }
  resultKeys = keys;
  // Runs from before this build, or restored tabs, may carry no metadata.
  if (!resultMeta) resultMeta = buildResultMeta(vqlShape(lastRunQuery), null, []);
  resultMeta.subKeys = new Set(keys.filter((k) => rows.some((r) => isSubValue(r[k]))));

  // The workbench pages, filters and selects; it draws its own table.
  if (WINDOW_MODE) {
    resetResultsView();
    paintResultsView();
    return;
  }

  const editableFields = getEditableFields(queryObjectName);
  const hasId = keys.includes("id");
  let html = '<table class="results-table"><thead><tr>';
  for (const key of keys) {
    const isId = key === "id";
    html += `<th class="${isId ? "col-id" : ""}"${columnHeaderAttr(key)}>${esc(key)}</th>`;
  }
  html += "</tr></thead><tbody>";

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    html += `<tr data-row="${ri}">`;
    for (const key of keys) {
      const val = row[key];
      if (isSubValue(val)) {
        html += subCellHtml(ri, key, val);
        continue;
      }
      const display = displayValue(val);
      const isId = key === "id";
      const canEdit = hasId && cellEditable(ri, key, editableFields);

      if (canEdit) {
        html += `<td class="editable" data-row="${ri}" data-field="${esc(key)}" title="Click to edit">${esc(display)}</td>`;
      } else if (isId) {
        html += `<td class="col-id" title="${esc(display)}">${esc(display)}</td>`;
      } else {
        const why = cellLockReason(ri, key);
        html += `<td${why ? ' class="cell-locked"' : ""} title="${esc(cellTip(display, why))}">${esc(display)}</td>`;
      }
    }
    html += "</tr>";
  }

  html += "</tbody></table>";

  // getEditableFields never returns empty, so id in the SELECT is the only gate.
  if (hasId) {
    html += '<div class="edit-hint">Click editable cells to modify values</div>';
  } else {
    html += '<div class="edit-hint">Include <b>id</b> in your SELECT to enable inline editing</div>';
  }

  resultsContainer.innerHTML = html;

  // Grow with the result set up to RESULT_ROW_CAP rows, then scroll.
  resultsContainer.style.maxHeight = "";
  const bodyRows = resultsContainer.querySelectorAll("tbody tr");
  if (bodyRows.length > RESULT_ROW_CAP) {
    const headRow = resultsContainer.querySelector("thead tr");
    const headH = headRow ? headRow.offsetHeight : 0;
    // max-height applies to the border box, so the border (and any horizontal
    // scrollbar) has to be added or the last row gets clipped.
    const frame = resultsContainer.offsetHeight - resultsContainer.clientHeight;
    resultsContainer.style.maxHeight =
      `${headH + bodyRows[0].offsetHeight * RESULT_ROW_CAP + frame}px`;
  }
}

// One listener for the life of the page rather than one per cell per render:
// the table is rebuilt on every run, page turn and filter keystroke.
resultsContainer.addEventListener("click", (e) => {
  if (e.target.closest(".sub-table")) return;
  const tr = e.target.closest("tbody tr[data-row]");
  if (!tr) return;
  if (WINDOW_MODE) selectResultRow(parseInt(tr.dataset.row));
  const chip = e.target.closest(".sub-chip");
  if (chip) {
    // The full window shows the related records in the inspector; the panel
    // opens them under the row.
    if (WINDOW_MODE) {
      const dd = inspFields.querySelector(`.insp-sub[data-sub="${CSS.escape(chip.dataset.sub)}"]`);
      dd?.scrollIntoView({ block: "nearest" });
      dd?.focus({ preventScroll: true });
    } else {
      toggleSubRow(tr, chip.dataset.sub);
    }
    return;
  }
  const td = e.target.closest("td.editable");
  if (td && !td.classList.contains("editing")) startEditing(td);
  else if (!td && !e.target.closest("a, button")) {
    const cell = e.target.closest("td");
    if (cell && !cell.classList.contains("row-num")) explainLockedCell(cell);
  }
});

function toggleSubRow(tr, key) {
  const open = tr.nextElementSibling?.classList.contains("sub-row") ? tr.nextElementSibling : null;
  const wasKey = open?.dataset.sub;
  open?.remove();
  tr.querySelectorAll(".sub-chip").forEach((c) => c.setAttribute("aria-expanded", "false"));
  if (wasKey === key) return;
  const v = queryRows[parseInt(tr.dataset.row)]?.[key];
  if (!isSubValue(v)) return;
  const row = document.createElement("tr");
  row.className = "sub-row";
  row.dataset.sub = key;
  row.innerHTML = `<td colspan="${tr.children.length}"><div class="sub-head">${esc(key)}</div>${subTableHtml(v)}</td>`;
  tr.after(row);
  tr.querySelector(`.sub-chip[data-sub="${CSS.escape(key)}"]`)?.setAttribute("aria-expanded", "true");
}

function startEditing(td) {
  if (td.classList.contains("editing")) return;

  const ri = parseInt(td.dataset.row);
  const field = td.dataset.field;
  const currentVal = pendingEdits[`${ri}:${field}`]?.newVal
    ?? (queryRows[ri][field] === null || queryRows[ri][field] === undefined ? "" : String(queryRows[ri][field]));

  td.classList.add("editing");
  const input = document.createElement("input");
  input.type = "text";
  input.value = currentVal;
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();

  const finish = () => {
    const newVal = input.value;
    const origVal = queryRows[ri][field] === null || queryRows[ri][field] === undefined ? "" : String(queryRows[ri][field]);

    td.classList.remove("editing");
    td.innerHTML = cellContent(field, newVal);
    if (WINDOW_MODE) td.title = newVal;

    if (newVal !== origVal) {
      td.classList.add("dirty");
      pendingEdits[`${ri}:${field}`] = { rowIdx: ri, field, oldVal: origVal, newVal };
    } else {
      td.classList.remove("dirty");
      delete pendingEdits[`${ri}:${field}`];
    }
    updateSaveBar();
    // The inspector shows the edited value, not the one Vault last returned.
    if (WINDOW_MODE && resultsView.selected === ri) renderInspector();
  };

  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { input.blur(); }
    if (ev.key === "Escape") {
      // Revert to original
      const origVal = queryRows[ri][field] === null || queryRows[ri][field] === undefined ? "" : String(queryRows[ri][field]);
      input.value = pendingEdits[`${ri}:${field}`] ? pendingEdits[`${ri}:${field}`].newVal : origVal;
      input.blur();
    }
    if (ev.key === "Tab") {
      ev.preventDefault();
      input.blur();
      // Jump to next editable cell
      const allEditable = [...resultsContainer.querySelectorAll("td.editable")];
      const idx = allEditable.indexOf(td);
      const next = allEditable[ev.shiftKey ? idx - 1 : idx + 1];
      if (next) next.click();
    }
  });
}

function updateSaveBar() {
  const count = Object.keys(pendingEdits).length;
  if (count === 0) {
    saveBar.classList.add("hidden");
  } else {
    saveBar.classList.remove("hidden");
    saveBarCount.textContent = `${count} change${count !== 1 ? "s" : ""}`;
  }
}

// Discard all edits
discardBtn.addEventListener("click", () => {
  pendingEdits = {};
  // Re-render the table with original data. The workbench repaints in place so
  // the filter, page and selection survive.
  if (WINDOW_MODE) {
    paintResultsView();
    renderInspector();
  } else if (queryRows.length > 0) {
    renderTable(queryRows);
  }
  updateSaveBar();
});

// Save changes — group edits by row, send one PUT per row
saveBtn.addEventListener("click", async () => {
  if (!state.sessionId) {
    showSaveError("Not connected.");
    return;
  }
  if (!queryObjectName) {
    showSaveError("Could not detect object name from query. Make sure your query has a FROM clause.");
    return;
  }

  const editsByRow = {};
  for (const edit of Object.values(pendingEdits)) {
    if (!editsByRow[edit.rowIdx]) editsByRow[edit.rowIdx] = [];
    editsByRow[edit.rowIdx].push(edit);
  }

  if (Object.keys(editsByRow).length === 0) return;

  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span> Saving...';

  const isDoc = queryObjectName.toLowerCase() === "documents";
  const errors = [];

  for (const [rowIdxStr, edits] of Object.entries(editsByRow)) {
    const ri = parseInt(rowIdxStr);
    const row = queryRows[ri];
    if (!row) { errors.push(`Row ${ri}: not found in data`); continue; }

    const recordId = row.id;
    if (!recordId) { errors.push(`Row ${ri}: no id field — include id in your SELECT`); continue; }

    const tr = resultsContainer.querySelector(`tr[data-row="${ri}"]`);
    if (tr) tr.classList.add("saving");

    // Documents: Update Single Document, form-encoded. Objects: Update Object
    // Records, which takes CSV (or JSON) and answers per record — the batch
    // can say SUCCESS while the one record in it failed.
    let result;
    if (isDoc) {
      const body = edits
        .map((e) => `${encodeURIComponent(e.field)}=${encodeURIComponent(e.newVal)}`)
        .join("&");
      result = await apiCall(`/objects/documents/${recordId}`, "PUT", body);
    } else {
      const csv = `${["id", ...edits.map((e) => e.field)].map(csvField).join(",")}\n` +
        `${[recordId, ...edits.map((e) => e.newVal)].map(csvField).join(",")}\n`;
      result = await apiCall(`/vobjects/${queryObjectName}`, "PUT", csv, null, "text/csv");
      const rec = result.data?.data?.[0];
      if (result.success && rec && rec.responseStatus === "FAILURE") {
        result = { success: true, data: { responseStatus: "FAILURE", errors: rec.errors || [{ message: "Vault refused the update" }] } };
      }
    }

    if (tr) tr.classList.remove("saving");

    if (result.success && result.data?.responseStatus !== "FAILURE") {
      for (const e of edits) {
        queryRows[ri][e.field] = e.newVal;
        delete pendingEdits[`${e.rowIdx}:${e.field}`];
        const td = resultsContainer.querySelector(`td[data-row="${ri}"][data-field="${e.field}"]`);
        if (td) td.classList.remove("dirty");
      }
      if (tr) {
        tr.classList.add("save-ok");
        setTimeout(() => tr.classList.remove("save-ok"), 1500);
      }
    } else {
      const errMsg = result.data?.errors?.map((e) => e.message).join(", ") || result.error || "Unknown error";
      errors.push(`Row ${ri} (id: ${recordId}): ${errMsg}`);
      if (tr) {
        tr.classList.add("save-err");
        tr.title = errMsg;
        setTimeout(() => { tr.classList.remove("save-err"); tr.title = ""; }, 5000);
      }
    }
  }

  saveBtn.disabled = false;
  saveBtn.innerHTML = "Save Changes";
  updateSaveBar();
  if (WINDOW_MODE) renderInspector();

  if (errors.length > 0) {
    showSaveError(errors.join("\n"));
  }
});

function showSaveError(msg) {
  // Show error below the save bar
  let errDiv = resultsContainer.parentElement.querySelector(".save-error");
  if (!errDiv) {
    errDiv = document.createElement("div");
    errDiv.className = "save-error result-message error";
    saveBar.after(errDiv);
  }
  errDiv.textContent = msg;
  errDiv.style.marginTop = "8px";
  setTimeout(() => errDiv.remove(), 8000);
}

// ===================== DOC TYPES =====================
// Two calls to enumerate: list the types, then follow each type's own link to
// get its properties[] — Vault has no page-layout endpoint, so the field set
// comes back as part of the type.
const dtChip = $("#dt-chip");
const dtChipLabel = $("#dt-chip-label");
const dtLayout = $("#dt-layout");
const dtEmpty = $("#dt-empty");
const dtCountBtn = $("#dt-count-btn");
const dtCountLabel = $("#dt-count-label");
const dtTree = $("#dt-tree");
const dtBreadcrumb = $("#dt-breadcrumb");
const dtFields = $("#dt-fields");
const dtStats = $("#dt-stats");
const dtFieldCount = $("#dt-field-count");

const DT_BATCH = 5;          // concurrent type fetches

let docTypes = [];
let docTypesTime = null;     // when the types on screen were loaded or counted
let dtSelected = null;
let dtCounting = false;
let dtLoading = false;

// An HTTP 200 from Vault can still be a failure; the real verdict is in the body.
function apiOk(result) {
  return !!result?.success && result.data?.responseStatus !== "FAILURE";
}

function apiErr(result) {
  return (
    result?.data?.errors?.[0]?.message ||
    result?.error ||
    "Vault returned no explanation"
  );
}

// The type list hands back absolute links that already carry /api/vXX.X/. Reduce
// them to a path so the request still goes through the background worker's
// versioning rule — and never follow a link pointing off our own vault.
function vaultPath(link) {
  if (!link) return null;
  try {
    const u = new URL(link);
    if (state.domain && u.hostname !== state.domain) return null;
    return u.pathname + (u.search || "");
  } catch (e) {
    return link.startsWith("/") ? link : "/" + link;
  }
}

// Single quotes are the only thing that can break out of a VQL literal.
function vqlStr(s) {
  return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "''");
}

const DT_CHIP_LABELS = {
  idle: "LOAD TYPES",
  idleTitle: "Load document types and the fields on each layout",
  loading: "LOADING",
  loadingTitle: "Loading document types",
  loaded: "TYPES",
  loadedTitle: "Reload document types",
};

function setDtChipState(phase, opts = {}) {
  applyChipState(dtChip, dtChipLabel, phase, DT_CHIP_LABELS, opts);
}

dtChip.addEventListener("click", () => {
  if (dtLoading) return;
  loadDocTypes();
});

async function loadDocTypes() {
  if (dtLoading) return;
  if (!state.sessionId) {
    setDtChipState("failed", { title: "Connect to a Vault first" });
    return;
  }

  dtLoading = true;
  setDtChipState("loading", { title: "Listing document types…" });
  dtTree.innerHTML = '<div class="dt-children-loading"><span class="spinner"></span> Loading…</div>';
  dtFields.innerHTML = "";
  dtBreadcrumb.innerHTML = "";
  dtStats.classList.add("hidden");
  dtSelected = null;

  try {
    // Call 1 — the list. `label` is display text; the API name is the last
    // segment of `value` and is never derived from the label.
    const listed = await apiCall("/metadata/objects/documents/types");
    if (!apiOk(listed)) {
      setDtChipState("failed", { title: `Couldn't list types: ${apiErr(listed)}` });
      // The tree was blanked to a spinner before this call; say what happened
      // rather than leaving it spinning with the reason hidden in a tooltip.
      dtTree.innerHTML = `<div class="dm-empty">Couldn't list document types.<br />${esc(
        apiErr(listed)
      )}</div>`;
      return;
    }

    const raw = listed.data?.types || [];
    const types = raw.map((t) => {
      const link = t.value || "";
      const tail = link.split("/").pop() || "";
      return {
        label: t.label || tail || "(unnamed)",
        name: t.name || tail,
        link,
        properties: null,
        subtypes: [],
        error: null,
      };
    });

    if (!types.length) {
      setDtChipState("loaded", { title: "No document types in this vault" });
      dtEmpty.textContent = "This vault has no document types.";
      return;
    }

    // Call 2 — one per type, following the link Vault handed back.
    let done = 0;
    for (let i = 0; i < types.length; i += DT_BATCH) {
      const batch = types.slice(i, i + DT_BATCH);
      await Promise.all(
        batch.map(async (t) => {
          const path = vaultPath(t.link);
          if (!path) {
            t.error = "type link missing or points off-domain";
            return;
          }
          const res = await apiCall(path);
          if (!apiOk(res)) {
            t.error = apiErr(res);
            return;
          }
          t.properties = res.data?.properties || [];
          t.subtypes = res.data?.subtypes || [];
        })
      );
      done += batch.length;
      setDtChipState("loading", {
        done,
        total: types.length,
        title: `Fetching fields… ${done}/${types.length}`,
      });
    }

    applyDocTypes(types, new Date().toISOString());
    // Saved per vault, like the data model, so switching between the panel and
    // the full window doesn't mean loading them all over again.
    const unsaved = await saveDocTypes();
    if (unsaved) {
      setDtChipState("loaded", { title: `Loaded, but not saved for next time: ${unsaved.message}` });
    }
  } catch (err) {
    setDtChipState("failed", { title: `Load failed: ${err.message}` });
  } finally {
    dtLoading = false;
  }
}

function docTypesSummary(types) {
  const failed = types.filter((t) => t.error).length;
  const withFields = types.filter((t) => t.properties).length;
  return `${types.length} types · ${withFields} with fields` + (failed ? ` · ${failed} failed` : "");
}

// Puts a set of types on screen: freshly loaded, restored from storage on
// connect, or saved by another view while this one was open.
function applyDocTypes(types, time) {
  const keep = dtSelected?.name;
  docTypes = types;
  docTypesTime = time || null;
  dtSelected = null;
  dtFields.innerHTML = "";
  dtBreadcrumb.innerHTML = "";
  dtStats.classList.add("hidden");
  paintDtCountControls();
  renderDocTypeList();
  dtLayout.classList.remove("hidden");
  dtEmpty.classList.add("hidden");
  // A type that was open stays open if it's still there.
  if (keep) {
    dtTree.querySelector(`.dt-node[data-name="${CSS.escape(keep)}"] .dt-node-header`)?.click();
  }
  const when = time ? ` · loaded ${new Date(time).toLocaleString()}` : "";
  setDtChipState("loaded", { title: `${docTypesSummary(types)}${when} — click to reload` });
}

// Only what the Doc Types pane reads. Raw properties carry much more,
// and across every type of a large vault that runs to megabytes of storage.
const DT_KEEP_PROPS = [
  "name", "label", "type", "required", "editable", "repeating", "hidden", "disabled", "scope",
  "section", "section__v", "sectionPosition", "section_position", "order",
  // A picklist field's values as this type lists them: the fallback when
  // the picklist API can't be asked.
  "entryNames", "entryLabels", "picklist",
];

function slimDocType(t) {
  const pick = (p) =>
    Object.fromEntries(DT_KEEP_PROPS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  return {
    label: t.label,
    name: t.name,
    link: t.link,
    error: t.error || null,
    subtypes: t.subtypes || [],
    properties: t.properties ? t.properties.map(pick) : null,
    docCount: t.docCount ?? null,
    countError: t.countError || null,
  };
}

// Returns the error when the save fails, so the caller can say so; the types
// stay loaded in this view either way.
async function saveDocTypes() {
  if (!state.domain || !docTypes.length) return null;
  try {
    await saveVaultCache("docTypeCache", state.domain, {
      time: docTypesTime,
      types: docTypes.map(slimDocType),
    });
    return null;
  } catch (e) {
    return e;
  }
}

async function loadDocTypesForDomain(domain) {
  const entry = await readVaultCache("docTypeCache", domain);
  if (entry?.types?.length) applyDocTypes(entry.types, entry.time);
  // A vault with none saved starts empty: types left on screen from another
  // vault would otherwise be counted, and saved, as this one's.
  else if (docTypes.length) clearDocTypes();
}

function clearDocTypes() {
  docTypes = [];
  docTypesTime = null;
  dtSelected = null;
  dtLayout.classList.add("hidden");
  dtTree.innerHTML = "";
  dtFields.innerHTML = "";
  dtEmpty.classList.remove("hidden");
  setDtChipState("idle");
}

// The count chip reads as the load chips do: gold to start, a progress fill
// while it runs, green once counted (a click recounts), red when types failed.
const DT_COUNT_LABELS = {
  idle: "COUNT RECORDS",
  idleTitle: "Count the documents of each type: one small query per type",
  loading: "COUNTING",
  loadingTitle: "Counting documents",
  loaded: "COUNTED",
  loadedTitle: "Recount records",
};

// The chip and the sort follow whether the types on screen carry counts —
// they may have arrived counted, from storage.
function paintDtCountControls() {
  const counted = docTypes.filter((t) => t.docCount != null).length;
  const failed = docTypes.filter((t) => t.countError);
  const when = docTypesTime ? `, ${relativeTime(Date.parse(docTypesTime)).toLowerCase()}` : "";
  if (failed.length) {
    applyChipState(dtCountBtn, dtCountLabel, "failed", DT_COUNT_LABELS);
    dtCountLabel.textContent = `${failed.length} FAILED`;
    dtCountBtn.title =
      `${counted} of ${docTypes.length} types counted${when}. Not counted: ` +
      `${failed.map((t) => `${t.label} (${t.countError})`).join(", ")}. Click to recount.`;
  } else if (counted) {
    applyChipState(dtCountBtn, dtCountLabel, "loaded", DT_COUNT_LABELS, {
      title: `${counted} of ${docTypes.length} types counted${when}. Click to recount.`,
    });
  } else {
    applyChipState(dtCountBtn, dtCountLabel, "idle", DT_COUNT_LABELS);
  }
}

function renderDocTypeList() {
  // A-Z, counted or not: the order never moves under you.
  const ordered = [...docTypes].sort((a, b) => a.label.localeCompare(b.label));

  let html = "";
  for (const t of ordered) {
    const sub = t.subtypes && t.subtypes.length ? ` · ${t.subtypes.length} subtypes` : "";
    const tip = t.error
      ? t.error
      : `${t.name}${sub}` +
        (t.docCount != null ? ` · ${t.docCount.toLocaleString()} documents` : "") +
        (t.countError ? ` · count failed: ${t.countError}` : "") +
        (t.properties ? ` · ${t.properties.length} fields` : "");

    let cell;
    if (t.docCount != null) {
      cell =
        `<span class="dt-type-count counted t${countTier(t.docCount)}">` +
        `${esc(compactCount(t.docCount))}</span>`;
    } else if (t.countError) {
      cell = '<span class="dt-type-count failed">!</span>';
    } else {
      // Not counted yet: the quiet field tally, as before.
      const fieldCount = t.error ? "!" : t.properties ? String(t.properties.length) : "–";
      cell = `<span class="dt-type-count">${esc(fieldCount)}</span>`;
    }

    html += `<div class="dt-node" data-name="${esc(t.name)}">`;
    html += `<div class="dt-node-header" title="${esc(tip)}">`;
    html += `<span class="dt-node-icon">&#128196;</span>`;
    html += `<span class="dt-node-label">${esc(t.label)}</span>`;
    html += `<span class="dt-node-sublabel">${esc(t.name)}</span>`;
    html += cell;
    html += `</div></div>`;
  }
  dtTree.innerHTML = html;
}

// Depth of tint, not length of bar. Document counts in a vault run from single
// digits to millions; a bar scaled to the largest type would leave every other
// row empty, and scaling it logarithmically would draw a proportion the data
// does not support. One hue, five steps, deeper = bigger — and the exact figure
// sits on top, so magnitude is never carried by colour alone.
function countTier(n) {
  if (n === 0) return 0;
  if (n < 100) return 1;
  if (n < 1000) return 2;
  if (n < 10000) return 3;
  if (n < 100000) return 4;
  return 5;
}

// Exact while it fits the column, compact past it; the row tooltip always
// carries the full figure.
function compactCount(n) {
  if (n < 10000) return n.toLocaleString();
  if (n < 1000000) {
    const k = n / 1000;
    return `${k < 100 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}K`;
  }
  const m = n / 1000000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}M`;
}

// One button, one query per type: SELECT id FROM documents WHERE
// TONAME(type__v) = '<name>'. By name, not label: labels are translated into
// each user's language and can be renamed, which Veeva's VQL reference gives
// as the reason to filter with TONAME(). responseDetails.total carries the
// full count, so PAGESIZE 1 keeps the payload tiny while still answering
// "how many".
dtCountBtn.addEventListener("click", countDocTypeRecords);

async function countDocTypeRecords() {
  if (dtCounting || !docTypes.length || !state.sessionId) return;

  dtCounting = true;
  dtCountBtn.disabled = true;
  const total = docTypes.length;
  let done = 0;
  const progress = () =>
    applyChipState(dtCountBtn, dtCountLabel, "loading", DT_COUNT_LABELS, {
      done,
      total,
      title: `Counting the documents of each type… ${done} of ${total}`,
    });
  progress();

  const count = (where) =>
    apiCall("/query", "POST", `q=${encodeURIComponent(`SELECT id FROM documents WHERE ${where} PAGESIZE 1`)}`);

  const runOne = async (t) => {
    let res = t.name ? await count(`TONAME(type__v) = '${vqlStr(t.name)}'`) : null;
    // A type whose API name Vault won't match this way still gets a count by label.
    if (!apiOk(res)) res = await count(`type__v = '${vqlStr(t.label)}'`);
    if (apiOk(res)) {
      const reported = Number(res.data?.responseDetails?.total);
      t.docCount = Number.isFinite(reported)
        ? reported
        : (res.data?.data || []).length;
      // Clear the other side, or a recount that succeeds keeps reporting the
      // previous failure in the button and the row tooltips.
      t.countError = null;
    } else {
      t.countError = apiErr(res);
      t.docCount = null;
    }
    done++;
    progress();
  };

  try {
    for (let i = 0; i < docTypes.length; i += DT_BATCH) {
      await Promise.all(docTypes.slice(i, i + DT_BATCH).map(runOne));
      renderDocTypeList();
    }

    // Counts are worth keeping too: they cost one query per type.
    docTypesTime = new Date().toISOString();
    paintDtCountControls();
    renderDocTypeList();
    await saveDocTypes();
  } finally {
    dtCounting = false;
    dtCountBtn.disabled = false;
    // A run that stopped part-way shouldn't leave the chip mid-progress.
    paintDtCountControls();
  }
}

dtTree.addEventListener("click", (e) => {
  const header = e.target.closest(".dt-node-header");
  if (!header) return;
  const name = header.closest(".dt-node")?.dataset.name;
  const type = docTypes.find((t) => t.name === name);
  if (!type) return;

  dtTree.querySelectorAll(".dt-node-header.selected").forEach((h) => h.classList.remove("selected"));
  header.classList.add("selected");
  dtSelected = type;
  showDocTypeFields(type);
});

// ---- layout placement ------------------------------------------------------
// The doc info panel is built from section + sectionPosition, so a property with
// no section has no placement on the form. Prior work in this repo disagreed on
// the spelling, so read both rather than betting on one.
// Vault returns file_info__v at the top of the layout, but it is boilerplate
// (file name, size, format) rather than classification data, so it reads better
// last. Matches either a section heading or a field name.
const DT_PIN_LAST = ["file_info__v"];

function isPinnedLast(name) {
  const n = String(name || "").toLowerCase();
  return DT_PIN_LAST.some((p) => p.toLowerCase() === n);
}

function fieldSection(p) {
  const s = p.section != null ? p.section : p.section__v;
  return s == null || s === "" ? null : String(s);
}

function fieldSectionPos(p) {
  const v =
    p.sectionPosition != null
      ? p.sectionPosition
      : p.section_position != null
      ? p.section_position
      : p.order;
  const n = Number(v);
  return Number.isFinite(n) ? n : 9999;
}

// Returns { onLayout, off, detected }. When no property in the set carries a
// section at all, placement isn't on this response — report everything rather
// than an empty panel that reads as a failed load.
function splitByLayout(props) {
  if (!props.some((p) => fieldSection(p) !== null)) {
    return { onLayout: props, off: [], detected: false };
  }
  const onLayout = [];
  const off = [];
  for (const p of props) {
    const placed =
      fieldSection(p) !== null && p.hidden !== true && p.disabled !== true;
    (placed ? onLayout : off).push(p);
  }
  return { onLayout, off, detected: true };
}

// Not fieldRowHtml: that is the data model's row builder, and a second
// top-level function of the same name silently replaces the first everywhere.
function dtFieldRowHtml(p) {
  const pick = isPicklistProp(p);
  let h = pick
    ? `<div class="dt-field-row dt-pick" data-fname="${esc(p.name || "")}" role="button" tabindex="0" aria-expanded="false" title="Show this picklist's values">`
    : `<div class="dt-field-row" data-fname="${esc(p.name || "")}">`;
  h += `<span class="dt-field-name" title="${esc(p.name || "")}">${esc(p.name || "")}</span>`;
  h += `<span class="dt-field-label">${esc(p.label || "")}</span>`;
  h += `<span class="dt-field-badges">`;
  if (p.required === true) h += '<span class="dt-badge req">REQ</span>';
  if (p.editable === false) h += '<span class="dt-badge locked">READ-ONLY</span>';
  if (p.repeating === true) h += '<span class="dt-badge rep">MULTI</span>';
  if (p.hidden === true) h += '<span class="dt-badge locked">HIDDEN</span>';
  if (p.scope) h += `<span class="dt-badge scope">${esc(p.scope)}</span>`;
  if (p.type) h += `<span class="dt-badge type-badge">${esc(p.type)}${pick ? ' <span aria-hidden="true">▾</span>' : ""}</span>`;
  h += `</span></div>`;
  return h;
}

// ---- Picklist values ----------------------------------------------------------
// A picklist field opens its values under its row. They come from Retrieve
// Picklist Values (GET /objects/picklists/{name}). Document fields don't name
// their picklist, so a one-row describe query asks for it first; if either
// call fails, the entries this type's own metadata listed are shown instead.
const picklistNames = new Map();   // document field -> picklist name, or null
const picklistValueSets = new Map(); // picklist -> [{ name, label }], or null
const DT_VALUES_FILTER_AT = 12;

function isPicklistProp(p) {
  return /picklist/i.test(String(p?.type || ""));
}

async function picklistNameFor(field) {
  if (picklistNames.has(field)) return picklistNames.get(field);
  let name = null;
  if (/^[a-z_][a-z0-9_]*$/i.test(field)) {
    const res = await apiCall(
      "/query", "POST",
      `q=${encodeURIComponent(`SELECT ${field} FROM documents MAXROWS 1`)}`,
      { "X-VaultAPI-DescribeQuery": "true" }
    );
    if (apiOk(res)) name = res.data?.queryDescribe?.fields?.find((f) => f.name === field)?.picklist || null;
  }
  picklistNames.set(field, name);
  return name;
}

async function loadPicklistValues(prop) {
  const fromType = Array.isArray(prop.entryNames)
    ? prop.entryNames.map((n, i) => ({ name: n, label: prop.entryLabels?.[i] ?? "" }))
    : null;
  const pick = prop.picklist || (await picklistNameFor(prop.name));
  if (pick) {
    if (!picklistValueSets.has(pick)) {
      const res = await apiCall(`/objects/picklists/${encodeURIComponent(pick)}`);
      picklistValueSets.set(
        pick,
        apiOk(res) && Array.isArray(res.data?.picklistValues)
          ? res.data.picklistValues.map((v) => ({ name: v.name, label: v.label || "" }))
          : null
      );
    }
    const values = picklistValueSets.get(pick);
    if (values) return { values, source: `picklist ${pick}` };
  }
  if (fromType) return { values: fromType, source: "this type's metadata" };
  return { values: null, source: "" };
}

function renderDtValues(box, result) {
  const vals = result.values;
  if (!vals) {
    box.innerHTML = '<div class="dt-values-head">Vault didn\'t return values for this field.</div>';
    return;
  }
  if (!vals.length) {
    box.innerHTML = `<div class="dt-values-head">No active values · ${esc(result.source)}</div>`;
    return;
  }
  const filter = vals.length > DT_VALUES_FILTER_AT
    ? `<input type="search" class="dt-values-filter" placeholder="Filter ${vals.length} values" aria-label="Filter values" spellcheck="false" />`
    : "";
  box.innerHTML =
    `<div class="dt-values-head">${vals.length} value${vals.length === 1 ? "" : "s"} · ${esc(result.source)} · click to copy</div>` +
    filter +
    '<div class="dt-values-list">' +
    vals
      .map(
        (v) =>
          `<button type="button" class="dt-value" data-name="${esc(v.name)}" title="Copy ${esc(v.name)}">` +
          `<span class="dt-value-label">${esc(v.label || v.name)}</span>` +
          `<span class="dt-value-name">${esc(v.name)}</span></button>`
      )
      .join("") +
    "</div>";
}

async function toggleDtValues(row) {
  const open = row.nextElementSibling?.classList.contains("dt-values") ? row.nextElementSibling : null;
  if (open) {
    open.remove();
    row.setAttribute("aria-expanded", "false");
    return;
  }
  row.setAttribute("aria-expanded", "true");
  const field = row.dataset.fname;
  const box = document.createElement("div");
  box.className = "dt-values";
  box.dataset.field = field;
  box.innerHTML = '<div class="dt-values-head">Loading values…</div>';
  row.after(box);
  const prop = (dtSelected?.properties || []).find((x) => x.name === field) || { name: field };
  const result = await loadPicklistValues(prop);
  if (box.isConnected) renderDtValues(box, result);
}

function showDocTypeFields(type) {
  dtBreadcrumb.innerHTML =
    '<span class="dt-bc-item">Documents</span>' +
    ' <span class="dt-bc-sep">&#8250;</span> ' +
    `<span class="dt-bc-item">${esc(type.label)}</span>`;

  if (type.error) {
    dtStats.classList.add("hidden");
    dtFields.innerHTML = `<div class="dm-empty">Couldn't load this type.<br />${esc(type.error)}</div>`;
    return;
  }

  const props = type.properties || [];
  const { onLayout, off, detected } = splitByLayout(props);
  type._layout = onLayout;
  type._layoutDetected = detected;

  dtStats.classList.remove("hidden");
  dtFieldCount.innerHTML = detected
    ? `${onLayout.length} <small>on layout &middot; ${props.length} total</small>`
    : `${props.length} <small>fields on this type</small>`;

  if (!props.length) {
    dtFields.innerHTML = '<div class="dm-empty">This type declares no fields.</div>';
    return;
  }

  let html = "";

  if (!detected) {
    html +=
      '<div class="dt-field-count">' +
      `${props.length} fields &middot; no section data on this response, showing all` +
      "</div>";
    // No placement data, so payload order is the only sequence Vault gives —
    // bar the pinned boilerplate, which still belongs at the end.
    const order = new Map(props.map((p, i) => [p, i]));
    const flat = [...props].sort(
      (a, b) =>
        (isPinnedLast(a.name) ? 1 : 0) - (isPinnedLast(b.name) ? 1 : 0) ||
        order.get(a) - order.get(b)
    );
    for (const p of flat) html += dtFieldRowHtml(p);
    dtFields.innerHTML = html;
    return;
  }

  // Group into sections and reproduce the panel's own order: fields by
  // sectionPosition within a section, sections by where they first appear.
  const groups = new Map();
  for (const p of onLayout) {
    const s = fieldSection(p) || "General";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(p);
  }
  // Fields read in true form order: sectionPosition within the section, then the
  // order Vault returned. Required fields are badged, not reordered — moving them
  // would break the sequence someone filling the form actually sees.
  const payloadOrder = new Map(props.map((p, i) => [p, i]));
  for (const list of groups.values()) {
    list.sort(
      (a, b) =>
        (isPinnedLast(a.name) ? 1 : 0) - (isPinnedLast(b.name) ? 1 : 0) ||
        fieldSectionPos(a) - fieldSectionPos(b) ||
        payloadOrder.get(a) - payloadOrder.get(b)
    );
  }
  // Order the sections themselves. sectionPosition may be numbered globally
  // across the layout or restarted per section — Vault is not documented either
  // way — so take each section's lowest position and fall back to the order it
  // first appeared in the payload. Global numbering sorts correctly; per-section
  // numbering ties on 1 and keeps payload order. Right under both readings.
  const sectionFirstSeen = new Map();
  for (const [name, list] of groups) {
    sectionFirstSeen.set(name, Math.min(...list.map((p) => payloadOrder.get(p))));
  }
  const sectionNames = [...groups.keys()].sort((a, b) => {
    const pinned = (isPinnedLast(a) ? 1 : 0) - (isPinnedLast(b) ? 1 : 0);
    if (pinned) return pinned;
    const pa = Math.min(...groups.get(a).map(fieldSectionPos));
    const pb = Math.min(...groups.get(b).map(fieldSectionPos));
    return pa - pb || sectionFirstSeen.get(a) - sectionFirstSeen.get(b);
  });

  const requiredCount = onLayout.filter((p) => p.required === true).length;
  html += `<div class="dt-field-count">${onLayout.length} on layout &middot; ${requiredCount} required &middot; ${sectionNames.length} section${sectionNames.length === 1 ? "" : "s"}</div>`;

  for (const name of sectionNames) {
    html += '<div class="dt-section">';
    html += `<div class="dt-section-header">${esc(name)}</div>`;
    for (const p of groups.get(name)) html += dtFieldRowHtml(p);
    html += "</div>";
  }

  if (off.length) {
    const offSorted = [...off].sort((a, b) => payloadOrder.get(a) - payloadOrder.get(b));
    html += '<div class="dt-offlayout" id="dt-offlayout">';
    html += `<button type="button" class="dt-offlayout-toggle" aria-expanded="false">`;
    html += `<span class="dt-offlayout-arrow">&#9654;</span> Not on layout (${off.length})`;
    html += `</button>`;
    html += '<div class="dt-offlayout-body">';
    for (const p of offSorted) html += dtFieldRowHtml(p);
    html += "</div></div>";
  }

  dtFields.innerHTML = html;
}

dtFields.addEventListener("click", async (e) => {
  const value = e.target.closest(".dt-value");
  if (value) {
    try {
      await navigator.clipboard.writeText(value.dataset.name);
    } catch (err) {
      return;
    }
    const name = value.querySelector(".dt-value-name");
    name.textContent = "copied";
    value.classList.add("copied");
    setTimeout(() => {
      name.textContent = value.dataset.name;
      value.classList.remove("copied");
    }, 1200);
    return;
  }
  const pick = e.target.closest(".dt-pick");
  if (pick) {
    toggleDtValues(pick);
    return;
  }
  const btn = e.target.closest(".dt-offlayout-toggle");
  if (!btn) return;
  const wrap = btn.closest(".dt-offlayout");
  const open = wrap.classList.toggle("open");
  btn.setAttribute("aria-expanded", String(open));
});

dtFields.addEventListener("keydown", (e) => {
  const pick = e.target.closest?.(".dt-pick");
  if (pick && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    toggleDtValues(pick);
  }
});

dtFields.addEventListener("input", (e) => {
  const input = e.target.closest(".dt-values-filter");
  if (!input) return;
  const f = input.value.trim().toLowerCase();
  for (const v of input.parentElement.querySelectorAll(".dt-value")) {
    v.hidden = !!f && !v.textContent.toLowerCase().includes(f);
  }
});

// ===================== AI PROVIDER KEY =====================
// Entered and checked on the Skills tab. The key is written to and verified by
// background.js and never read back into this page — popup.js only ever learns
// whether one exists and its last 4 chars.
const AI_PROVIDER_META = {
  anthropic: {
    label: "Anthropic",
    prefix: "sk-ant-",
  },
  openai: {
    label: "OpenAI",
    prefix: "sk-proj-",
  },
  gemini: {
    label: "Gemini",
    prefix: "AIza",
  },
};

const aiMeta = (id) => AI_PROVIDER_META[id] || AI_PROVIDER_META.anthropic;

// What background.js last told us about the stored key.
let aiSaved = { hasKey: false, provider: "anthropic", verified: false, hint: "" };
// Replacing a verified key: the form is up, with a way back to the key in use.
let aiReplacing = false;
// The provider picked in the form (the marks in the key field's prefix).
let aiProvider = "anthropic";

function setAiProvider(id) {
  aiProvider = AI_PROVIDER_META[id] ? id : "anthropic";
  for (const b of aiProviderGroup.querySelectorAll(".ai-prov")) {
    const on = b.dataset.provider === aiProvider;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  aiKeyInput.placeholder = `${aiMeta(aiProvider).prefix}…`;
}

// One place decides what the card shows. state: none | checking | bad | ok.
function paintAi(state, error = "") {
  aiCard.dataset.state = state;
  aiKeyError.textContent = state === "bad" ? error : "";
  const checking = state === "checking";
  aiKeySave.disabled = checking;
  aiKeySave.textContent = checking ? "Verifying…" : "Verify";
  aiKeyInput.disabled = checking;
  for (const b of aiProviderGroup.querySelectorAll(".ai-prov")) b.disabled = checking;
  aiKeyCancel.hidden = !aiReplacing || checking;
  // A saved key that hasn't passed can still be thrown away from the form.
  aiKeyDrop.hidden = aiReplacing || checking || !aiSaved.hasKey;
  if (state === "ok") {
    aiConnName.textContent = aiMeta(aiSaved.provider).label;
    const mark = aiProviderGroup.querySelector(`[data-provider="${aiSaved.provider}"] svg`);
    aiConnLogo.innerHTML = mark ? mark.outerHTML : "";
    aiConnMeta.textContent = `API key ${aiSaved.hint} · verified`;
  }
}

function setAiKeyMasked(masked) {
  aiKeyInput.type = masked ? "password" : "text";
  aiKeyReveal.textContent = masked ? "show" : "hide";
}

async function refreshAiKeyState() {
  const res = await chrome.runtime.sendMessage({ action: "aiKeyState" });
  if (!res?.success) return;
  aiSaved = { hasKey: res.hasKey, provider: res.provider || "anthropic", verified: res.verified, hint: res.hint || "" };
  aiReplacing = false;
  setAiProvider(aiSaved.provider);
  aiKeyInput.value = "";
  setAiKeyMasked(true);

  if (!aiSaved.hasKey) return paintAi("none");
  if (aiSaved.verified === true) return paintAi("ok");
  // Stored before verification was tracked — test it once rather than
  // showing a state we cannot vouch for.
  if (aiSaved.verified === null) return runAiVerify();
  paintAi("bad", `The saved key (${aiSaved.hint}) hasn't passed a check yet. Verify to retry, or paste a new one.`);
}

// Tests whatever key is stored. Shared by Verify and the migration check above.
async function runAiVerify() {
  paintAi("checking");
  const res = await chrome.runtime.sendMessage({ action: "aiVerifyKey" });
  if (res?.success) {
    aiSaved = { hasKey: true, provider: res.provider, verified: true, hint: res.hint || aiSaved.hint };
    aiReplacing = false;
    paintAi("ok");
  } else {
    aiSaved.verified = false;
    aiReplacing = false;
    paintAi("bad", res?.error || "The key could not be checked.");
  }
  return !!res?.success;
}

// One action: store the key, then prove it works. With the field empty it
// re-tests the key already saved, if there is one for this provider.
async function aiVerifyClicked() {
  const key = aiKeyInput.value.trim();
  const provider = aiProvider;
  if (!key) {
    if (aiSaved.hasKey && !aiReplacing && aiSaved.provider === provider) return runAiVerify();
    paintAi("bad", `Paste a key beginning ${aiMeta(provider).prefix} first.`);
    aiKeyInput.focus();
    return;
  }
  paintAi("checking");
  const res = await chrome.runtime.sendMessage({ action: "aiSaveKey", provider, key });
  if (!res?.success) {
    paintAi("bad", res?.error || "Could not save the key.");
    return;
  }
  // Clear the field at once — nothing needs it in the page after this.
  aiKeyInput.value = "";
  setAiKeyMasked(true);
  aiSaved = { hasKey: true, provider, verified: false, hint: `…${key.slice(-4)}` };
  aiReplacing = false;
  await runAiVerify();
}

async function aiRemove() {
  await chrome.runtime.sendMessage({ action: "aiSaveKey", provider: aiProvider, key: "" });
  aiSaved = { hasKey: false, provider: aiProvider, verified: false, hint: "" };
  aiReplacing = false;
  aiKeyInput.value = "";
  setAiKeyMasked(true);
  paintAi("none");
}

aiKeySave.addEventListener("click", aiVerifyClicked);
aiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    aiVerifyClicked();
  }
});

// A key belongs to one provider: switching clears a complaint about the last.
function pickAiProvider(id) {
  if (id === aiProvider) return;
  setAiProvider(id);
  paintAi(aiCard.dataset.state === "bad" ? "none" : aiCard.dataset.state);
}

aiProviderGroup.addEventListener("click", (e) => {
  const b = e.target.closest(".ai-prov");
  if (!b || b.disabled) return;
  pickAiProvider(b.dataset.provider);
  aiKeyInput.focus();
});

// A radio group: arrow keys move the choice and the focus with it.
aiProviderGroup.addEventListener("keydown", (e) => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const ids = Object.keys(AI_PROVIDER_META);
  const next = ids[(ids.indexOf(aiProvider) + step + ids.length) % ids.length];
  pickAiProvider(next);
  aiProviderGroup.querySelector(`[data-provider="${next}"]`).focus();
});

aiKeyReveal.addEventListener("click", () => {
  setAiKeyMasked(aiKeyInput.type !== "password");
  aiKeyInput.focus();
});

aiKeyReplace.addEventListener("click", () => {
  aiReplacing = true;
  paintAi("none");
  aiKeyInput.focus();
});

aiKeyCancel.addEventListener("click", () => {
  aiReplacing = false;
  aiKeyInput.value = "";
  setAiKeyMasked(true);
  setAiProvider(aiSaved.provider);
  paintAi("ok");
});

aiKeyClear.addEventListener("click", aiRemove);
aiKeyDrop.addEventListener("click", aiRemove);

setAiProvider(aiProvider);


// ===================== API HELPER =====================
async function apiCall(endpoint, method = "GET", body = null, headers = null, contentType = null) {
  return chrome.runtime.sendMessage({
    action: "apiCall",
    domain: state.domain,
    sessionId: state.sessionId,
    version: state.apiVersion,
    endpoint,
    method,
    body,
    headers,
    contentType,
  });
}

// ---- API version ------------------------------------------------------------
// The newest version this extension has been checked against (Veeva's VQL and
// API reference at v26.2). A vault on a later release is still called at this
// one; an older vault at the newest it lists. v24.1 is the floor and the
// fallback: TOLABEL() needs it.
const API_VERSION_MAX = "v26.2";
const API_VERSION_FLOOR = "v24.1";

function versionParts(v) {
  const m = /^v?(\d+)\.(\d+)$/.exec(String(v || ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return 0;
  return x[0] - y[0] || x[1] - y[1];
}

// Whether the vault is being called at `v` or later — what gates SHOW, TRIM(),
// the attachment functions and the rest by version.
function apiAtLeast(v) {
  return compareVersions(state.apiVersion || API_VERSION_FLOOR, v) >= 0;
}

// GET /api/ lists every version the vault answers to — the last one may be
// the next release's beta, which API_VERSION_MAX keeps us below as long as it
// tracks the current general release. Pick the newest one not past it;
// anything unexpected keeps the floor.
async function detectApiVersion() {
  state.apiVersion = API_VERSION_FLOOR;
  const res = await apiCall("/api/");
  const listed = Object.keys(res?.data?.values || {}).filter((v) => versionParts(v));
  const usable = listed
    .filter((v) => compareVersions(v, API_VERSION_MAX) <= 0 && compareVersions(v, API_VERSION_FLOOR) >= 0)
    .sort(compareVersions);
  if (usable.length) state.apiVersion = usable[usable.length - 1];
  return state.apiVersion;
}

// ===================== DATA TYPES TAB =====================
const DATA_TYPE_CATEGORIES = [
  { key: "documents", label: "Documents", match: (o) => o.name === "documents" || /document/i.test(o.name) },
  { key: "users",     label: "Users",     match: (o) => /user/i.test(o.name) },
  { key: "products",  label: "Products",  match: (o) => /product/i.test(o.name) },
];

function renderDataTypes() {
  const empty = document.getElementById("datatypes-empty");
  const container = document.getElementById("datatypes-sections");
  if (!container || !empty) return;

  if (!state.dataModel || !state.dataModel.objects) {
    empty.style.display = "";
    container.innerHTML = "";
    empty.textContent = state.sessionId
      ? "Load the data model first (Data Model tab) to browse data types."
      : "Connect to a Vault first.";
    return;
  }
  empty.style.display = "none";

  // Avoid re-rendering if already built; just refresh contents.
  if (container.dataset.built === "1") return;
  container.dataset.built = "1";

  container.innerHTML = DATA_TYPE_CATEGORIES.map((cat) => `
    <div class="dt-cat" data-cat="${cat.key}">
      <div class="dt-cat-header">
        <span class="dt-cat-arrow">&#9654;</span>
        <span class="dt-cat-label">${esc(cat.label)}</span>
        <span class="dt-cat-count" id="dt-cat-count-${cat.key}"></span>
      </div>
      <div class="dt-cat-body">
        <input type="text" class="dt-cat-search" placeholder="Search ${esc(cat.label.toLowerCase())} by label..." data-cat="${cat.key}" />
        <div class="dt-cat-list" id="dt-cat-list-${cat.key}"></div>
      </div>
    </div>
  `).join("");

  // Wire collapse + search
  container.querySelectorAll(".dt-cat").forEach((catEl) => {
    const key = catEl.dataset.cat;
    const header = catEl.querySelector(".dt-cat-header");
    header.addEventListener("click", () => {
      catEl.classList.toggle("open");
    });
    const search = catEl.querySelector(".dt-cat-search");
    search.addEventListener("click", (e) => e.stopPropagation());
    search.addEventListener("input", () => renderDataTypeCategory(key, search.value));
  });

  // Initial render of all three lists
  DATA_TYPE_CATEGORIES.forEach((cat) => renderDataTypeCategory(cat.key, ""));
}

function renderDataTypeCategory(key, filter) {
  const cat = DATA_TYPE_CATEGORIES.find((c) => c.key === key);
  if (!cat) return;
  const listEl = document.getElementById(`dt-cat-list-${key}`);
  const countEl = document.getElementById(`dt-cat-count-${key}`);
  if (!listEl || !state.dataModel) return;

  const objs = state.dataModel.objects.filter(cat.match);
  const f = (filter || "").trim().toLowerCase();

  // For each matching object, filter its fields by label (or name) when searching.
  const visible = objs.map((o) => {
    if (!f) return { obj: o, fields: o.fields, hidden: false };
    const objMatches = (o.label || "").toLowerCase().includes(f) || o.name.toLowerCase().includes(f);
    const fields = o.fields.filter(
      (fl) => (fl.label || "").toLowerCase().includes(f) || fl.name.toLowerCase().includes(f)
    );
    return { obj: o, fields, hidden: !objMatches && fields.length === 0 };
  }).filter((x) => !x.hidden);

  countEl.textContent = `${visible.length} / ${objs.length}`;

  if (visible.length === 0) {
    listEl.innerHTML = `<div class="dm-empty">No matches.</div>`;
    return;
  }

  listEl.innerHTML = visible.map(({ obj, fields }) => `
    <div class="dt-obj">
      <div class="dt-obj-header">
        <span class="dt-obj-arrow">&#9654;</span>
        <span class="dt-obj-label">${esc(obj.label || obj.name)}</span>
        <span class="dt-obj-name">${esc(obj.name)}</span>
        <span class="dt-obj-count">${fields.length}</span>
      </div>
      <div class="dt-obj-fields">
        ${fields.map((fl) => `
          <div class="dt-obj-field">
            <span class="dt-obj-field-label">${esc(fl.label || fl.name)}</span>
            <span class="dt-obj-field-name">${esc(fl.name)}</span>
            <span class="dt-obj-field-type">${esc(fl.type || "")}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `).join("");

  listEl.querySelectorAll(".dt-obj-header").forEach((h) => {
    h.addEventListener("click", () => h.parentElement.classList.toggle("open"));
  });
}

// Re-render data types whenever the data model changes (loaded/cleared/switched).
const _origOnDataModelLoaded = onDataModelLoaded;
onDataModelLoaded = function (timeStr) {
  _origOnDataModelLoaded(timeStr);
  const container = document.getElementById("datatypes-sections");
  if (container) container.dataset.built = "";
  // If the Data Types tab is currently active, refresh it now.
  const dtTab = document.querySelector('#tab-datatypes.active');
  if (dtTab) renderDataTypes();
};

// ===================== FULL-WINDOW WORKBENCH =====================
// popup.html?mode=window is laid out as a workbench: the data model down the
// left, a tabbed editor over a paged results table in the middle, and an
// inspector for the selected row on the right. Everything below is either
// window-only or a no-op in the overlay, whose layout is unchanged.

const queryTabsEl = $("#query-tabs");
const formatBtn = $("#format-btn");
const limitSelect = $("#limit-select");
const resultsFilter = $("#results-filter");
const columnsBtn = $("#columns-btn");
const columnsMenu = $("#columns-menu");
const resultsRange = $("#results-range");
const resultsHint = $("#results-hint");
const pagePrev = $("#page-prev");
const pageNext = $("#page-next");
const inspEmpty = $("#insp-empty");
const inspBody = $("#insp-body");
const inspTitle = $("#insp-title");
const inspFields = $("#insp-fields");
const inspOpen = $("#insp-open");
const inspCopy = $("#insp-copy");
const recentList = $("#recent-list");
const inspClose = $("#insp-close");
const railHistory = $("#rail-history");
const splitHandle = $("#split-handle");

// The explorer beside the rail: "model", "history", or null when closed.
let explorerPanel = "model";
// The editor height the split was dragged to, or null to fit the query.
let editorHeight = null;

// Called once, from init, in window mode only.
function initWorkbench(saved) {
  const stored = saved.queryTabs;
  const seen = new Set();
  const tabs = (Array.isArray(stored?.tabs) ? stored.tabs : [])
    .filter((t) => t && typeof t.id === "string" && !seen.has(t.id) && seen.add(t.id))
    .map((t) => ({
      id: t.id,
      title: typeof t.title === "string" && t.title.trim() ? t.title.trim().slice(0, 60) : null,
      query: typeof t.query === "string" ? t.query : "",
    }));
  queryTabs = tabs.length ? tabs : [blankTab()];
  activeTabId = queryTabs.some((t) => t.id === stored?.active) ? stored.active : queryTabs[0].id;
  vqlInput.value = activeTab().query;

  // "All" unless the user has picked a cap: the editor has always fetched every
  // page, and a silent 100-row default would read as missing data.
  const limits = [...limitSelect.options].map((o) => o.value);
  limitSelect.value = limits.includes(saved.queryLimit) ? saved.queryLimit : "";

  // The load chips live in the status bar here.
  dmEmptyState.innerHTML =
    '<div class="dm-empty-title">No data model yet</div>' +
    "<p>Load it once per vault to browse objects and fields here and get autocomplete in the editor.</p>" +
    '<button type="button" class="dm-empty-load">Load data model</button>';
  dtEmpty.innerHTML = "Use <strong>LOAD TYPES</strong> in the status bar below.";

  setExplorer(saved.explorerPanel === "history" ? "history" : saved.explorerPanel === "none" ? null : "model", false);
  const h = Number(saved.editorHeight);
  editorHeight = Number.isFinite(h) && h > 0 ? h : null;

  wireWorkbench();
  paintEditor();
  renderQueryTabs();
  resetResultsView();
  renderRecent();
  // Relative times ("5 min ago") go stale while the tab sits open.
  setInterval(renderRecent, 60 * 1000);
}

function wireWorkbench() {
  vqlInput.addEventListener("scroll", syncEditorScroll);
  window.addEventListener("resize", fitEditor);

  formatBtn.addEventListener("click", formatEditor);
  limitSelect.addEventListener("change", () => {
    chrome.storage.local.set({ queryLimit: limitSelect.value });
  });

  queryTabsEl.addEventListener("click", (e) => {
    if (e.target.closest(".qtab-rename")) return;
    if (e.target.closest(".qtab-new")) return newQueryTab();
    const close = e.target.closest("[data-close]");
    if (close) return closeQueryTab(close.dataset.close);
    const tab = e.target.closest(".qtab");
    if (tab) switchQueryTab(tab.dataset.tabId);
  });
  queryTabsEl.addEventListener("dblclick", (e) => {
    const tab = e.target.closest(".qtab");
    if (tab && !e.target.closest("[data-close], .qtab-rename")) renameQueryTab(tab.dataset.tabId);
  });
  // Middle-click closes, as it does for browser tabs.
  queryTabsEl.addEventListener("auxclick", (e) => {
    const tab = e.target.closest(".qtab");
    if (e.button === 1 && tab) closeQueryTab(tab.dataset.tabId);
  });
  queryTabsEl.addEventListener("keydown", (e) => {
    const tab = e.target.closest(".qtab");
    if (!tab || e.target.closest(".qtab-rename")) return;
    if (e.key === "F2" || e.key === "Enter") {
      e.preventDefault();
      renameQueryTab(tab.dataset.tabId);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const i = queryTabs.findIndex((t) => t.id === activeTabId);
      const next = queryTabs[i + (e.key === "ArrowLeft" ? -1 : 1)];
      if (!next) return;
      switchQueryTab(next.id);
      queryTabsEl.querySelector(".qtab.active")?.focus();
    }
  });

  resultsFilter.addEventListener("input", () => {
    if (!resultsView.active) return;
    resultsView.filter = resultsFilter.value;
    resultsView.page = 0;
    paintResultsView();
    resultsContainer.scrollTop = 0;
  });
  pagePrev.addEventListener("click", () => turnResultsPage(-1));
  pageNext.addEventListener("click", () => turnResultsPage(1));

  columnsBtn.addEventListener("click", () => {
    if (!columnsMenu.classList.contains("hidden")) return closeColumnsMenu();
    renderColumnsMenu();
    columnsMenu.classList.remove("hidden");
    columnsBtn.setAttribute("aria-expanded", "true");
  });
  columnsMenu.addEventListener("change", (e) => {
    const box = e.target.closest("input[data-col]");
    if (!box) return;
    if (box.checked) resultsView.hidden.delete(box.dataset.col);
    else resultsView.hidden.add(box.dataset.col);
    columnsMenu.querySelector(".columns-all").disabled = !resultsView.hidden.size;
    paintColumnsButton();
    paintResultsView();
  });
  columnsMenu.addEventListener("click", (e) => {
    if (!e.target.closest(".columns-all")) return;
    resultsView.hidden.clear();
    paintColumnsButton();
    paintResultsView();
    renderColumnsMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".columns-wrap")) closeColumnsMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeColumnsMenu();
  });

  inspCopy.addEventListener("click", async () => {
    const row = queryRows[resultsView.selected];
    if (!row) return;
    await navigator.clipboard.writeText(JSON.stringify(row, null, 2));
    inspCopy.textContent = "Copied";
    setTimeout(() => (inspCopy.textContent = "Copy JSON"), 1200);
  });

  recentList.addEventListener("click", (e) => {
    const item = e.target.closest(".recent-item");
    if (item) loadHistoryQuery(parseInt(item.dataset.index));
  });

  railHistory.addEventListener("click", () => toggleExplorer("history"));
  $("#eh-clear").addEventListener("click", () => clearHistoryBtn.click());

  inspClose.addEventListener("click", closeInspector);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !vqlPanel.classList.contains("row-open")) return;
    if (e.target.closest?.("input, textarea, select")) return;
    closeInspector();
  });

  wireSplit();

  dmEmptyState.addEventListener("click", (e) => {
    if (e.target.closest(".dm-empty-load")) modelChip.click();
  });

  // "/" jumps to the data model search from anywhere that isn't a text field.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    if (vqlPanel.classList.contains("hidden") || dmPanel.classList.contains("hidden")) return;
    e.preventDefault();
    if (explorerPanel !== "model") setExplorer("model");
    dmSearch.focus();
    dmSearch.select();
  });

  // Flush a debounced save if the tab closes mid-typing.
  window.addEventListener("pagehide", persistTabs);
}

// ---- Explorer: the data model or the history, beside the rail ---------------
function setExplorer(panel, save = true) {
  explorerPanel = panel;
  document.body.dataset.explorer = panel || "none";
  const modelBtn = $('.tab[data-tab="datamodel"]');
  modelBtn.classList.toggle("on", panel === "model");
  modelBtn.setAttribute("aria-pressed", String(panel === "model"));
  railHistory.classList.toggle("on", panel === "history");
  railHistory.setAttribute("aria-pressed", String(panel === "history"));
  if (save) chrome.storage.local.set({ explorerPanel: panel || "none" });
  if (panel === "model") syncDmToQuery();
}

// A second click on the open panel's button closes it.
function toggleExplorer(panel) {
  setExplorer(explorerPanel === panel ? null : panel);
}

// ---- Row drawer ----------------------------------------------------------
function closeInspector() {
  resultsView.selected = null;
  resultsContainer.querySelector("tbody tr.selected")?.classList.remove("selected");
  renderInspector();
}

// ---- Split: editor over results ---------------------------------------------
// At least three lines of editor, and room left for a results header and a
// few rows under it.
function clampEditorHeight(h) {
  return Math.round(Math.max(66, Math.min(h, window.innerHeight - 260)));
}

function setEditorHeight(h) {
  editorHeight = h == null ? null : clampEditorHeight(h);
  fitEditor();
  syncEditorScroll();
}

function saveEditorHeight() {
  if (editorHeight) chrome.storage.local.set({ editorHeight });
  else chrome.storage.local.remove("editorHeight");
}

function wireSplit() {
  splitHandle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = vqlInput.offsetHeight;
    splitHandle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev) => setEditorHeight(startH + ev.clientY - startY);
    const done = () => {
      splitHandle.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
      saveEditorHeight();
    };
    splitHandle.addEventListener("pointermove", move);
    splitHandle.addEventListener("pointerup", done, { once: true });
    splitHandle.addEventListener("pointercancel", done, { once: true });
  });
  // Double-click hands the height back to the query.
  splitHandle.addEventListener("dblclick", () => {
    setEditorHeight(null);
    saveEditorHeight();
  });
  splitHandle.addEventListener("keydown", (e) => {
    const step = { ArrowUp: -22, ArrowDown: 22 }[e.key];
    if (!step) return;
    e.preventDefault();
    setEditorHeight((editorHeight || vqlInput.offsetHeight) + step);
    saveEditorHeight();
  });
}

// ---- Editor: highlighting and line numbers --------------------------------
const VQL_KEYWORD_SET = new Set([
  ...VQL_KEYWORDS.flatMap((k) => k.split(" ")),
  "IS", "BY", "AS", "PAGESIZE", "PAGEOFFSET", "ESCAPE",
]);

// Every character lands in exactly one token, so joining the tokens gives back
// the input — the highlight layer has to line up with the textarea glyph for
// glyph. Literals come first so a keyword inside quotes stays a literal, and an
// unterminated one runs to the end rather than flipping colours as you type.
const VQL_TOKEN_RE = /'(?:[^'\\]|\\.)*'?|\s+|[A-Za-z_][\w.]*|\d+(?:\.\d+)?|[^\sA-Za-z_'\d]/g;

const isVqlKeyword = (tok) => /^[A-Za-z_]+$/.test(tok) && VQL_KEYWORD_SET.has(tok.toUpperCase());

// Whether a word sits where the query target goes — after FROM, or after
// FROM's ALLVERSIONS / RECENT / FAVORITES. `relationships` is a target there,
// and target names are case-sensitive, so it mustn't be coloured or
// upper-cased as the RELATIONSHIPS of SHOW.
function vqlTargetSlot(prev, prev2, tok) {
  if (/^from$/i.test(prev)) return !VQL_TARGET_OPTION_RE.test(tok);
  return /^from$/i.test(prev2) && VQL_TARGET_OPTION_RE.test(prev);
}

function highlightVql(text) {
  let html = "";
  let prev = "";
  let prev2 = "";
  for (const tok of text.match(VQL_TOKEN_RE) || []) {
    if (tok[0] === "'") html += `<span class="hl-str">${esc(tok)}</span>`;
    else if (isVqlKeyword(tok) && !vqlTargetSlot(prev, prev2, tok)) html += `<span class="hl-kw">${esc(tok)}</span>`;
    else html += esc(tok);
    if (!/^\s/.test(tok)) {
      prev2 = prev;
      prev = tok;
    }
  }
  return html;
}

// Called after anything rewrites the editor — typing, inserts, history, tab
// switches — to repaint the layers and keep the tab's copy current.
function editorChanged() {
  if (!WINDOW_MODE) return;
  paintEditor();
  if (explorerPanel === "model") syncDmToQuery();
  const tab = activeTab();
  if (tab && tab.query !== vqlInput.value) {
    const before = tabLabel(tab);
    tab.query = vqlInput.value;
    // Untitled tabs follow the FROM clause; skip the rebuild when they don't move.
    if (tabLabel(tab) !== before) renderQueryTabs();
    persistTabsSoon();
  }
}

function paintEditor() {
  const text = vqlInput.value;
  // A <pre> gives a trailing newline no line of its own, so the caret's last
  // line would have nothing under it.
  editorHl.innerHTML = highlightVql(text) + (text.endsWith("\n") ? " " : "");
  const lines = text.split("\n").length;
  editorGutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  fitEditor();
  syncEditorScroll();
}

// Grows with the query up to a share of the window, then scrolls; the results
// card takes whatever height is left.
function fitEditor() {
  if (!WINDOW_MODE) return;
  // Dragged by the split: that height, whatever the query's length.
  if (editorHeight) {
    vqlInput.style.height = `${clampEditorHeight(editorHeight)}px`;
    return;
  }
  const max = Math.max(220, Math.round(window.innerHeight * 0.45));
  vqlInput.style.height = "auto";
  // offsetHeight - clientHeight is the horizontal scrollbar when a line runs
  // long; without it the last line hides under the bar.
  const want = vqlInput.scrollHeight + (vqlInput.offsetHeight - vqlInput.clientHeight);
  vqlInput.style.height = `${Math.min(want, max)}px`;
}

function syncEditorScroll() {
  editorHl.scrollTop = vqlInput.scrollTop;
  editorHl.scrollLeft = vqlInput.scrollLeft;
  editorGutter.scrollTop = vqlInput.scrollTop;
}

// ---- Format ---------------------------------------------------------------
const VQL_BREAK_BEFORE = new Set([
  "FROM", "WHERE", "FIND", "HAVING", "LIMIT", "OFFSET", "PAGESIZE", "PAGEOFFSET", "MAXROWS", "SKIP",
]);

// One clause per line, AND/OR indented under WHERE, keywords upper-cased, a
// long SELECT list wrapped under its first field. Only the top level is
// touched: a subquery in the SELECT list stays on its line.
function formatVql(src) {
  const toks = src.trim().match(VQL_TOKEN_RE) || [];
  const nextWord = (i) => {
    for (let j = i + 1; j < toks.length; j++) if (!/^\s/.test(toks[j])) return toks[j].toUpperCase();
    return "";
  };
  const lineLength = (s) => s.length - s.lastIndexOf("\n") - 1;

  let out = "";
  let depth = 0;
  let inSelect = false;
  let inBetween = false;
  let prev = "";
  let prev2 = "";
  for (let i = 0; i < toks.length; i++) {
    let t = toks[i];
    if (/^\s/.test(t)) {
      if (out && !/[ \n]$/.test(out)) out += " ";
      continue;
    }
    const slot = vqlTargetSlot(prev, prev2, t);
    prev2 = prev;
    prev = t;
    if (t === ",") {
      out = `${out.replace(/ $/, "")}, `;
      continue;
    }
    if (t === "(") depth++;
    else if (t === ")") depth = Math.max(0, depth - 1);
    else if (isVqlKeyword(t) && !slot) {
      const up = t.toUpperCase();
      t = up;
      if (depth === 0 && out) {
        const clause = VQL_BREAK_BEFORE.has(up) || ((up === "ORDER" || up === "GROUP") && nextWord(i) === "BY");
        // The AND inside BETWEEN … AND … is part of one condition.
        const joiner = (up === "AND" && !inBetween) || up === "OR";
        if (clause) out = `${out.replace(/ $/, "")}\n`;
        else if (joiner) out = `${out.replace(/ $/, "")}\n  `;
      }
      if (depth === 0) {
        if (up === "SELECT") inSelect = true;
        if (up === "FROM") inSelect = false;
        if (up === "BETWEEN") inBetween = true;
        else if (up === "AND") inBetween = false;
      }
    }
    if (inSelect && depth === 0 && out.endsWith(", ") && lineLength(out) + t.length > 78) {
      out = `${out.slice(0, -1)}\n       `;
    }
    out += t;
  }
  return out;
}

function formatEditor() {
  const src = vqlInput.value;
  if (!src.trim()) return;
  const formatted = formatVql(src);
  if (formatted === src) return;
  // Through execCommand rather than .value so Ctrl+Z can take the format back.
  vqlInput.focus();
  vqlInput.select();
  if (!document.execCommand("insertText", false, formatted)) vqlInput.value = formatted;
  hideAc();
  historyNavIndex = -1;
  editorChanged();
}

// ---- Select-list helpers (shift-click a field, Names/Labels) ----------------
// The span of the top-level SELECT list: from after SELECT up to its FROM,
// skipping anything inside parentheses or quotes.
function vqlSelectListSpan(q) {
  const re = new RegExp(VQL_TOKEN_RE.source, "g");
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(q))) {
    const t = m[0];
    if (t === "(") depth++;
    else if (t === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /^select$/i.test(t) && start === -1) start = m.index + t.length;
    else if (depth === 0 && /^from$/i.test(t) && start !== -1) return { start, end: m.index };
  }
  return null;
}

// The items of that list split at its top-level commas, each with where it
// starts in the query, so a caller can rewrite one in place.
function vqlListItems(q, span) {
  const re = new RegExp(VQL_TOKEN_RE.source, "g");
  const list = q.slice(span.start, span.end);
  const items = [];
  let depth = 0;
  let from = 0;
  let m;
  while ((m = re.exec(list))) {
    const t = m[0];
    if (t === "(") depth++;
    else if (t === ")") depth = Math.max(0, depth - 1);
    else if (t === "," && depth === 0) {
      items.push({ start: span.start + from, text: list.slice(from, m.index) });
      from = m.index + 1;
    }
  }
  items.push({ start: span.start + from, text: list.slice(from) });
  return items;
}

// ---- Query structure ----------------------------------------------------------
// One pass that says what a query targets, which relationships it walks and
// where its subqueries are. Autocomplete, inline editing, SHOW, the record
// properties request and the relationship-limit message all read it; none of
// them needs a full parser, only to know what sits at the top level.
// What can sit between FROM and the target. LATESTVERSION goes in the SELECT
// list (SELECT LATESTVERSION … FROM ALLVERSIONS documents), not here.
const VQL_TARGET_OPTION_RE = /^(ALLVERSIONS|RECENT|FAVORITES)$/i;
const VQL_RELATIONSHIP_RE = /__[a-z]*r$/i;   // product__vr, approved_countries__cr, binder__sysr
// Clause words that can follow FROM while the target is still being typed.
const VQL_NOT_TARGET_RE = /^(WHERE|FIND|ORDER|MAXROWS|SKIP|PAGESIZE|PAGEOFFSET|LIMIT|OFFSET|AS|AND|OR|SELECT|FROM)$/i;

// Non-space tokens with their offset and paren depth. A paren carries the depth
// outside it, so a subquery's own tokens are one deeper than its parens.
function vqlTokens(q) {
  const re = new RegExp(VQL_TOKEN_RE.source, "g");
  const out = [];
  let depth = 0;
  let m;
  while ((m = re.exec(q))) {
    const t = m[0];
    if (t === ")") depth = Math.max(0, depth - 1);
    if (!/^\s/.test(t)) out.push({ t, at: m.index, end: m.index + t.length, depth });
    if (t === "(") depth++;
  }
  return out;
}

function vqlShape(q) {
  const toks = vqlTokens(q || "");
  const shape = {
    show: null,          // TARGETS | FIELDS | RELATIONSHIPS
    target: null,        // the top-level FROM target, lower case
    option: null,        // ALLVERSIONS | LATESTVERSION | RECENT | FAVORITES
    targetEnd: -1,       // offset just past the target word
    fromAt: -1,
    subqueries: [],      // { start, end, rel, inSelect }
    lookups: new Set(),  // relationship names used as rel.field
    nested: false,       // a subquery inside a subquery
    select: [],          // top-level SELECT items, trimmed and lower case
  };
  const up = (i) => (toks[i]?.t || "").toUpperCase();
  if (up(0) === "SHOW") {
    shape.show = up(1) || null;
    const f = toks.findIndex((x) => /^from$/i.test(x.t));
    if (f >= 0 && toks[f + 1]) {
      shape.target = toks[f + 1].t.toLowerCase();
      shape.targetEnd = toks[f + 1].end;
    }
    return shape;
  }

  for (let i = 0; i < toks.length; i++) {
    if (toks[i].depth !== 0 || !/^from$/i.test(toks[i].t)) continue;
    shape.fromAt = toks[i].at;
    let j = i + 1;
    if (VQL_TARGET_OPTION_RE.test(toks[j]?.t || "")) {
      shape.option = toks[j].t.toUpperCase();
      j++;
    }
    if (/^[A-Za-z_]\w*$/.test(toks[j]?.t || "") && !VQL_NOT_TARGET_RE.test(toks[j].t)) {
      shape.target = toks[j].t.toLowerCase();
      shape.targetEnd = toks[j].end;
    } else if (shape.option) {
      shape.targetEnd = toks[j - 1].end;
    }
    break;
  }

  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t !== "(" || !/^select$/i.test(toks[i + 1]?.t || "")) continue;
    const d = toks[i].depth;
    const sub = { start: toks[i].at, end: q.length, rel: null, inSelect: shape.fromAt < 0 || toks[i].at < shape.fromAt };
    for (let j = i + 2; j < toks.length; j++) {
      const x = toks[j];
      if (x.t === ")" && x.depth === d) {
        sub.end = x.at;
        break;
      }
      if (x.depth === d + 1 && /^from$/i.test(x.t) && !sub.rel && toks[j + 1]) sub.rel = toks[j + 1].t.toLowerCase();
    }
    shape.subqueries.push(sub);
  }
  // Grouping parens in a WHERE are fine; only a subquery inside a subquery isn't.
  shape.nested = shape.subqueries.some((s) =>
    shape.subqueries.some((o) => o !== s && o.start < s.start && s.start < o.end)
  );

  for (const x of toks) {
    const m = /^([A-Za-z_]\w*)\.[A-Za-z_]/.exec(x.t);
    if (m && VQL_RELATIONSHIP_RE.test(m[1])) shape.lookups.add(m[1].toLowerCase());
  }

  const span = vqlSelectListSpan(q || "");
  if (span) shape.select = vqlListItems(q, span).map((it) => it.text.trim().toLowerCase()).filter(Boolean);
  return shape;
}

// documents and archived_documents take the document-only VQL (ALLVERSIONS,
// ORDER BY RANK, the state functions).
function isDocumentsTarget(t) {
  return t === "documents" || t === "archived_documents";
}

// Every relationship a query walks, counted once each, the way VQL's limit of
// ten counts them: subqueries and lookups alike.
function vqlRelationships(shape) {
  const names = new Set(shape.lookups);
  for (const s of shape.subqueries) if (s.rel) names.add(s.rel);
  return names;
}

// The innermost subquery the offset sits in, if any.
function vqlSubqueryAt(shape, pos) {
  let best = null;
  for (const s of shape.subqueries) {
    if (s.start < pos && pos <= s.end && (!best || s.start > best.start)) best = s;
  }
  return best;
}

// What a failed query is likely to have run into, in words, from the shape of
// what was sent; Vault's own message comes first and this is appended.
function vqlLimitAdvice(q) {
  const shape = vqlShape(q);
  const notes = [];
  if (shape.show && !apiAtLeast("v25.2")) {
    notes.push(`SHOW needs Vault API v25.2 or later. Vault Dweller is using ${state.apiVersion || API_VERSION_FLOOR} with this vault.`);
  }
  const rels = vqlRelationships(shape);
  if (rels.size > 10) {
    notes.push(`This query uses ${rels.size} relationships; VQL allows 10. Each subquery and each lookup (rel.field) counts once.`);
  }
  if (shape.nested) notes.push("VQL allows one level of subquery: a subquery can't contain another.");
  if (shape.option === "ALLVERSIONS" && shape.target && !isDocumentsTarget(shape.target)) {
    notes.push("ALLVERSIONS works only on documents.");
  }
  // RECENT and FAVORITES can't be used inside a subquery.
  const inner = /\(\s*SELECT\b[^()]*\bFROM\s+(RECENT|FAVORITES)\b/i.exec(q);
  if (inner) notes.push(`${inner[1].toUpperCase()} can't be used inside a subquery or with ALLVERSIONS.`);
  if (vqlOrderBy(q)?.rank && shape.target && !isDocumentsTarget(shape.target)) {
    notes.push("ORDER BY RANK only works on documents; object FIND results are already ranked.");
  }
  return notes.length ? `\n\nLikely cause:\n${notes.join("\n")}` : "";
}

// ---- Limit ----------------------------------------------------------------
function uiRowLimit() {
  if (!WINDOW_MODE) return null;
  const n = Number(limitSelect.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---- Query tabs -------------------------------------------------------------
// Tabs keep their queries in storage; results live in memory only, since a
// result set can run to thousands of rows.
let queryTabs = [];
let activeTabId = null;
let renamingTabId = null;
let persistTabsTimer = null;
const tabResults = new Map();

const blankTab = () => ({
  id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  title: null,
  query: "",
});

function activeTab() {
  return queryTabs.find((t) => t.id === activeTabId) || null;
}

// An untitled tab is named after the object it queries — its label when the
// model is loaded, the API name otherwise.
function derivedTabLabel(t) {
  const m = (t.query || "").match(/\bFROM\s+(\w+)/i);
  if (!m) return "New query";
  const obj = state.dataModel?.objects.find((o) => o.name.toLowerCase() === m[1].toLowerCase());
  return obj?.label || m[1];
}

function tabLabel(t) {
  return t.title || derivedTabLabel(t);
}

function persistTabs() {
  clearTimeout(persistTabsTimer);
  if (!queryTabs.length) return;
  chrome.storage.local.set({
    queryTabs: {
      active: activeTabId,
      tabs: queryTabs.map(({ id, title, query }) => ({ id, title, query })),
    },
  });
}

function persistTabsSoon() {
  clearTimeout(persistTabsTimer);
  persistTabsTimer = setTimeout(persistTabs, 400);
}

function renderQueryTabs() {
  if (!WINDOW_MODE || renamingTabId) return;
  let html = "";
  for (const t of queryTabs) {
    const on = t.id === activeTabId;
    const label = tabLabel(t);
    const preview = t.query.trim() ? t.query.trim().slice(0, 300) : "Empty query";
    const tip = on ? `${preview}\n\nDouble-click to rename` : preview;
    html +=
      `<div class="qtab${on ? " active" : ""}" role="tab" tabindex="${on ? 0 : -1}" ` +
      `aria-selected="${on}" data-tab-id="${esc(t.id)}" title="${esc(tip)}">` +
      `<span class="qtab-label">${esc(label)}</span>` +
      (on
        ? `<button type="button" class="qtab-close" data-close="${esc(t.id)}" title="Close tab" aria-label="Close ${esc(label)}">&times;</button>`
        : "") +
      "</div>";
  }
  html += '<button type="button" class="qtab-new" title="New query tab" aria-label="New query tab">+</button>';
  queryTabsEl.innerHTML = html;
}

// Results land in whatever tab is showing when they arrive, so the tabs hold
// still while a query runs.
function setQueryBusy(on) {
  if (!WINDOW_MODE) return;
  queryTabsEl.classList.toggle("busy", on);
}

function stashActiveTab() {
  const t = activeTab();
  if (!t) return;
  t.query = vqlInput.value;
  tabResults.set(t.id, snapshotResults());
}

function loadActiveTab() {
  const t = activeTab();
  vqlInput.value = t ? t.query : "";
  historyNavIndex = -1;
  hideAc();
  paintEditor();
  vqlInput.scrollTop = 0;
  vqlInput.scrollLeft = 0;
  syncEditorScroll();
  restoreResults(tabResults.get(activeTabId));
  renderQueryTabs();
  renderRecent();
}

function switchQueryTab(id) {
  if (id === activeTabId || activeQueryToken || !queryTabs.some((t) => t.id === id)) return;
  stashActiveTab();
  activeTabId = id;
  loadActiveTab();
  persistTabs();
}

function newQueryTab() {
  if (activeQueryToken) return;
  stashActiveTab();
  const t = blankTab();
  queryTabs.push(t);
  activeTabId = t.id;
  loadActiveTab();
  persistTabs();
  vqlInput.focus();
  queryTabsEl.scrollLeft = queryTabsEl.scrollWidth;
}

function closeQueryTab(id) {
  const i = queryTabs.findIndex((t) => t.id === id);
  if (i === -1) return;
  const closingActive = id === activeTabId;
  if (closingActive && activeQueryToken) return;
  const edits = closingActive ? pendingEdits : tabResults.get(id)?.edits || {};
  const unsaved = Object.keys(edits).length;
  if (unsaved && !confirm(`Close this tab and discard ${unsaved} unsaved change${unsaved === 1 ? "" : "s"}?`)) return;

  queryTabs.splice(i, 1);
  tabResults.delete(id);
  // The strip never goes empty; closing the last tab leaves a fresh one.
  if (!queryTabs.length) queryTabs.push(blankTab());
  if (closingActive) {
    activeTabId = queryTabs[Math.min(i, queryTabs.length - 1)].id;
    loadActiveTab();
  } else {
    renderQueryTabs();
    renderRecent();
  }
  persistTabs();
}

function renameQueryTab(id) {
  const t = queryTabs.find((x) => x.id === id);
  const label = queryTabsEl.querySelector(`.qtab[data-tab-id="${CSS.escape(id)}"] .qtab-label`);
  if (!t || !label) return;
  renamingTabId = id;
  const input = document.createElement("input");
  input.className = "qtab-rename";
  input.value = tabLabel(t);
  input.maxLength = 60;
  input.size = Math.max(8, input.value.length);
  input.setAttribute("aria-label", "Tab name");
  label.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    renamingTabId = null;
    if (commit) {
      // Clearing the name, or leaving the one it already had, hands the tab
      // back to following its query.
      const v = input.value.trim();
      t.title = v && v !== derivedTabLabel(t) ? v : null;
      persistTabs();
    }
    renderQueryTabs();
    renderRecent();
  };
  input.addEventListener("input", () => (input.size = Math.max(8, input.value.length)));
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
}

// Everything the results area shows, so a tab comes back exactly as it was
// left: rows, unsaved edits, filter, page, hidden columns and selection.
function snapshotResults() {
  return {
    table: resultsView.active,
    message: resultsView.active ? "" : resultsContainer.innerHTML,
    rows: queryRows,
    keys: resultKeys,
    objectName: queryObjectName,
    data: lastResultData,
    edits: pendingEdits,
    view: resultsView,
    count: resultsCount.textContent,
    countTitle: resultsCount.title,
    shown: resultsPanel.classList.contains("has-results"),
    values: resultValues,
    ranQuery: lastRunQuery,
    meta: resultMeta,
  };
}

function restoreResults(s) {
  closeColumnsMenu();
  resultsPanel.querySelector(".save-error")?.remove();
  if (!s) {
    queryRows = [];
    resultKeys = [];
    queryObjectName = null;
    lastResultData = null;
    pendingEdits = {};
    resultValues = null;
    lastRunQuery = "";
    resultMeta = null;
    resultsContainer.innerHTML = "";
    resultsCount.textContent = "";
    resultsCount.title = "";
    setResultsShown(false);
    resetResultsView();
    updateSaveBar();
    return;
  }
  queryRows = s.rows;
  resultKeys = s.keys;
  queryObjectName = s.objectName;
  lastResultData = s.data;
  pendingEdits = s.edits;
  resultsView = s.view;
  resultValues = s.values;
  lastRunQuery = s.ranQuery;
  resultMeta = s.meta || null;
  resultsCount.textContent = s.count;
  resultsCount.title = s.countTitle;
  resultsFilter.value = resultsView.filter;
  setResultsShown(s.shown);
  paintColumnsButton();
  if (s.table) {
    paintResultsView();
  } else {
    resultsContainer.innerHTML = s.message;
    resultsPanel.classList.remove("has-table");
  }
  updateSaveBar();
  renderInspector();
}

// ---- Results view -----------------------------------------------------------
// The workbench pages the table instead of rendering every row: a fetch-all
// query can return tens of thousands, and the card has a fixed height anyway.
const RESULTS_PAGE = 100;

let resultKeys = [];
let resultsView = freshResultsView();

function freshResultsView() {
  return { active: false, filter: "", page: 0, hidden: new Set(), selected: null };
}

function resetResultsView() {
  resultsView = freshResultsView();
  if (!WINDOW_MODE) return;
  resultsFilter.value = "";
  resultsPanel.classList.remove("has-table");
  closeColumnsMenu();
  paintColumnsButton();
  renderInspector();
}

function displayValue(v) {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

// What the cell shows: an unsaved edit wins over what Vault returned.
function effectiveValue(ri, key) {
  const edit = pendingEdits[`${ri}:${key}`];
  return edit ? edit.newVal : displayValue(queryRows[ri]?.[key]);
}

function visibleRowIndices() {
  const f = resultsView.filter.trim().toLowerCase();
  const out = [];
  for (let ri = 0; ri < queryRows.length; ri++) {
    if (!f || resultKeys.some((k) => effectiveValue(ri, k).toLowerCase().includes(f))) out.push(ri);
  }
  return out;
}

const STATUS_COL_RE = /(^|_)(status|state)__[a-z]+$/i;
const NAME_COL_RE = /^(name|title|label)__[a-z]+$/i;

// Tone for a lifecycle value — a reading aid only; the value itself is always
// printed in the pill.
function statusTone(value) {
  const s = value.toLowerCase();
  if (/inactive|reject|cancel|withdrawn|expired|obsolete|retired|fail|error/.test(s)) return "bad";
  if (/approved|active|effective|released|available|complete|final|current|steady/.test(s)) return "ok";
  if (/draft|review|pending|progress|planned|open/.test(s)) return "warn";
  return "neutral";
}

// Inner HTML for a data cell. The overlay prints plain text; the workbench
// pills status values and sets names in the reading face.
function cellContent(key, value) {
  if (!WINDOW_MODE || value === "") return esc(value);
  if (STATUS_COL_RE.test(key)) return `<span class="cell-pill ${statusTone(value)}">${esc(value)}</span>`;
  if (NAME_COL_RE.test(key)) return `<span class="cell-text">${esc(value)}</span>`;
  return esc(value);
}

// Vault's own deep links (Vault Help: "Vault Document URLs" and "Viewing Object
// Records"): /ui/#doc_info/{id} for documents, /ui/#object/{object}/{id} for
// object records.
function recordUrl(row) {
  const id = displayValue(row?.id);
  if (!id || !state.domain || !queryObjectName) return "";
  const path = queryObjectName.toLowerCase() === "documents"
    ? `doc_info/${encodeURIComponent(id)}`
    : `object/${encodeURIComponent(queryObjectName)}/${encodeURIComponent(id)}`;
  return `https://${state.domain}/ui/#${path}`;
}

function paintResultsView() {
  if (!WINDOW_MODE) return;
  resultsView.active = true;
  const idx = visibleRowIndices();
  const pages = Math.max(1, Math.ceil(idx.length / RESULTS_PAGE));
  resultsView.page = Math.min(resultsView.page, pages - 1);
  const start = resultsView.page * RESULTS_PAGE;
  const slice = idx.slice(start, start + RESULTS_PAGE);
  const keys = resultKeys.filter((k) => !resultsView.hidden.has(k));
  const editable = getEditableFields(queryObjectName);
  const hasId = resultKeys.includes("id");

  let html = '<table class="results-table"><thead><tr><th class="row-num" scope="col">#</th>';
  for (const k of keys) {
    html += `<th scope="col"${k === "id" ? ' class="col-id"' : ""}${columnHeaderAttr(k)}>${esc(k)}</th>`;
  }
  html += "</tr></thead><tbody>";
  for (const ri of slice) {
    html += `<tr data-row="${ri}"${ri === resultsView.selected ? ' class="selected"' : ""}>`;
    html += `<td class="row-num">${ri + 1}</td>`;
    for (const k of keys) {
      const rawV = queryRows[ri]?.[k];
      if (isSubValue(rawV)) {
        html += subCellHtml(ri, k, rawV);
        continue;
      }
      const v = effectiveValue(ri, k);
      if (k === "id") {
        const url = recordUrl(queryRows[ri]);
        html += url
          ? `<td class="col-id"><a class="id-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Open in Vault">${esc(v)}</a></td>`
          : `<td class="col-id" title="${esc(v)}">${esc(v)}</td>`;
        continue;
      }
      const canEdit = hasId && cellEditable(ri, k, editable);
      const why = canEdit ? "" : cellLockReason(ri, k);
      const cls = canEdit ? `editable${pendingEdits[`${ri}:${k}`] ? " dirty" : ""}` : why ? "cell-locked" : "";
      html +=
        `<td${cls ? ` class="${cls}"` : ""}${canEdit ? ` data-row="${ri}" data-field="${esc(k)}"` : ""} ` +
        `title="${esc(cellTip(v, why))}">${cellContent(k, v)}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  if (!slice.length) {
    html = `<div class="result-message info">No rows match &ldquo;${esc(resultsView.filter.trim())}&rdquo;.</div>`;
  }
  resultsContainer.innerHTML = html;
  resultsPanel.classList.add("has-table");

  const total = queryRows.length;
  const shown = idx.length;
  const filtered = shown !== total ? ` (filtered from ${total.toLocaleString()})` : "";
  resultsRange.textContent = shown
    ? `Showing ${(start + 1).toLocaleString()}–${(start + slice.length).toLocaleString()} of ${shown.toLocaleString()}${filtered}`
    : `0 of ${total.toLocaleString()}`;
  resultsHint.textContent = hasId ? "Click a cell to edit it" : "Add id to the SELECT to edit cells";
  pagePrev.disabled = resultsView.page === 0;
  pageNext.disabled = resultsView.page >= pages - 1;
}

function turnResultsPage(step) {
  if (!resultsView.active) return;
  resultsView.page = Math.max(0, resultsView.page + step);
  paintResultsView();
  resultsContainer.scrollTop = 0;
}

function selectResultRow(ri) {
  if (!Number.isInteger(ri) || !queryRows[ri] || resultsView.selected === ri) return;
  resultsView.selected = ri;
  resultsContainer.querySelector("tbody tr.selected")?.classList.remove("selected");
  resultsContainer.querySelector(`tbody tr[data-row="${ri}"]`)?.classList.add("selected");
  renderInspector();
}

function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// ---- Columns menu -----------------------------------------------------------
// Hides columns from the table only; Copy and the exports keep every column.
function paintColumnsButton() {
  const n = resultsView.hidden.size;
  columnsBtn.textContent = n ? `Columns · ${n} hidden` : "Columns";
}

function renderColumnsMenu() {
  columnsMenu.innerHTML =
    '<div class="columns-head"><span>Show columns</span>' +
    `<button type="button" class="columns-all"${resultsView.hidden.size ? "" : " disabled"}>Show all</button></div>` +
    resultKeys
      .map(
        (k) =>
          `<label class="columns-opt"><input type="checkbox" data-col="${esc(k)}"` +
          `${resultsView.hidden.has(k) ? "" : " checked"} /><span>${esc(k)}</span></label>`
      )
      .join("");
}

function closeColumnsMenu() {
  if (!WINDOW_MODE) return;
  columnsMenu.classList.add("hidden");
  columnsBtn.setAttribute("aria-expanded", "false");
}

// ---- Inspector --------------------------------------------------------------
function rowTitle(ri) {
  for (const k of ["name__v", "title__v", "label__v", "username__sys", "name__sys"]) {
    const v = effectiveValue(ri, k);
    if (v) return v;
  }
  const id = effectiveValue(ri, "id");
  return id ? `Record ${id}` : `Row ${ri + 1}`;
}

function renderInspector() {
  if (!WINDOW_MODE) return;
  const ri = resultsView.selected;
  const row = ri != null ? queryRows[ri] : null;
  // The drawer is only there while a row is picked.
  vqlPanel.classList.toggle("row-open", !!row);
  inspEmpty.classList.toggle("hidden", !!row);
  inspBody.classList.toggle("hidden", !row);
  if (!row) return;

  inspTitle.textContent = rowTitle(ri);
  let html = "";
  for (const k of resultKeys) {
    const rawV = row[k];
    const label = columnDescribe(k)?.label || columnModelField(k)?.label || "";
    const dtTip = label && label !== k ? `${k} · ${label}` : k;
    if (isSubValue(rawV)) {
      // Related records get the full width under their name.
      html += `<dt class="insp-sub-name" title="${esc(dtTip)}">${esc(k)} <span>${esc(subSummary(rawV))}</span></dt>`;
      html += `<dd class="insp-sub" data-sub="${esc(k)}" tabindex="-1">${subTableHtml(rawV, 25)}</dd>`;
      continue;
    }
    const v = effectiveValue(ri, k);
    const cls = [v === "" ? "empty" : "", pendingEdits[`${ri}:${k}`] ? "dirty" : ""].filter(Boolean).join(" ");
    html += `<dt title="${esc(dtTip)}">${esc(k)}</dt>`;
    html += `<dd${cls ? ` class="${cls}"` : ""}>${v === "" ? "&mdash;" : esc(v)}</dd>`;
  }
  inspFields.innerHTML = html;

  const url = recordUrl(row);
  inspOpen.classList.toggle("hidden", !url);
  if (url) inspOpen.href = url;
  else inspOpen.removeAttribute("href");
}

// ---- Recent queries ---------------------------------------------------------
const RECENT_LIMIT = 20;

function relativeTime(ts) {
  if (!ts) return "Earlier";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Earlier today";
  today.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Yesterday";
  return d.toLocaleDateString();
}

function renderRecent() {
  if (!WINDOW_MODE) return;
  const items = state.history.slice(0, RECENT_LIMIT);
  if (!items.length) {
    recentList.innerHTML = '<div class="insp-empty recent-empty">Queries you run show up here.</div>';
    return;
  }
  recentList.innerHTML = items
    .map((h, i) => {
      const meta = [relativeTime(h.ts)];
      const tab = h.tab && queryTabs.find((t) => t.id === h.tab);
      if (tab) meta.push(tab.id === activeTabId ? "this tab" : `${tabLabel(tab)} tab`);
      const failed = h.success === false;
      return (
        `<button type="button" class="recent-item" data-index="${i}" title="${esc(h.query)}">` +
        `<span class="recent-q">${esc(h.query.replace(/\s+/g, " "))}</span>` +
        `<span class="recent-meta">${esc(meta.join(" · "))}` +
        `${failed ? ' · <span class="recent-fail">failed</span>' : ""}</span>` +
        "</button>"
      );
    })
    .join("");
}

// ---- Data model sidebar -----------------------------------------------------
function wbTypeLabel(type) {
  const t = String(type || "").toLowerCase();
  return t === "objectreference" ? "object" : t;
}

// ===================== UTILS =====================
// Escapes for both text and quoted-attribute contexts. The textContent round
// trip this used to do leaves " and ' untouched, so any value interpolated
// into title="…" or data-x="…" could close the attribute and add its own —
// a document named `" onmouseover="…` was enough to run script in here.
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

// Only ever emit links we can vouch for. Source URLs arrive from the
// documentation server, and `javascript:` in an href runs in this page, which
// holds the Vault session.
function safeUrl(url) {
  try {
    const parsed = new URL(String(url), location.href);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch (e) {
    return "";
  }
}

// Vault tenants are subdomains of veevavault.com and nothing else. A substring
// test passes "veevavault.com.attacker.example", which would send the session
// token and every query to that host.
const VAULT_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.veevavault\.com$/i;

function isVaultHost(host) {
  return VAULT_HOST_RE.test(String(host || ""));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}
