// ===================== STATE =====================
let state = {
  sessionId: null,
  domain: null,
  history: [],
  dataModel: null,
  // The Vault API version this vault is called at; set on connect.
  apiVersion: null,
};

// ===================== DOM REFS =====================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const vqlPanel = $("#vql-panel");
const statusPill = $("#status-pill");
const statusText = $("#status-text");
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
const dmSync = $("#dm-sync");
const dmRefresh = $("#dm-refresh");
const dmSyncBar = $("#dm-sync-bar");
const accessSync = $("#access-sync");
const accessRefresh = $("#access-refresh");
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
// The History popover lists only the latest few; the full window's panel lists all.
const HISTORY_POPOVER_LIMIT = 5;
let historyNavIndex = -1;

// Cancellation token for the in-flight query. The cancel button flips
// `aborted = true`; the runQuery loops check it after every await and bail
// out gracefully. In-flight fetches are not cancelled at the network level —
// their responses are simply discarded once the flag is set.
let activeQueryToken = null;

// ===================== WINDOW MODE =====================
if (WINDOW_MODE) {
  document.body.classList.add("mode-window");
  // The workbench's status bar holds the vault identity; the top bar itself
  // becomes the rail.
  $("#status-left").appendChild($(".topbar-conn"));
  expandBtn.classList.add("hidden");
  collapseBtn.classList.remove("hidden");
  // The editor's own actions sit on its toolbar, right of the operator chips.
  editorTools.append(clearBtn, cancelBtn, runBtn);
  runBtn.innerHTML = RUN_LABEL;
  resultsContainer.dataset.empty = `Run a query to see its rows here · ${RUN_KEY_LABEL}`;
}

expandBtn.addEventListener("click", async () => {
  // Build the query string outside getURL — it takes a path, and a version that
  // escapes or drops the "?" would open the popup layout instead of the window one.
  // The vault goes along by name: from its own tab the window cannot tell which
  // of several open Vault tabs the panel was working in.
  const query = new URLSearchParams({ mode: "window" });
  if (state.domain) query.set("vault", state.domain);
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
    await chrome.tabs.sendMessage(tab.id, { action: "openOverlay" });
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
  window.parent.postMessage({ type: "dweller-close" }, "*");
}

// The iframe wrapper has no intrinsic height, so it would leave dead space below
// a short panel. Report the real content height and let content.js shrink-wrap.
// Absolutely-positioned overlays don't grow .shell, so measure them separately
// or they get clipped by the resized iframe.
if (!WINDOW_MODE) {
  const shell = document.querySelector(".shell");
  // Query these by selector: their consts are declared far below, so naming
  // them here would hit the temporal dead zone at load. #export-menu stays open
  // and grows while a config report runs, so it must be measured too.
  const floatingPanels = [acDropdown, historyPopover, $("#saved-popover"), $("#export-menu")];
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
    window.parent.postMessage({ type: "dweller-height", height }, "*");
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
    "valueMode", "explorerPanel", "editorHeight", "savedQueries",
  ]);
  if (VALUE_MODES.includes(saved.valueMode)) valueMode = saved.valueMode;
  paintValueMode();
  if (saved.queryHistory) state.history = saved.queryHistory;
  // Saved queries are global — one list across every vault, so a consultant's
  // discovery set travels with them.
  if (Array.isArray(saved.savedQueries)) savedQueries = saved.savedQueries;
  renderSaved();
  initRecordOffer();
  // Per-vault data loads once autoConnect knows the domain; caches from older
  // versions are moved to per-vault keys by migrateVaultCaches().
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
    if (isVaultHost(domain)) autoConnect(domain);
  } catch (e) {
    // No vault tab to read: the panel stays disconnected.
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
  if (name === "doctypes") onDocTypesShown();
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
    // transformed coordinates, so a transform on an ancestor would bake into the
    // CSS lengths. The root is position:relative, so an option's offsetParent is
    // the root, which is also the thumb's containing block.
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
    if (WINDOW_MODE) return;
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
  // a tab or from storage.
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

  const userResult = await apiCall("/objects/users/me");

  if (!userResult.success || userResult.data?.responseStatus === "FAILURE") {
    const errMsg =
      userResult.data?.errors?.[0]?.message || userResult.error || "Authentication failed";
    setStatus("disconnected", errMsg);
    state.sessionId = null;
    return;
  }

  // Called at the newest version both sides know, so newer VQL (SHOW, TRIM(),
  // the attachment functions…) works where the vault has it.
  await detectApiVersion();
  setStatus("connected", "Connected");
  showUserInfo(userResult.data);
  showVqlPanel();
  updateRecordOffer();

  // This vault's saved data model and document types show at once; then the
  // model checks itself, and the types do when their tab is open.
  await loadDataModelForDomain(domain);
  await loadDocTypesForDomain(domain);
  await loadAccessForDomain(domain);
  syncModelList();
  syncAccess();
  if (dtTabActive()) onDocTypesShown();
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
const VAULT_CACHE_KEYS = { dataModels: "dataModel", docTypeCache: "docTypes", fieldStats: "fieldStats", access: "access" };

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
  if (model?.model && model.time !== dataModelTime) {
    const incoming = normalizeModel(model.model, model.time);
    if (!state.dataModel) {
      state.dataModel = incoming;
      onDataModelLoaded(model.time);
    } else if (mergeModel(state.dataModel, incoming)) {
      modelChanged(null, false);
    }
  }
  const types = changes[vaultCacheKey("docTypeCache", state.domain)]?.newValue;
  if (types?.types?.length && types.time !== docTypesTime) {
    const incoming = normalizeTypes(types.types, types.time);
    if (!docTypes.length) applyDocTypes(incoming, types.time);
    else if (mergeTypes(docTypes, incoming)) {
      renderDocTypeList();
      paintSync();
      if (dtSelected) showDocTypeFields(dtSelected);
    }
  }
  // Another view reloaded this vault's field access: take it.
  const access = changes[vaultCacheKey("access", state.domain)]?.newValue;
  if (access?.denied && access.time && access.time !== accessTime) {
    accessMap = deserializeAccess(access.denied);
    accessTime = access.time;
    accessHadRows = access.hadRows !== false;
    refreshAfterAccess();
    paintAccessSync();
  }
});

// ===================== PER-INSTANCE DATA MODEL =====================
async function loadDataModelForDomain(domain) {
  resetSync();
  dmResetView();
  await loadDmChips(domain);
  forgetLiveObjects();
  await loadFieldStatsForDomain(domain);
  const entry = await readVaultCache("dataModels", domain);
  if (entry && entry.model) {
    state.dataModel = normalizeModel(entry.model, entry.time);
    onDataModelLoaded(entry.time);
  } else {
    state.dataModel = null;
    dataModelTime = null;
    renderDataModelTree("");
    paintSync();
  }
}

function setStatus(type, text) {
  statusPill.className = `status-pill ${type}`;
  // Connected collapses to a bare dot in the overlay, so the message has to
  // survive as a tooltip. In the full window the pill names the vault instead.
  const connectedInWindow = type === "connected" && WINDOW_MODE && state.domain;
  statusText.textContent = connectedInWindow ? state.domain : text;
  statusPill.title = connectedInWindow ? `Connected to ${state.domain}` : text;
  if (WINDOW_MODE) {
    $("#status-api").textContent = type === "connected" && state.apiVersion ? `API ${state.apiVersion}` : "";
  }
}

// The signed-in user, shown in the full window's status bar: the address, with
// the name in its tooltip.
function showUserInfo(data) {
  const u = data.users?.[0]?.user || data;
  const name = [u.user_first_name__v, u.user_last_name__v].filter(Boolean).join(" ");
  const login = u.user_email__v || u.user_name__v || "";
  topbarUser.textContent = login || name;
  topbarUser.title = [name, login].filter(Boolean).join(" · ");
}

function showVqlPanel() {
  vqlPanel.classList.remove("hidden");
  vqlInput.focus();
  paintTabThumb();
  // The editor was sized while hidden, when it measured nothing.
  if (WINDOW_MODE) paintEditor();
}

// The history list is the one popover left.
function closeHistory() {
  historyPopover.classList.add("hidden");
  historyBtn.setAttribute("aria-expanded", "false");
}

// The History pill drops the list under itself, and closes autocomplete and the
// Saved popover on the way.
historyBtn.addEventListener("click", () => {
  const wasHidden = historyPopover.classList.contains("hidden");
  closeHistory();
  closeSaved();
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
  if (open && !findRow.hidden) setFindOpen(false);
  insertRow.hidden = !open;
  operatorBar.classList.toggle("inserting", open);
  insertChip.setAttribute("aria-expanded", String(open));
  insertChip.title = open ? "Close" : "Insert VQL Operator";
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
  if (!savedPopover.classList.contains("hidden") && !e.target.closest("#saved-popover, #saved-btn")) {
    closeSaved();
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
  // Don't steal Escape from an in-progress rename (it reverts that instead).
  if (!savedPopover.classList.contains("hidden") && !e.target.classList.contains("saved-rename-input")) {
    const inside = savedPopover.contains(document.activeElement);
    closeSaved();
    if (inside) savedBtn.focus();
  }
});

// ===================== FIND =====================
// Full-text search as a pill beside INSERT and FIELD NAMES. It opens a field
// in the row the way INSERT opens its chips; Enter writes FIND ('term' SCOPE
// ALL) into the query just after FROM, so what runs is what the editor shows.
// The pill then reads the term from the query itself, and its × takes the
// clause out. SCOPE ALL searches every field and the document's content.
const findWrap = $("#find-wrap");
const findChip = $("#find-chip");
const findChipLabel = $("#find-chip-label");
const findClear = $("#find-clear");
const findRow = $("#find-row");
const findInput = $("#find-input");
const findHint = $("#find-hint");
const FIND_HINT = "<kbd>↵</kbd> adds FIND (… SCOPE ALL) to the query";

// VQL string literals escape with a backslash.
function vqlLiteral(text) {
  return `'${String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function vqlLiteralText(tok) {
  return tok.replace(/^'|'$/g, "").replace(/\\(.)/g, "$1");
}

// The query's top-level FIND clause: where it starts and ends, and its first
// search term. Null when there's none.
function vqlFindClause(q) {
  const toks = vqlTokens(q || "");
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].depth !== 0 || !/^find$/i.test(toks[i].t)) continue;
    const open = toks[i + 1];
    if (!open || open.t !== "(") return { start: toks[i].at, end: toks[i].end, term: "" };
    let end = q.length;
    for (let j = i + 2; j < toks.length; j++) {
      if (toks[j].t === ")" && toks[j].depth === 0) {
        end = toks[j].end;
        break;
      }
    }
    const lit = toks.find((x) => x.at > open.at && x.at < end && x.t.startsWith("'"));
    return { start: toks[i].at, end, term: lit ? vqlLiteralText(lit.t) : "" };
  }
  return null;
}

// Puts the whole query in the editor, caret after `caret`, as the other
// helpers do.
function setQueryText(text, caret = text.length) {
  vqlInput.value = text;
  vqlInput.setSelectionRange(caret, caret);
  historyNavIndex = -1;
  editorChanged();
}

function paintFindChip() {
  const clause = vqlFindClause(vqlInput.value);
  const on = !!clause && findRow.hidden;
  const term = clause?.term || "";
  findWrap.classList.toggle("on", on);
  findClear.hidden = !on;
  // The term in a span of its own, so a narrow toolbar can drop it.
  const label = on && term
    ? `<span class="find-word">FIND</span> <span class="find-term">${esc(term)}</span>`
    : '<span class="find-word">FIND</span>';
  // Only when it changes: replacing the spans under a click in progress would
  // leave its target outside the page.
  if (findChipLabel.innerHTML !== label) findChipLabel.innerHTML = label;
  findChip.title = on
    ? `Searching Every Field for “${term}”.`
    : "Search Every Field";
}

function setFindHint(text, error = false) {
  if (error) findHint.textContent = text;
  else findHint.innerHTML = text;
  findHint.classList.toggle("error", error);
}

function setFindOpen(open) {
  if (open && !insertRow.hidden) setInsertOpen(false);
  findRow.hidden = !open;
  operatorBar.classList.toggle("finding", open);
  findChip.setAttribute("aria-expanded", String(open));
  if (open) {
    hideAc();
    findInput.value = vqlFindClause(vqlInput.value)?.term || "";
    setFindHint(FIND_HINT);
    findInput.focus();
    findInput.select();
  }
  paintFindChip();
}

// Enter, or the FIND button again with something typed: the term goes into
// the query, replacing a FIND already there. An empty field takes the FIND out.
function submitFind() {
  const term = findInput.value.trim();
  const q = vqlInput.value;
  const existing = vqlFindClause(q);
  if (!term) {
    if (existing) removeFind();
    setFindOpen(false);
    vqlInput.focus();
    return;
  }
  // Nothing written yet: a search of documents.
  if (!q.trim()) {
    setFindOpen(false);
    setQueryText(`SELECT id FROM documents\nFIND (${vqlLiteral(term)} SCOPE ALL)`);
    vqlInput.focus();
    return;
  }
  const shape = vqlShape(q);
  if (!existing && shape.targetEnd < 0) {
    setFindHint("Write the query's FROM first: FIND searches what the query is FROM.", true);
    return;
  }
  const target = modelObject(shape.target);
  if (target?.dataStore === "raw") {
    setFindHint(`FIND can't search ${target.name}: it's a raw object.`, true);
    return;
  }
  if (target?.kind === "target") {
    setFindHint(`FIND searches documents and Vault objects, not ${target.name}.`, true);
    return;
  }
  const clause = `FIND (${vqlLiteral(term)} SCOPE ALL)`;
  let next;
  let caret;
  if (existing) {
    next = q.slice(0, existing.start) + clause + q.slice(existing.end);
    caret = existing.start + clause.length;
  } else {
    // On its own line after the target, ahead of WHERE and the rest, which
    // is where VQL wants it.
    next = `${q.slice(0, shape.targetEnd)}\n${clause}${q.slice(shape.targetEnd)}`;
    caret = shape.targetEnd + 1 + clause.length;
  }
  setFindOpen(false);
  setQueryText(next, caret);
  vqlInput.focus();
}

// The ×: the clause goes, with the line break or spaces in front of it.
function removeFind() {
  const q = vqlInput.value;
  const clause = vqlFindClause(q);
  if (!clause) return;
  let start = clause.start;
  while (start > 0 && /[ \t]/.test(q[start - 1])) start--;
  if (q[start - 1] === "\n") start--;
  setQueryText(q.slice(0, start) + q.slice(clause.end), start);
}

// The pill opens the field; with something typed in it, the pill again does
// what Enter does.
findChip.addEventListener("click", () => {
  if (!findRow.hidden && findInput.value.trim()) submitFind();
  else setFindOpen(findRow.hidden);
});
findClear.addEventListener("click", () => {
  removeFind();
  vqlInput.focus();
});
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitFind();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    setFindOpen(false);
    findChip.focus();
  }
});
findInput.addEventListener("input", () => {
  if (findHint.classList.contains("error")) setFindHint(FIND_HINT);
});

// A click anywhere else closes the field without writing anything. The
// click's own path, not its target's ancestors now: the pill may have redrawn
// what was clicked by the time this runs.
document.addEventListener("click", (e) => {
  if (findRow.hidden) return;
  const path = e.composedPath();
  if (!path.includes(findRow) && !path.includes(findWrap)) setFindOpen(false);
});

// The pill follows the query however it changes: typed, loaded from History,
// a tab switch, Format, Clear. Most of those set the textarea's value
// directly, which fires no event, so the setter on this one element is
// wrapped to repaint the pill too.
{
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  Object.defineProperty(vqlInput, "value", {
    configurable: true,
    get() {
      return desc.get.call(this);
    },
    set(v) {
      desc.set.call(this, v);
      queueMicrotask(paintFindChip);
    },
  });
}
vqlInput.addEventListener("input", paintFindChip);
// After the whole script has run: the tokenizer's patterns are defined further down.
queueMicrotask(paintFindChip);

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
  // Its metadata decides Names/Labels and what can be edited.
  const shape = vqlShape(baseQuery);
  const runTarget = modelObject(shape.target);
  if (runTarget && !runTarget.checkedAt) await Promise.race([touchModelObjects([runTarget.name]), sleep(2500)]);
  else if (runTarget) touchModelObjects([runTarget.name]);
  const startTime = performance.now();
  lastRunQuery = raw;
  resultValues = null;
  resultMeta = null;

  // The Names/Labels switch acts on the query as it goes out: eligible fields
  // are wrapped in TONAME() or TOLABEL(). The editor keeps what was typed.
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
const VALUE_MODE_LABELS = { names: "Field Names", labels: "Field Labels" };
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

  const obj = modelObject(target);
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
  // Field Labels reads as switched on (see .value-chip.on).
  valueField.classList.toggle("on", !names);
  valueField.title = names ? "Technical Field Names in Veeva Vault" : "Functional Field Labels in Veeva Vault";
  valueField.setAttribute("aria-label", `${VALUE_MODE_LABELS[valueMode]}. ${names ? "Click for field labels." : "Click for field names."}`);
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
copyBtn.addEventListener("click", async () => {
  if (!lastResultData) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastResultData, null, 2));
    copyBtn.textContent = "Copied!";
  } catch {
    copyBtn.textContent = "Copy failed";
  }
  clearTimeout(copyBtn.resetTimer);
  copyBtn.resetTimer = setTimeout(() => (copyBtn.textContent = "Copy JSON"), 1500);
});

exportCsvBtn.addEventListener("click", () => {
  if (!lastResultData?.data?.length) return;
  const rows = lastResultData.data;
  const keys = resultColumns(rows);
  let csv = keys.map(csvEsc).join(",") + "\n";
  for (const row of rows) csv += keys.map((k) => csvEsc(exportText(row[k]))).join(",") + "\n";
  downloadBlob(new Blob([csv], { type: "text/csv" }), `vql_results_${Date.now()}.csv`);
});

// Saves a file through a temporary link.
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoke after the browser has had time to read the blob — a synchronous
  // revoke can truncate a large download (e.g. a multi-MB config report ZIP).
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

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
  return csvField(str);
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

function downloadXlsx(rows) {
  downloadBlob(buildXlsxBlob(rows), `vql_results_${Date.now()}.xlsx`);
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
    .slice(0, HISTORY_POPOVER_LIMIT)
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

// ===================== SAVED QUERIES =====================
// Deliberately kept, named queries — distinct from History (automatic, recent).
// Global: one list across every vault, so a discovery set travels with you. The
// same rows render into the overlay popover and the full-window rail panel.
let savedQueries = [];
let savedRenameId = null;
const savedBtn = $("#saved-btn");
const savedPopover = $("#saved-popover");
const savedList = $("#saved-list");
const savedRailList = $("#saved-rail-list");

function persistSaved() {
  chrome.storage.local.set({ savedQueries });
}

// A first-guess name from the query's FROM target; the user renames inline.
function defaultSavedName(q) {
  const m = /\bFROM\s+([a-z0-9_]+)/i.exec(q);
  return m ? m[1] : "Saved query";
}

function savedRowHtml(s) {
  if (s.id === savedRenameId) {
    return `<div class="saved-row renaming" data-id="${s.id}">` +
      `<input class="saved-rename-input" type="text" maxlength="60" value="${esc(s.name)}" aria-label="Query name" /></div>`;
  }
  return (
    `<div class="saved-row" data-id="${s.id}" title="${esc(s.query)}">` +
    `<button type="button" class="saved-load">` +
    `<span class="saved-name">${esc(s.name)}</span>` +
    `<span class="saved-q">${esc(s.query.replace(/\s+/g, " "))}</span></button>` +
    `<span class="saved-actions">` +
    `<button type="button" class="saved-edit" title="Rename" aria-label="Rename">` +
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>` +
    `<button type="button" class="saved-del" title="Delete" aria-label="Delete">` +
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>` +
    `</span></div>`
  );
}

function renderSaved() {
  const html = savedQueries.length
    ? savedQueries.map(savedRowHtml).join("")
    : '<div class="saved-empty">No saved queries yet. Write one, then “Save current”.</div>';
  if (savedList) savedList.innerHTML = html;
  if (savedRailList) savedRailList.innerHTML = html;
  // Focus whichever rename input is actually on screen (overlay or rail).
  if (savedRenameId) {
    for (const inp of document.querySelectorAll(".saved-rename-input")) {
      if (inp.offsetParent !== null) { inp.focus(); inp.select(); break; }
    }
  }
}

function saveCurrentQuery() {
  const q = vqlInput.value.trim();
  if (!q) return;
  const id = `sq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  savedQueries.unshift({ id, name: defaultSavedName(q), query: q, ts: Date.now() });
  persistSaved();
  savedRenameId = id;            // drop straight into naming it
  renderSaved();
}

function beginRenameSaved(id) {
  savedRenameId = id;
  renderSaved();
}

function commitRenameSaved(id, value) {
  const s = savedQueries.find((x) => x.id === id);
  if (s) { s.name = (value || "").trim() || s.name; persistSaved(); }
  savedRenameId = null;
  renderSaved();
}

function removeSaved(id) {
  savedQueries = savedQueries.filter((s) => s.id !== id);
  if (savedRenameId === id) savedRenameId = null;
  persistSaved();
  renderSaved();
}

function loadSavedIntoEditor(id) {
  const s = savedQueries.find((x) => x.id === id);
  if (!s) return;
  vqlInput.value = s.query;
  historyNavIndex = -1;
  activatePane("query");
  vqlInput.focus();
  vqlInput.setSelectionRange(s.query.length, s.query.length);
  editorChanged();
}

function closeSaved() {
  savedPopover.classList.add("hidden");
  savedBtn.setAttribute("aria-expanded", "false");
}

// The overlay pill drops the list under itself, closing History and autocomplete.
savedBtn.addEventListener("click", () => {
  const wasHidden = savedPopover.classList.contains("hidden");
  closeSaved();
  closeHistory();
  hideAc();
  if (wasHidden) {
    savedPopover.classList.remove("hidden");
    savedBtn.setAttribute("aria-expanded", "true");
    renderSaved();
  }
});

$("#saved-add-btn").addEventListener("click", saveCurrentQuery);

// Both the overlay list and the rail list share these handlers.
function wireSavedList(container) {
  if (!container) return;
  container.addEventListener("click", (e) => {
    const row = e.target.closest(".saved-row");
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest(".saved-del")) { removeSaved(id); return; }
    if (e.target.closest(".saved-edit")) { beginRenameSaved(id); return; }
    if (e.target.closest(".saved-load")) { loadSavedIntoEditor(id); closeSaved(); }
  });
  container.addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("saved-rename-input")) return;
    const id = e.target.closest(".saved-row")?.dataset.id;
    if (e.key === "Enter") { e.preventDefault(); commitRenameSaved(id, e.target.value); }
    else if (e.key === "Escape") { savedRenameId = null; renderSaved(); }
  });
  container.addEventListener("focusout", (e) => {
    if (!e.target.classList.contains("saved-rename-input")) return;
    const id = e.target.closest(".saved-row")?.dataset.id;
    if (savedRenameId === id) commitRenameSaved(id, e.target.value);
  });
}
wireSavedList(savedList);
wireSavedList(savedRailList);

// ===================== QUERY THIS RECORD =====================
// Overlay only: content.js reads the record from the Vault page URL and posts
// it here. We offer a one-click query for it; the record id is sanitised before
// it goes anywhere near a query.
let pageRecord = null;

const RECORD_DOC_FIELDS = [
  "id", "name__v", "type__v", "subtype__v", "classification__v", "lifecycle__v",
  "status__v", "document_number__v", "major_version_number__v",
  "minor_version_number__v", "version_modified_date__v",
];

function validRecord(rec) {
  if (!rec) return false;
  if (rec.kind === "document") return /^\d+$/.test(rec.id || "");
  if (rec.kind === "object") {
    return /^[a-z0-9_]+$/i.test(rec.object || "") && /^[a-z0-9]+$/i.test(rec.id || "");
  }
  return false;
}


function buildRecordQuery(rec) {
  if (rec.kind === "document") {
    return `SELECT ${RECORD_DOC_FIELDS.join(", ")}\nFROM documents\nWHERE id = ${rec.id}`;
  }
  // The object's own fields if the data model holds them, else a safe minimum.
  let fields = ["id", "name__v"];
  const obj = modelObject(rec.object);
  if (obj?.fields?.length) {
    const names = obj.fields
      .filter((f) => f.queryable !== false && /^[a-z_][a-z0-9_]*$/i.test(f.name || "") && f.name !== "id")
      .map((f) => f.name);
    if (names.length) fields = ["id", ...names];
  }
  return `SELECT ${fields.join(", ")}\nFROM ${rec.object}\nWHERE id = '${rec.id}'`;
}

// Show the "This record" pill (by History) only in the overlay, when a record
// was detected on the page and we're connected. Its tooltip carries the record.
function updateRecordOffer() {
  const chip = document.getElementById("record-chip");
  if (!chip) return;
  const show = !WINDOW_MODE && pageRecord && state.sessionId;
  chip.classList.toggle("hidden", !show);
  if (show) {
    const label = pageRecord.label
      || (pageRecord.kind === "document" ? `Document ${pageRecord.id}` : `${pageRecord.object} record`);
    chip.title = `Query this record · ${label}`;
  }
}

function queryPageRecord() {
  if (!pageRecord) return;
  activatePane("query");
  setQueryText(buildRecordQuery(pageRecord));
  runQuery();
}

function initRecordOffer() {
  if (WINDOW_MODE) return;          // the full window has no "current page"
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || e.data?.type !== "dweller-record") return;
    pageRecord = validRecord(e.data.record) ? e.data.record : null;
    updateRecordOffer();
  });
  document.getElementById("record-chip")?.addEventListener("click", queryPageRecord);
  // Now that we're listening, ask content.js for the current record.
  window.parent.postMessage({ type: "dweller-ready" }, "*");
}

// ===================== DATA MODEL =====================
// ---- Loading by itself ---------------------------------------------------------
// Nothing here waits for a click. On connect the saved copy shows at once and
// the object list is read again (one call). Objects the editor, autocomplete or
// the Data model panel need are fetched straight away; the rest are filled in
// one call at a time in the background, slowly enough to leave the vault's
// shared rate limit to everyone else. Each object remembers when it was
// fetched, and one used after FIELD_DEFS_MAX_AGE is fetched again. Document
// types work the same way from their tab, and their record counts refresh
// while the tab is open once they're COUNTS_MAX_AGE old. ↻ forces either.
const FIELD_DEFS_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const COUNTS_MAX_AGE = 24 * 60 * 60 * 1000;
const SYNC_GAP_MS = 1500;          // background calls: at most one per gap
const SYNC_FORCED_GAP_MS = 200;    // ...and after ↻, which the user asked for
const SYNC_BUDGET_FLOOR = 0.25;    // background work stops below this share of the burst limit
const SYNC_BACKOFF_MS = 60000;     // ...and looks again after this long
const SYNC_LEASE_MS = 15000;
// Fetched by a version too old to say when: kept, but due.
const CHECKED_LONG_AGO = 1;
const VIEW_ID = Math.random().toString(36).slice(2);

const sync = {
  epoch: 0,              // bumped per vault; work for an older one stops
  burst: null,           // { limit, remaining, at } from the last response
  queue: [],             // background jobs, in order
  queued: new Set(),
  pumping: false,
  lastCall: 0,
  waiting: false,        // held back by the rate limit
  modelListAt: null,     // the object list, read this session
  modelListing: false,
  modelError: null,
  typesListAt: null,
  typesListing: false,
  typesError: null,
  counting: false,
  countDone: 0,
  countTotal: 0,
  // When ↻ was pressed: anything fetched or counted before then is due again.
  modelForcedAt: 0,
  typesForcedAt: 0,
  fast: false,           // a ↻ refresh is running: shorter gaps until the queue empties
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function noteBurst(b) {
  if (b && Number.isFinite(b.remaining)) sync.burst = { limit: b.limit, remaining: b.remaining, at: Date.now() };
}

// A reading older than the back-off is stale: the next call brings a new one.
function budgetLow() {
  const b = sync.burst;
  return !!(b && b.limit && Date.now() - b.at < SYNC_BACKOFF_MS && b.remaining < b.limit * SYNC_BUDGET_FLOOR);
}

function isStale(ts, maxAge) {
  return !ts || ts <= CHECKED_LONG_AGO || Date.now() - ts > maxAge;
}

// Due for the background fill: never fetched, fetched too long ago to say
// when, or before ↻.
function modelDue(o) {
  return !o.checkedAt || o.checkedAt <= CHECKED_LONG_AGO || o.checkedAt < sync.modelForcedAt;
}

function typeDue(t) {
  return !t.checkedAt || t.checkedAt <= CHECKED_LONG_AGO || t.checkedAt < sync.typesForcedAt;
}

function countDue(t) {
  return isStale(t.countedAt, COUNTS_MAX_AGE) || t.countedAt < sync.typesForcedAt;
}

// "just now", "5 min ago", "3 h ago", "2 days ago".
function ageText(ts) {
  if (!ts) return "";
  const mins = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

// One view per vault does the background filling: the panel and the full
// window share what they fetch through storage, so two would only double it.
async function holdSyncLease() {
  if (!state.domain) return false;
  const key = `syncLease:${state.domain}`;
  const now = Date.now();
  const cur = (await chrome.storage.local.get(key))[key];
  if (cur && cur.id !== VIEW_ID && cur.until > now) return false;
  // Still ours for a while: renewing on every call would write storage several
  // times a second during a refresh.
  if (cur?.id === VIEW_ID && cur.until - now > SYNC_LEASE_MS / 2) return true;
  await chrome.storage.local.set({ [key]: { id: VIEW_ID, until: now + SYNC_LEASE_MS } });
  return true;
}

async function takeSyncLease() {
  if (state.domain) await chrome.storage.local.set({ [`syncLease:${state.domain}`]: { id: VIEW_ID, until: Date.now() + SYNC_LEASE_MS } });
}

function resetSync() {
  sync.epoch++;
  sync.queue = [];
  sync.queued.clear();
  Object.assign(sync, {
    waiting: false, modelListAt: null, modelListing: false, modelError: null,
    typesListAt: null, typesListing: false, typesError: null,
    counting: false, countDone: 0, countTotal: 0, modelForcedAt: 0, typesForcedAt: 0, fast: false,
  });
  modelPending.clear();
  dtPending.clear();
}

// Background jobs: { key, needed(), run() }. A job no longer needed when its
// turn comes (another view fetched it, the user's click did) costs no call.
function syncEnqueue(job) {
  if (sync.queued.has(job.key)) return;
  sync.queued.add(job.key);
  sync.queue.push(job);
  syncPump();
}

async function syncPump() {
  if (sync.pumping) return;
  sync.pumping = true;
  const epoch = sync.epoch;
  try {
    while (sync.queue.length && epoch === sync.epoch && state.sessionId) {
      const job = sync.queue[0];
      if (!job.needed()) {
        sync.queue.shift();
        sync.queued.delete(job.key);
        continue;
      }
      if (!(await syncSlot(epoch))) break;
      if (sync.queue[0] !== job) continue;
      sync.queue.shift();
      sync.queued.delete(job.key);
      if (!job.needed()) continue;
      try {
        await job.run();
      } catch (e) {
        /* the job keeps its own failure */
      }
      sync.lastCall = Date.now();
    }
  } finally {
    sync.pumping = false;
    if (!sync.queue.length) sync.fast = false;
    if (epoch === sync.epoch) paintSync();
  }
}

// Waits for the next background call: the gap since the last one, none of the
// user's queries running, room in the vault's rate limit, and the lease.
async function syncSlot(epoch) {
  for (;;) {
    if (epoch !== sync.epoch || !state.sessionId) return false;
    const wait = sync.lastCall + (sync.fast ? SYNC_FORCED_GAP_MS : SYNC_GAP_MS) - Date.now();
    if (wait > 0) {
      await sleep(wait);
      continue;
    }
    if (activeQueryToken) {
      await sleep(500);
      continue;
    }
    if (budgetLow()) {
      sync.waiting = true;
      paintSync();
      await sleep(SYNC_BACKOFF_MS);
      sync.waiting = false;
      continue;
    }
    if (!(await holdSyncLease())) {
      await sleep(SYNC_LEASE_MS / 3);
      continue;
    }
    return true;
  }
}

// ---- The data model --------------------------------------------------------------
const modelPending = new Map();   // lower-case name -> the fetch in flight

// A saved model made ready for this code: every object has a field list and
// the time it was fetched. Earlier versions saved the whole model at once, so
// their objects count as fetched when it was saved; those from before
// relationships were kept count as long ago.
function normalizeModel(model, savedAt) {
  const t = Date.parse(savedAt || "") || CHECKED_LONG_AGO;
  for (const o of model.objects || []) {
    if (!Array.isArray(o.fields)) o.fields = [];
    if (o.checkedAt === undefined) o.checkedAt = o.relationships ? t : o.fields.length ? CHECKED_LONG_AGO : null;
  }
  return model;
}

// Takes the newer copy of each object another view saved, for the objects
// this view lists (a removal it saw stays removed). Returns how many changed.
function mergeModel(into, from) {
  const theirs = new Map((from?.objects || []).map((o) => [o.name.toLowerCase(), o]));
  let changed = 0;
  into.objects.forEach((o, i) => {
    const t = theirs.get(o.name.toLowerCase());
    if (t && (t.checkedAt || 0) > (o.checkedAt || 0)) {
      into.objects[i] = t;
      changed++;
    }
  });
  return changed;
}

// The object list: Vault objects, documents, and on v25.2+ the other query
// targets SHOW TARGETS lists. Objects already known keep what they hold.
async function syncModelList(force = false) {
  if (!state.sessionId || sync.modelListing) return;
  const epoch = sync.epoch;
  sync.modelListing = true;
  sync.modelError = null;
  paintSync();
  try {
    const res = await apiCall("/metadata/vobjects");
    if (epoch !== sync.epoch) return;
    if (!apiOk(res)) {
      sync.modelError = apiErr(res);
      return;
    }
    const listed = (res.data?.objects || [])
      .map((o) => ({ name: o.name || o.object_name || o.name__v, label: o.label || o.label__v || "" }))
      .filter((o) => o.name);
    if (!listed.some((o) => o.name === "documents")) listed.unshift({ name: "documents", label: "Documents" });
    const names = new Set(listed.map((o) => o.name.toLowerCase()));
    const prev = state.dataModel?.objects || [];
    let targets = prev.filter((o) => o.kind === "target");
    if (apiAtLeast("v25.2")) {
      const rows = await showQuery("SHOW TARGETS");
      if (epoch !== sync.epoch) return;
      // A failed SHOW keeps the targets already known rather than dropping them.
      if (rows) {
        targets = rows
          .filter((t) => t?.name && !names.has(t.name.toLowerCase()))
          .slice(0, SHOW_TARGETS_MAX)
          .map((t) => ({ name: t.name, label: t.label && t.label !== t.name ? t.label : "", kind: "target" }));
      }
    }
    const byName = new Map(prev.map((o) => [o.name.toLowerCase(), o]));
    const objects = [...listed, ...targets].map((x) => {
      const old = byName.get(x.name.toLowerCase());
      if (old) {
        if (x.label) old.label = x.label;
        return old;
      }
      const fresh = { name: x.name, label: x.label || "", fields: [], checkedAt: null };
      if (x.kind) fresh.kind = x.kind;
      return fresh;
    });
    objects.sort((a, b) => a.name.localeCompare(b.name));
    // ↻: everything is due, so the fill fetches it all again; what's there
    // stays usable meanwhile.
    if (force) sync.modelForcedAt = Date.now();
    const first = !state.dataModel;
    state.dataModel = { objects };
    sync.modelListAt = Date.now();
    onDataModelLoaded();
    if (first || force) scheduleModelSave(0);
    queueModelFill();
  } finally {
    sync.modelListing = false;
    if (epoch === sync.epoch) paintSync();
  }
}

// Every object not fetched yet, or due, the everyday ones first and the other
// query targets last.
function queueModelFill() {
  if (!state.dataModel) return;
  const due = modelDue;
  const rank = (o) => {
    const i = DM_DEFAULT_OBJECTS.indexOf(o.name.toLowerCase());
    if (i >= 0) return i;
    if (dmExtra.includes(o.name)) return 50;
    return o.kind === "target" ? 200 : 100;
  };
  const todo = state.dataModel.objects.filter(due).sort((a, b) => rank(a) - rank(b));
  for (const o of todo) {
    const n = o.name.toLowerCase();
    syncEnqueue({
      key: `object:${n}`,
      needed: () => {
        const m = modelObject(n);
        return !!m && due(m) && !modelPending.has(n);
      },
      run: () => refreshModelObject(n),
    });
  }
}

// An object's metadata as the old full load fetched it: one metadata call, or
// two SHOW queries for a query target that isn't a Vault object.
async function fetchModelObject(o) {
  if (o.kind === "target") {
    const [fields, rels] = await Promise.all([
      showQuery(`SHOW FIELDS FROM ${o.name}`),
      showQuery(`SHOW RELATIONSHIPS FROM ${o.name}`),
    ]);
    if (!fields && !rels) return { error: "Vault didn't describe it" };
    return { fields: showFields(fields), relationships: showRelationships(rels), elsewhere: [] };
  }
  const res = await apiCall(
    o.name === "documents" ? "/metadata/objects/documents/properties" : `/metadata/vobjects/${encodeURIComponent(o.name)}`
  );
  if (!apiOk(res)) return { error: apiErr(res) };
  const rels = extractRelationships(res);
  const out = {
    fields: extractFields(res),
    relationships: rels.own,
    elsewhere: rels.elsewhere,
    // "raw" objects don't take TOLABEL(); Names/Labels skips them.
    dataStore: res.data?.object?.data_store,
    label: res.data?.object?.label || "",
  };
  // v25.2+: documents' relationships with their exact names, which the
  // metadata doesn't all carry.
  if (o.name === "documents" && apiAtLeast("v25.2")) {
    for (const r of showRelationships(await showQuery("SHOW RELATIONSHIPS FROM documents"))) {
      if (!out.relationships.some((x) => x.name.toLowerCase() === r.name.toLowerCase())) out.relationships.push(r);
    }
  }
  return out;
}

// Fetches one object now (one fetch per object at a time) into the model.
function refreshModelObject(name) {
  const n = String(name || "").toLowerCase();
  if (modelPending.has(n)) return modelPending.get(n);
  const o = modelObject(n);
  if (!o || !state.sessionId) return Promise.resolve();
  const epoch = sync.epoch;
  const job = fetchModelObject(o)
    .then((info) => {
      if (epoch === sync.epoch) applyModelObject(o.name, info);
    })
    .catch(() => {})
    .finally(() => modelPending.delete(n));
  modelPending.set(n, job);
  return job;
}

function applyModelObject(name, info) {
  const o = modelObject(name);
  if (!o) return;
  o.checkedAt = Date.now();
  if (info.error) {
    // Counted as fetched, so a broken object isn't asked about on every turn;
    // its age or ↻ tries again.
    o.fetchError = info.error;
  } else {
    // Relationships other objects pointed in stay, unless this object's own
    // metadata now names them itself.
    const linked = (o.relationships || []).filter((r) => r.linked);
    o.fields = info.fields;
    o.relationships = info.relationships;
    for (const r of linked) {
      if (!o.relationships.some((x) => x.name.toLowerCase() === r.name.toLowerCase())) o.relationships.push(r);
    }
    if (info.dataStore !== undefined) o.dataStore = info.dataStore;
    if (info.label && !o.label) o.label = info.label;
    delete o.fetchError;
    linkInbound(o, info.elsewhere);
    // Opening an object asks for its fill rates straight away, but on a first
    // open its fields aren't here yet and there is nothing to measure. Ask
    // again now that they are.
    if (dmSelected === o.name) scheduleFieldStats(o.name);
  }
  modelChanged(o.name);
}

// The far side of a relationship one object's metadata shows: a field's
// inbound name on the object it points at, and documents' document_x__vr on x.
function linkInbound(o, elsewhere) {
  const addTo = (targetName, rel) => {
    const t = modelObject(targetName);
    if (!t) return;
    t.relationships = t.relationships || [];
    if (!t.relationships.some((r) => r.name.toLowerCase() === rel.name.toLowerCase())) t.relationships.push({ ...rel, linked: true });
  };
  for (const e of elsewhere || []) addTo(e.owner, { name: e.name, dir: "in", target: o.name, field: e.field, label: e.label });
  if (o.name === "documents") {
    for (const r of o.relationships || []) {
      if (r.target && !r.linked) addTo(r.target, { name: r.name, dir: "in", target: "documents", field: r.field, label: r.label });
    }
  }
}

// What the editor, autocomplete or the panel is about to use: fetched now when
// missing, again when older than FIELD_DEFS_MAX_AGE. Resolves once the missing
// ones are in; an old copy is used while its refresh runs.
function touchModelObjects(names) {
  const waits = [];
  for (const name of new Set((names || []).filter(Boolean).map((x) => String(x).toLowerCase()))) {
    const o = modelObject(name);
    if (!o) continue;
    if (!o.checkedAt) waits.push(refreshModelObject(o.name));
    else if (isStale(o.checkedAt, FIELD_DEFS_MAX_AGE) || o.checkedAt < sync.modelForcedAt) refreshModelObject(o.name);
  }
  return Promise.all(waits);
}

// After objects change: save before long, and repaint what shows them.
let modelPaintTimer = null;
const modelPaintNames = new Set();
function modelChanged(name, save = true) {
  if (save) scheduleModelSave();
  if (name) modelPaintNames.add(name);
  else modelPaintNames.add("*");
  if (modelPaintTimer) return;
  modelPaintTimer = setTimeout(() => {
    modelPaintTimer = null;
    const names = [...modelPaintNames];
    modelPaintNames.clear();
    paintModelCounts();
    paintSync();
    if (!state.dataModel || dmSearch.value.trim()) return;
    // The list is redrawn only when it shows a changed object, so a click
    // isn't lost to a redraw it had nothing to do with.
    if (dmAllObjects || names.includes("*") || names.includes(dmSelected)) renderDataModelTree("");
    else dmObjects.innerHTML = dmChipsHtml();
  }, 400);
}

let modelSaveTimer = null;
function scheduleModelSave(delay = 10000) {
  // One already waiting saves these changes too, unless this one is sooner.
  if (modelSaveTimer && delay > 0) return;
  clearTimeout(modelSaveTimer);
  modelSaveTimer = setTimeout(saveModelNow, delay);
}

async function saveModelNow() {
  clearTimeout(modelSaveTimer);
  modelSaveTimer = null;
  const domain = state.domain;
  if (!domain || !state.dataModel) return;
  try {
    // Another view may have saved objects this one hasn't fetched.
    const stored = await readVaultCache("dataModels", domain);
    if (domain !== state.domain || !state.dataModel) return;
    if (stored?.model) mergeModel(state.dataModel, normalizeModel(stored.model, stored.time));
    dataModelTime = new Date().toISOString();
    await saveVaultCache("dataModels", domain, { model: state.dataModel, time: dataModelTime });
  } catch (e) {
    sync.modelError = `not saved for next time: ${e.message}`;
    paintSync();
  }
}

// Leaving with a save pending would cost the next view those fetches.
window.addEventListener("pagehide", () => {
  if (modelSaveTimer) saveModelNow();
  if (typesSaveTimer) saveDocTypes();
});

// ↻ beside the Data model title: the list again, and every object fetched
// again in the background, the ones in use first.
dmRefresh.addEventListener("click", async () => {
  if (!state.sessionId || sync.modelListing) return;
  sync.fast = true;
  await takeSyncLease();
  await syncModelList(true);
  touchModelObjects([dmSelected, vqlShape(vqlInput.value).target]);
});

// The Data model's age line: what's loading, or how old the oldest object is.
function paintModelSync() {
  const objs = state.dataModel?.objects || [];
  const total = objs.length;
  const done = objs.filter((o) => !modelDue(o)).length;
  const filling = !!state.sessionId && total > 0 && done < total;
  let text = "";
  if (!state.sessionId) text = "";
  else if (sync.modelError) text = `couldn't check: ${sync.modelError}`;
  else if (sync.modelListing && state.dataModel) text = sync.fast ? "refreshing…" : "checking…";
  else if (filling) {
    text = `${sync.modelForcedAt ? "refreshing" : "loading"} fields ${done.toLocaleString()} of ${total.toLocaleString()}` +
      (sync.waiting ? " · waiting for the vault's rate limit" : "");
  }
  else if (total) text = `checked ${ageText(Math.min(...objs.map((o) => o.checkedAt)))}`;
  dmSync.textContent = text;
  dmSync.classList.toggle("error", !!sync.modelError);
  dmSync.title = sync.modelListAt ? `Object list checked ${ageText(sync.modelListAt)}.` : "";
  dmRefresh.disabled = !state.sessionId;
  dmRefresh.classList.toggle("spinning", !!state.sessionId && sync.fast && (sync.modelListing || filling));
  dmSyncBar.classList.toggle("hidden", !filling);
  dmSyncBar.firstElementChild.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  if (!state.dataModel) {
    dmEmptyState.innerHTML = !state.sessionId
      ? "Connect to a Vault to see its data model."
      : sync.modelError
        ? `Couldn't load the data model: ${esc(sync.modelError)} <button type="button" class="sync-retry" data-retry="model">Try again</button>`
        : "Loading the data model…";
  }
}

dmEmptyState.addEventListener("click", (e) => {
  if (e.target.closest('[data-retry="model"]')) syncModelList();
});

function paintSync() {
  paintModelSync();
  paintTypesSync();
  paintAccessSync();
}

// ===================== PER-USER FIELD ACCESS =====================
// Vault's /objects/users/me/permissions says which object fields THIS user can
// read. We load it per vault (cached and reloadable, like the data model) and
// hide the fields a user can't read from autocomplete and "insert all fields",
// so a query is never built with a field Vault would refuse. Config metadata
// lists every field regardless of who's asking; this is the per-user truth.
let accessMap = new Map();     // objLower -> Set(deniedFieldLower)
let accessTime = null;
let accessLoading = false;
let accessError = null;
let accessForced = false;
let accessHadRows = false;     // the response carried permission rows at all

function accessDenied(objName, fieldName) {
  if (!objName || !fieldName) return false;
  const set = accessMap.get(String(objName).toLowerCase());
  return !!set && set.has(String(fieldName).toLowerCase());
}

// name__v arrives as object.{obj}.object_actions and, for a field,
// object.{obj}.field.{field}.field_actions (some vaults drop the literal
// "field." segment). We record only read:false FIELD rows — a field we never
// hear about stays visible, so a name format we don't recognise hides nothing
// rather than hiding everything.
const ACCESS_FIELD_RE = /^object\.([^.]+)\.(?:field\.)?([^.]+)\.field_actions$/i;
function parseAccessRows(rows) {
  const denied = new Map();
  let fieldRowsSeen = 0;
  const unmatched = [];
  for (const row of rows || []) {
    const name = String(row?.name__v || "");
    if (!name.startsWith("object.")) continue;
    if (/\.object_actions$/i.test(name)) continue;
    const m = ACCESS_FIELD_RE.exec(name);
    if (!m) { unmatched.push(name); continue; }
    fieldRowsSeen++;
    if (row?.permissions?.read === false) {
      const obj = m[1].toLowerCase();
      if (!denied.has(obj)) denied.set(obj, new Set());
      denied.get(obj).add(m[2].toLowerCase());
    }
  }
  // Vault sent object-field rows but none matched: the field-name format
  // differs from what we expect. Say so loudly so it gets fixed, rather than
  // silently filtering nothing.
  if (!fieldRowsSeen && unmatched.length) {
    console.warn("[access] no field permission rows matched; sample names:", unmatched.slice(0, 5));
  }
  return { denied, fieldRowsSeen };
}

function serializeAccess(map) {
  const out = {};
  for (const [obj, set] of map) out[obj] = [...set];
  return out;
}
function deserializeAccess(obj) {
  const map = new Map();
  for (const [k, arr] of Object.entries(obj || {})) map.set(k, new Set(arr));
  return map;
}

async function loadAccessForDomain(domain) {
  accessMap = new Map();
  accessTime = null;
  accessError = null;
  accessForced = false;
  accessHadRows = false;
  const entry = await readVaultCache("access", domain);
  if (entry && entry.denied) {
    accessMap = deserializeAccess(entry.denied);
    accessTime = entry.time || null;
    accessHadRows = entry.hadRows !== false;
  }
  paintAccessSync();
}

async function syncAccess(force = false) {
  if (!state.sessionId || accessLoading) return;
  const epoch = sync.epoch;
  const domain = state.domain;
  accessLoading = true;
  accessError = null;
  if (force) accessForced = true;
  paintAccessSync();
  try {
    const res = await apiCall("/objects/users/me/permissions");
    if (epoch !== sync.epoch || state.domain !== domain) return;
    if (!apiOk(res)) { accessError = apiErr(res); return; }
    const rows = res.data?.data || [];
    const { denied } = parseAccessRows(rows);
    accessMap = denied;
    accessTime = Date.now();
    accessHadRows = rows.length > 0;
    await saveVaultCache("access", domain, { time: accessTime, denied: serializeAccess(denied), hadRows: accessHadRows });
    refreshAfterAccess();
  } finally {
    accessLoading = false;
    if (epoch === sync.epoch) paintAccessSync();
  }
}

// The field lists just changed: repaint the data model tree if it's showing.
function refreshAfterAccess() {
  if (state.dataModel) renderDataModelTree(dmSearch.value.trim().toLowerCase());
}

function paintAccessSync() {
  if (!accessSync) return;
  let text = "";
  if (!state.sessionId) text = "";
  else if (accessError) text = `couldn't load access: ${accessError}`;
  else if (accessLoading) text = accessForced ? "reloading your access…" : "loading your access…";
  else if (accessTime) text = `loaded ${ageText(accessTime)}`;
  accessSync.textContent = text;
  accessSync.classList.toggle("error", !!accessError);
  if (accessRefresh) {
    accessRefresh.disabled = !state.sessionId;
    accessRefresh.classList.toggle("spinning", !!state.sessionId && accessLoading);
  }
}

if (accessRefresh) {
  accessRefresh.addEventListener("click", async () => {
    if (!state.sessionId || accessLoading) return;
    await takeSyncLease();
    await syncAccess(true);
  });
}

function extractFields(res) {
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
  }));
}

// ---- Relationships ------------------------------------------------------------
// The metadata fetchModelObject already fetches carries every relationship: an
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

function showFields(rows) {
  return (rows || []).map((f) => ({
    name: f.name,
    label: f.label || "",
    type: f.type || "unknown",
    required: false,
    editable: false,
    queryable: true,
  }));
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
// autocomplete and lookups only; editing still goes by the model.
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
  if (liveTargets) return liveTargets.some((t) => t.name.toLowerCase() === n);
  return /__[a-z]+$/.test(n) || PLAIN_TARGETS.has(n);
}

// Whether an object still has to be asked about before it can be suggested
// from: a plausible name, not already known with its relationships, not
// already asked about.
function needsLookup(name, trusted = false) {
  if (!name || !state.sessionId || !/^[a-z_][a-z0-9_]*$/i.test(name)) return false;
  const n = String(name).toLowerCase();
  // An object the model lists is fetched into the model, once.
  const m = modelObject(n);
  if (m) return !m.checkedAt && !modelPending.has(n);
  if (liveObjects.has(n) || liveObjectsPending.has(n)) return false;
  return trusted || plausibleTarget(n);
}

async function fetchObjectInfo(n) {
  if (apiAtLeast("v25.2")) {
    const [fields, rels] = await Promise.all([
      showQuery(`SHOW FIELDS FROM ${n}`),
      showQuery(`SHOW RELATIONSHIPS FROM ${n}`),
    ]);
    if (fields || rels) return { name: n, label: "", fields: showFields(fields), relationships: showRelationships(rels) };
  }
  const res = await apiCall(n === "documents" ? "/metadata/objects/documents/properties" : `/metadata/vobjects/${encodeURIComponent(n)}`);
  if (!apiOk(res)) return null;
  return { name: n, label: res.data?.object?.label || "", fields: extractFields(res), relationships: extractRelationships(res).own };
}

// Looks the objects up (once each); resolves when all have answered.
function ensureObjects(names) {
  const unique = [...new Set(names.filter(Boolean).map((x) => String(x).toLowerCase()))];
  const jobs = [touchModelObjects(unique.filter((n) => modelObject(n)))];
  for (const name of unique) {
    if (modelObject(name)) continue;
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
  picklistNamePending.clear();
  picklistValueSets.clear();
  objectRecordSets.clear();
  dtSectionLabels = null;
  dtPickResults.clear();
  dtFresh.clear();
  liveObjects.clear();
  liveObjectsPending.clear();
  liveTargets = null;
  liveTargetsPending = null;
}

// When the model on screen was loaded, so a save echoed back by
// storage.onChanged can be told from one made by another view.
let dataModelTime = null;

// timeStr: the saved copy this model is, when it came from storage.
function onDataModelLoaded(timeStr) {
  if (!state.dataModel) return;
  if (timeStr !== undefined) dataModelTime = timeStr || null;
  paintModelCounts();
  paintSync();
  renderDataModelTree(dmSearch.value.trim().toLowerCase());
  // Untitled tabs are named after their object's label, which only the model has.
  if (WINDOW_MODE) renderQueryTabs();
}

function paintModelCounts() {
  const objs = state.dataModel?.objects || [];
  const fieldCount = objs.reduce((n, o) => n + o.fields.length, 0);
  dmCounts.textContent = `${objs.length.toLocaleString()} objects · ${fieldCount.toLocaleString()} fields`;
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
// Every chip has an x: an everyday one taken off stays off until it is opened
// again. Both lists are kept per vault.
const DM_EXTRA_CHIPS = 4;
const dmChipsKey = (domain) => `dmChips:${domain}`;

let dmSelected = null;    // the object on show
let dmView = "fields";    // fields | out (lookups) | in (child relationships)
let dmAllObjects = false; // the list of every object is showing instead
let dmExtra = [];         // chip objects beyond the defaults
let dmHidden = [];        // everyday objects taken off the row
let dmFromSeen = null;    // the FROM object the panel last followed
let dmShown = DM_PAGE;
let dmLastKey = "";       // what the list showed last, to keep its scroll

function dmResetView() {
  dmSelected = null;
  dmView = "fields";
  dmAllObjects = false;
  dmExtra = [];
  dmHidden = [];
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

// The everyday objects this vault has, and those of them still on the row.
function dmDefaults() {
  const out = [];
  for (const want of DM_DEFAULT_OBJECTS) {
    const o = modelObject(want);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

function dmFeatured() {
  return dmDefaults().filter((o) => !dmHidden.includes(o.name));
}

// What the editor is querying, else what last ran.
function dmQueryObject() {
  return modelObject(vqlShape(vqlInput.value).target) || modelObject(vqlShape(lastRunQuery).target);
}

async function loadDmChips(domain) {
  if (!domain) return;
  const key = dmChipsKey(domain);
  const saved = (await chrome.storage.local.get(key))[key] || {};
  const names = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === "string") : []);
  dmExtra = names(saved.recent).slice(-DM_EXTRA_CHIPS);
  dmHidden = names(saved.hidden);
}

function saveDmChips() {
  if (state.domain) chrome.storage.local.set({ [dmChipsKey(state.domain)]: { recent: dmExtra, hidden: dmHidden } });
}

function dmPin(name) {
  if (dmDefaults().some((o) => o.name === name)) {
    // Opening an everyday object puts its chip back.
    if (!dmHidden.includes(name)) return;
    dmHidden = dmHidden.filter((n) => n !== name);
    saveDmChips();
    return;
  }
  if (dmExtra[dmExtra.length - 1] === name) return;
  dmExtra = dmExtra.filter((n) => n !== name);
  dmExtra.push(name);
  while (dmExtra.length > DM_EXTRA_CHIPS) {
    dmExtra.splice(dmExtra.findIndex((n) => n !== dmSelected), 1);
  }
  saveDmChips();
}

// The x on a chip. Taking off the object on show moves to the first chip left,
// else the list of all objects.
function dmUnpin(name) {
  if (dmDefaults().some((o) => o.name === name)) {
    if (!dmHidden.includes(name)) dmHidden.push(name);
  } else {
    dmExtra = dmExtra.filter((n) => n !== name);
  }
  saveDmChips();
  if (dmSelected !== name) return;
  const next = dmFeatured()[0] || modelObject(dmExtra[dmExtra.length - 1]);
  dmSelected = next ? next.name : null;
  dmView = "fields";
  dmAllObjects = !next;
}

function dmSelect(name, view = "fields") {
  const obj = modelObject(name);
  if (!obj) return;
  dmSelected = obj.name;
  dmView = view;
  dmAllObjects = false;
  dmPin(obj.name);
  touchModelObjects([obj.name]);
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
  const denied = accessDenied(objName, f.name);
  const tip = [f.label && f.label !== f.name ? f.label : "", type, f.required ? "required" : "", denied ? "you don't have read access" : ""]
    .filter(Boolean)
    .join(" · ");
  const labelHit =
    filter && f.label && !f.name.toLowerCase().includes(filter) && f.label.toLowerCase().includes(filter);
  return (
    `<button type="button" class="dm-row${labelHit ? " label-hit" : ""}${denied ? " dm-row-denied" : ""}" data-field="${esc(f.name)}" ` +
    `data-obj="${esc(objName)}" title="${esc(`${tip}. Click to insert, ⇧-click to add to SELECT.`)}">` +
    (denied ? '<span class="dm-row-lock" aria-label="no read access">🔒</span>' : "") +
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
      `<span class="dm-ochip dm-ochip-obj${on ? " on" : ""}">` +
      `<button type="button" class="dm-ochip-pick" data-pick="${esc(o.name)}" aria-pressed="${on}" title="${esc(o.name)}">` +
      `${esc(o.label || o.name)} <span class="dm-n">${(o.fields?.length || 0).toLocaleString()}</span></button>` +
      `<button type="button" class="dm-ochip-x" data-unpin="${esc(o.name)}" title="Remove From Row" ` +
      `aria-label="${esc(`Remove ${o.label || o.name}`)}">&times;</button></span>`;
  }
  const total = state.dataModel.objects.length;
  h +=
    `<button type="button" class="dm-ochip dm-ochip-all${dmAllObjects ? " on" : ""}" data-all="1" ` +
    `aria-pressed="${dmAllObjects}" title="List Every Object">All objects <span class="dm-n">${total.toLocaleString()}</span></button>`;
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
    btn.title = count[v] == null ? "Not Loaded Yet" : "";
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
    h += `<div class="dm-section" title="Query Targets that are not Vault Objects, from SHOW TARGETS">Other query targets · ${targets.length.toLocaleString()}</div>`;
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
  if (dmView === "fields" && (!obj.checkedAt || (obj.fetchError && !obj.fields.length))) {
    html = obj.checkedAt
      ? `<div class="dm-empty">Couldn't load ${esc(obj.name)}: ${esc(obj.fetchError)}</div>`
      : `<div class="dm-empty">Loading the fields of ${esc(obj.label || obj.name)}…</div>`;
    dmShowing.textContent = "";
  } else if (dmView === "fields") {
    const ranked = [...obj.fields].sort(fieldRanker(obj));
    html = ranked.map((f) => fieldRowHtml(f, obj.name, "")).join("") ||
      `<div class="dm-empty">No fields known for ${esc(obj.name)}.</div>`;
    // "Insert all fields" inserts only the readable ones; count those.
    const readable = obj.fields.filter((f) => !accessDenied(obj.name, f.name)).length;
    const hidden = obj.fields.length - readable;
    dmInsertAll.textContent = `Insert all ${readable.toLocaleString()} fields`;
    dmInsertAll.title = hidden
      ? `Replace the query with SELECT of every field FROM ${obj.name} you can read (${hidden} hidden — no read access)`
      : `Replace the query with SELECT of every field FROM ${obj.name}`;
    dmInsertAll.classList.toggle("hidden", !readable);
    dmShowing.textContent = hidden ? `${hidden} field${hidden === 1 ? "" : "s"} hidden — no read access` : "";
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
  const obj = modelObject(objName);
  if (!obj || !obj.fields.length) return;
  // Only the fields this user can read — a SELECT that named one they can't
  // would make Vault refuse the whole query.
  const readable = obj.fields.filter((f) => !accessDenied(obj.name, f.name));
  if (!readable.length) return;
  const fieldList = readable.map((f) => `    ${f.name}`).join(",\n");
  insertIntoQuery(`SELECT\n${fieldList}\nFROM ${obj.name}`, true);
}

// A keyboard click rebuilt what held the focus; put it back on the same thing.
function dmRefocus(e, sel) {
  if (e.detail !== 0) return;
  const el = dmPanel.querySelector(sel);
  if (el) el.focus();
}

dmObjects.addEventListener("click", (e) => {
  const x = e.target.closest("[data-unpin]");
  if (x) {
    dmUnpin(x.dataset.unpin);
    renderDataModelTree("");
    dmRefocus(e, "#dm-objects .dm-ochip-all");
    return;
  }
  const chip = e.target.closest("[data-pick], [data-all]");
  if (!chip) return;
  if (chip.dataset.all) {
    // A second click goes back to the object on show.
    dmAllObjects = !dmAllObjects || !dmSelected;
  } else {
    const same = chip.dataset.pick === dmSelected && !dmAllObjects;
    dmSelect(chip.dataset.pick, same ? dmView : "fields");
  }
  renderDataModelTree("");
  dmRefocus(e, chip.dataset.all ? "#dm-objects .dm-ochip-all" : `#dm-objects [data-pick="${CSS.escape(chip.dataset.pick)}"]`);
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
    dmRefocus(e, `#dm-objects [data-pick="${CSS.escape(pick.dataset.pick)}"]`);
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
  const obj = modelObject(objName);
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
      const matched = target.fields.filter((f) => f.name.toLowerCase().includes(rest) && !accessDenied(target.name, f.name));
      matched.sort(fieldRanker(target));
      for (const f of matched) push(fieldItem(f, `${raw.slice(0, dot + 1)}${f.name}`));
    }
  } else {
    if (obj) {
      scheduleFieldStats(obj.name);
      const matched = obj.fields.filter((f) => f.name.toLowerCase().includes(word) && !accessDenied(obj.name, f.name));
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

// Read-only by default. Editing is a deliberate per-session arming (re-locks on
// reload), and every save is confirmed in a dialog that names the vault.
let editMode = false;

// A vault that doesn't look like a sandbox gets the stricter save confirmation.
function isProductionVault() {
  return !/sandbox|-sb(\b|[.\-])|-val(\b|[.\-])|\bdev\b|\btest\b|demo|training|-uat|preprod|-qa(\b|[.\-])/i.test(state.domain || "");
}
function vaultShortName() {
  return (state.domain || "").split(".")[0];
}

const editLock = $("#edit-lock");
function setEditMode(on) {
  editMode = on;
  editLock?.classList.toggle("armed", on);
  editLock?.setAttribute("aria-pressed", String(on));
  const label = $("#edit-lock-label");
  if (label) label.textContent = on ? "Editing" : "Read-only";
  if (editLock) {
    editLock.title = on
      ? "Editing armed — each save is confirmed. Click to lock."
      : "Read-only — click to enable editing.";
  }
  document.body.classList.toggle("edit-armed", on);
  // Locking discards any unsaved edits (they were never written).
  if (!on && Object.keys(pendingEdits).length) {
    pendingEdits = {};
    updateSaveBar();
  }
  // Re-render so cells reflect the new mode.
  if (WINDOW_MODE) { paintResultsView(); renderInspector(); }
  else if (queryRows.length) paintPanelPage();
}
editLock?.addEventListener("click", () => setEditMode(!editMode));

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
  if (props.redacted.has(k)) return "Redacted for User on Record.";
  if (props.hidden.has(k)) return "Hidden from User on Record.";
  if (!props.canEdit) return "User Does Not Have Edit Permission on Record.";
  if (props.edit && !props.edit.has(k)) return "This Record is Read-Only for User.";
  return "";
}

function cellEditable(ri, key, editable) {
  if (!editMode) return false;   // read-only by default
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
  const tip = `Related records (${key}).`;
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
  let why = columnLockReason(key) || cellLockReason(ri, key);
  // A normally-editable cell is locked only because the panel is read-only.
  if (!why && !editMode) why = "Read-only — unlock editing (top right) to change";
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
    const obj = modelObject(objectName);
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

  // The panel pages too: a fetch-all query can return thousands of rows.
  resultsView.page = 0;
  paintPanelPage();
}

// The panel's table: RESULTS_PAGE rows of queryRows at a time, under the same
// range and Prev/Next as the full window's footer. Row numbers stay those of
// queryRows, so edits on one page are still pending on another.
function paintPanelPage() {
  const rows = queryRows;
  const keys = resultKeys;
  const pages = Math.max(1, Math.ceil(rows.length / RESULTS_PAGE));
  resultsView.page = Math.min(Math.max(0, resultsView.page), pages - 1);
  const start = resultsView.page * RESULTS_PAGE;
  const end = Math.min(rows.length, start + RESULTS_PAGE);
  const editableFields = getEditableFields(queryObjectName);
  const hasId = keys.includes("id");
  let html = '<table class="results-table"><thead><tr>';
  for (const key of keys) {
    const isId = key === "id";
    html += `<th class="${isId ? "col-id" : ""}"${columnHeaderAttr(key)}>${esc(key)}</th>`;
  }
  html += "</tr></thead><tbody>";

  for (let ri = start; ri < end; ri++) {
    const row = rows[ri];
    html += `<tr data-row="${ri}">`;
    for (const key of keys) {
      const val = row[key];
      if (isSubValue(val)) {
        html += subCellHtml(ri, key, val);
        continue;
      }
      const edit = pendingEdits[`${ri}:${key}`];
      const display = edit ? edit.newVal : displayValue(val);
      const isId = key === "id";
      const canEdit = hasId && cellEditable(ri, key, editableFields);

      if (canEdit) {
        // An edit made before paging away and back still shows, marked.
        html += `<td class="editable${edit ? " dirty" : ""}" data-row="${ri}" data-field="${esc(key)}" title="Click to Edit">${esc(display)}</td>`;
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

  // Which cells edit is decided per cell; the hint only needs id in the SELECT.
  if (hasId) {
    html += '<div class="edit-hint">Click editable cells to modify values</div>';
  } else {
    html += '<div class="edit-hint">Include <b>id</b> in your SELECT to enable inline editing</div>';
  }

  resultsContainer.innerHTML = html;

  resultsFooter.classList.toggle("paged", pages > 1);
  resultsRange.textContent = `Showing ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${rows.length.toLocaleString()}`;
  pagePrev.disabled = resultsView.page === 0;
  pageNext.disabled = resultsView.page >= pages - 1;

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
    paintPanelPage();
  }
  updateSaveBar();
});

// Save changes — group edits by row, send one PUT per row. Only ever reached
// through the confirmation dialog (openSaveConfirm).
async function performSave() {
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

  try {
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

      if (apiOk(result)) {
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
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = "Save Changes";
  }
  updateSaveBar();
  if (WINDOW_MODE) renderInspector();

  if (errors.length > 0) {
    showSaveError(errors.join("\n"));
  }
}

// ---- The explicit ask before any write ----
const scScrim = $("#save-confirm");
const scVault = $("#sc-vault");
const scList = $("#sc-list");
const scType = $("#sc-type");
const scTypeInput = $("#sc-type-input");
const scSave = $("#sc-save");

function closeSaveConfirm() {
  scScrim.classList.add("hidden");
}

function openSaveConfirm() {
  const edits = Object.values(pendingEdits);
  if (!edits.length) return;
  if (!queryObjectName) {
    showSaveError("Could not detect object name from query. Make sure your query has a FROM clause.");
    return;
  }
  scVault.textContent = state.domain || "this vault";
  const prod = isProductionVault();
  scVault.classList.toggle("prod", prod);
  scList.innerHTML = edits
    .map((e) => {
      const row = queryRows[e.rowIdx] || {};
      const rec = esc(row.id || `row ${e.rowIdx + 1}`);
      const name = row.name__v ? ` · ${esc(String(row.name__v))}` : "";
      const old = e.oldVal === null || e.oldVal === undefined || e.oldVal === "" ? "(empty)" : esc(String(e.oldVal));
      const neu = e.newVal === null || e.newVal === undefined || e.newVal === "" ? "(empty)" : esc(String(e.newVal));
      return `<div class="sc-chg"><div class="sc-rec">${rec}${name}</div>` +
        `<div class="sc-fld"><b>${esc(e.field)}</b> &nbsp;<span class="sc-old">${old}</span> → <span class="sc-new">${neu}</span></div></div>`;
    })
    .join("");
  const n = edits.length;
  scSave.textContent = `Save ${n} change${n !== 1 ? "s" : ""}`;
  // Production vaults: require typing the vault name.
  scType.classList.toggle("hidden", !prod);
  if (prod) { $("#sc-type-name").textContent = vaultShortName(); scTypeInput.value = ""; }
  scSave.disabled = prod;
  scScrim.classList.remove("hidden");
  (prod ? scTypeInput : $("#sc-cancel")).focus();
}

if (scScrim) {
  saveBtn.addEventListener("click", openSaveConfirm);
  $("#sc-cancel").addEventListener("click", closeSaveConfirm);
  scScrim.addEventListener("click", (e) => { if (e.target === scScrim) closeSaveConfirm(); });
  scTypeInput.addEventListener("input", () => { scSave.disabled = scTypeInput.value.trim() !== vaultShortName(); });
  scSave.addEventListener("click", () => { if (scSave.disabled) return; closeSaveConfirm(); performSave(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !scScrim.classList.contains("hidden")) closeSaveConfirm();
  });
}

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
  clearTimeout(errDiv.removeTimer);
  errDiv.removeTimer = setTimeout(() => errDiv.remove(), 8000);
}

// ===================== DOC TYPES =====================
// Two calls to enumerate: list the types, then follow each type's own link to
// get its properties[] — Vault has no page-layout endpoint, so the field set
// comes back as part of the type.
const dtLayout = $("#dt-layout");
const dtEmpty = $("#dt-empty");
const dtSync = $("#dt-sync");
const dtRefresh = $("#dt-refresh");
const dtSyncBar = $("#dt-sync-bar");
const dtTree = $("#dt-tree");
const dtBreadcrumb = $("#dt-breadcrumb");
const dtFields = $("#dt-fields");

const DT_BATCH = 3;          // counts at a time

let docTypes = [];
let docTypesTime = null;     // the saved copy the types on screen are
let dtSelected = null;

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

// The type list is read the first time the tab opens in a session (one call),
// and kept types keep their fields and counts. Types never fetched are filled
// in the background; clicking a type fetches it at once. Counts refresh while
// the tab is open once they're over a day old. ↻ forces all of it.
const dtPending = new Map();      // type name -> the fetch in flight
let typesPaintTimer = null;
let typesSaveTimer = null;

function dtTabActive() {
  return $("#tab-doctypes").classList.contains("active");
}

function onDocTypesShown() {
  if (!state.sessionId) return paintSync();
  // The type list is needed either way (product mode drills into it).
  if (!sync.typesListAt && !sync.typesListing && !sync.typesError) syncTypeList();
  else maybeCountTypes();
  if (dtGroupBy === "product") ensureProducts();
}

// Saved types made ready: when each was fetched and counted. Earlier versions
// saved everything at once, so their types count as fetched then.
function normalizeTypes(types, savedAt) {
  const t = Date.parse(savedAt || "") || CHECKED_LONG_AGO;
  for (const x of types || []) {
    if (x.checkedAt === undefined) x.checkedAt = x.properties ? t : null;
    if (x.countedAt === undefined) x.countedAt = x.docCount != null ? t : null;
  }
  return types;
}

// The newer fields and the newer count of each type another view saved.
function mergeTypes(into, from) {
  const theirs = new Map((from || []).map((t) => [t.name, t]));
  let changed = 0;
  for (const t of into) {
    const o = theirs.get(t.name);
    if (!o) continue;
    if ((o.checkedAt || 0) > (t.checkedAt || 0)) {
      Object.assign(t, { properties: o.properties, subtypes: o.subtypes || [], error: o.error || null, checkedAt: o.checkedAt });
      changed++;
    }
    if ((o.countedAt || 0) > (t.countedAt || 0)) {
      Object.assign(t, { docCount: o.docCount ?? null, countError: o.countError || null, countedAt: o.countedAt });
      changed++;
    }
  }
  return changed;
}

async function syncTypeList(force = false) {
  if (!state.sessionId || sync.typesListing) return;
  const epoch = sync.epoch;
  sync.typesListing = true;
  sync.typesError = null;
  paintSync();
  try {
    const res = await apiCall("/metadata/objects/documents/types");
    if (epoch !== sync.epoch) return;
    if (!apiOk(res)) {
      sync.typesError = apiErr(res);
      return;
    }
    const prev = new Map(docTypes.map((t) => [t.name, t]));
    const types = (res.data?.types || []).map((raw) => {
      const link = raw.value || "";
      const tail = link.split("/").pop() || "";
      const name = raw.name || tail;
      const label = raw.label || tail || "(unnamed)";
      const old = prev.get(name);
      if (old) return Object.assign(old, { label, link });
      return { label, name, link, properties: null, subtypes: [], error: null, docCount: null, countError: null, checkedAt: null, countedAt: null };
    });
    // ↻: every count is due, and every type is fetched again; what's there
    // stays on screen meanwhile.
    if (force) {
      sync.typesForcedAt = Date.now();
      dtFresh.clear();
    }
    sync.typesListAt = Date.now();
    if (!types.length) {
      clearDocTypes();
      return;
    }
    applyDocTypes(types, docTypesTime);
    scheduleTypesSave(0);
    queueTypeFill();
  } finally {
    sync.typesListing = false;
    if (epoch === sync.epoch) {
      paintSync();
      maybeCountTypes();
    }
  }
}

function queueTypeFill() {
  const due = typeDue;
  for (const t of docTypes.filter(due)) {
    syncEnqueue({
      key: `type:${t.name}`,
      needed: () => docTypes.includes(t) && due(t) && !dtPending.has(t.name),
      run: () => fetchDocType(t),
    });
  }
}

// One type, by the link Vault handed back (Retrieve Document Type): its
// fields and subtypes as the vault has them now.
function fetchDocType(type) {
  if (dtPending.has(type.name)) return dtPending.get(type.name);
  const path = vaultPath(type.link);
  if (!path || !state.sessionId) {
    if (!path) type.error = "type link missing or points off-domain";
    return Promise.resolve();
  }
  const epoch = sync.epoch;
  const job = apiCall(path)
    .then((res) => {
      if (epoch !== sync.epoch) return;
      type.checkedAt = Date.now();
      if (!apiOk(res)) {
        if (!type.properties) type.error = apiErr(res);
        return;
      }
      dtFresh.add(type.name);
      type.properties = res.data?.properties || [];
      type.subtypes = res.data?.subtypes || type.subtypes || [];
      type.error = null;
      for (const key of [...dtPickResults.keys()]) if (key.startsWith(`${type.name}|`)) dtPickResults.delete(key);
      if (dtSelected === type) showDocTypeFields(type);
    })
    .catch(() => {})
    .finally(() => {
      dtPending.delete(type.name);
      if (epoch === sync.epoch) typesChanged();
    });
  dtPending.set(type.name, job);
  return job;
}

// Counts, while the tab is open: those over a day old, or never taken. Most
// records first is the list's order, so the biggest types settle first.
function maybeCountTypes() {
  if (dtGroupBy !== "type") return paintSync();   // product mode counts per product, not per type
  if (!dtTabActive() || sync.counting || !docTypes.length || !state.sessionId) return paintSync();
  const due = docTypes
    .filter(countDue)
    .sort((a, b) => (b.docCount ?? -1) - (a.docCount ?? -1));
  if (due.length) runCounts(due);
  else paintSync();
}

async function runCounts(due) {
  const epoch = sync.epoch;
  const started = Date.now();
  Object.assign(sync, { counting: true, countDone: 0, countTotal: due.length });
  paintSync();
  try {
    for (let i = 0; i < due.length; i += DT_BATCH) {
      // Leaving the tab stops counting; opening it again picks up the rest.
      if (epoch !== sync.epoch || !dtTabActive() || budgetLow()) break;
      await Promise.all(due.slice(i, i + DT_BATCH).map(countDocType));
      if (epoch !== sync.epoch) return;
      sync.countDone = Math.min(due.length, i + DT_BATCH);
      typesChanged();
    }
  } finally {
    if (epoch === sync.epoch) {
      sync.counting = false;
      typesChanged();
      // ↻ pressed while this run was going: count again what it counted first.
      if (sync.typesForcedAt > started) maybeCountTypes();
    }
  }
}

// One query per type: SELECT id FROM documents WHERE TONAME(type__v) =
// '<name>'. By name, not label: labels are translated into each user's
// language and can be renamed, which Veeva's VQL reference gives as the reason
// to filter with TONAME(). responseDetails.total carries the full count, so
// PAGESIZE 1 keeps the payload tiny. A failed recount keeps the old figure.
async function countDocType(t) {
  const count = (where) =>
    apiCall("/query", "POST", `q=${encodeURIComponent(`SELECT id FROM documents WHERE ${where} PAGESIZE 1`)}`);
  let res = t.name ? await count(`TONAME(type__v) = '${vqlStr(t.name)}'`) : null;
  // A type whose API name Vault won't match this way still gets a count by label.
  if (!apiOk(res)) res = await count(`type__v = '${vqlStr(t.label)}'`);
  if (apiOk(res)) {
    const reported = Number(res.data?.responseDetails?.total);
    t.docCount = Number.isFinite(reported) ? reported : (res.data?.data || []).length;
    t.countError = null;
    t.countedAt = Date.now();
  } else {
    t.countError = apiErr(res);
  }
}

function typesChanged() {
  scheduleTypesSave();
  if (typesPaintTimer) return;
  typesPaintTimer = setTimeout(() => {
    typesPaintTimer = null;
    renderDocTypeList();
    paintSync();
  }, 300);
}

function scheduleTypesSave(delay = 3000) {
  if (typesSaveTimer && delay > 0) return;
  clearTimeout(typesSaveTimer);
  typesSaveTimer = setTimeout(() => {
    typesSaveTimer = null;
    saveDocTypes();
  }, delay);
}

dtRefresh.addEventListener("click", async () => {
  if (!state.sessionId || sync.typesListing) return;
  sync.fast = true;
  await takeSyncLease();
  syncTypeList(true);
});

dtEmpty.addEventListener("click", (e) => {
  if (e.target.closest('[data-retry="types"]')) syncTypeList();
});

// The Doc Types age line: counting, or how old the oldest count is.
function paintTypesSync() {
  const counted = docTypes.filter((t) => t.countedAt);
  const failed = docTypes.filter((t) => t.countError);
  let text = "";
  if (!state.sessionId || !docTypes.length) text = "";
  else if (sync.typesListing) text = sync.fast ? "refreshing…" : "checking…";
  else if (sync.counting) text = `${sync.typesForcedAt ? "recounting" : "counting"} ${sync.countDone} of ${sync.countTotal}`;
  else if (sync.typesError) text = `couldn't check: ${sync.typesError}`;
  else if (counted.length) {
    text = `counted ${ageText(Math.min(...counted.map((t) => t.countedAt)))}` + (failed.length ? ` · ${failed.length} failed` : "");
  }
  dtSync.textContent = text;
  dtSync.classList.toggle("error", !!sync.typesError || (!sync.counting && failed.length > 0));
  dtSync.title =
    "Record Counts Per Document Type" +
    (failed.length ? ` Not counted: ${failed.map((t) => `${t.label} (${t.countError})`).join(", ")}.` : "");
  dtRefresh.disabled = !state.sessionId;
  dtRefresh.classList.toggle("spinning", !!state.sessionId && sync.fast && (sync.typesListing || sync.counting));
  dtSyncBar.classList.toggle("hidden", !sync.counting);
  dtSyncBar.firstElementChild.style.width = `${sync.countTotal ? Math.round((sync.countDone / sync.countTotal) * 100) : 0}%`;
  if (!docTypes.length) {
    dtEmpty.innerHTML = !state.sessionId
      ? "Connect to a Vault to see its document types."
      : sync.typesError
        ? `Couldn't list document types: ${esc(sync.typesError)} <button type="button" class="sync-retry" data-retry="types">Try again</button>`
        : sync.typesListAt && !sync.typesListing
          ? "This vault has no document types."
          : "Loading document types…";
  }
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
  renderDocTypeList();
  dtLayout.classList.remove("hidden");
  dtEmpty.classList.add("hidden");
  // A type that was open stays open if it's still there.
  if (keep) {
    dtTree.querySelector(`.dt-node[data-name="${CSS.escape(keep)}"] .dt-node-header`)?.click();
  }
  paintSync();
}

// Only what the Doc Types pane reads. Raw properties carry much more,
// and across every type of a large vault that runs to megabytes of storage.
const DT_KEEP_PROPS = [
  "name", "label", "type", "required", "editable", "repeating", "hidden", "disabled", "scope",
  "section", "section__v", "sectionPosition", "section_position", "order",
  // A picklist field's values as this type lists them: the fallback when
  // the picklist API can't be asked.
  "entryNames", "entryLabels", "picklist",
  // The object a reference field points at, for listing its records.
  "objectType",
  // Who fills a field: Vault's own, pre-filled, or queryable at all.
  "systemAttribute", "defaultValue", "queryable", "setOnCreateOnly",
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
    checkedAt: t.checkedAt ?? null,
    countedAt: t.countedAt ?? null,
  };
}

// Returns the error when the save fails; the types stay loaded in this view
// either way.
async function saveDocTypes() {
  const domain = state.domain;
  if (!domain || !docTypes.length) return null;
  try {
    // Another view may have fetched or counted types this one hasn't.
    const stored = await readVaultCache("docTypeCache", domain);
    if (domain !== state.domain || !docTypes.length) return null;
    if (stored?.types?.length) mergeTypes(docTypes, normalizeTypes(stored.types, stored.time));
    docTypesTime = new Date().toISOString();
    await saveVaultCache("docTypeCache", domain, {
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
  if (entry?.types?.length) applyDocTypes(normalizeTypes(entry.types, entry.time), entry.time);
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
  paintSync();
}

// ---- Drill a type's count into subtypes and classifications ----------------
// Vault nests documents as type → subtype → classification. The type list shows
// type totals; expanding a row fetches the level below (structure from metadata,
// counts one filtered query each, since VQL has no GROUP BY) and caches it for
// the session. Nothing here runs until a row is opened.
const DT_CARET =
  '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const dtExpanded = new Set();     // type names opened
const dtSubExpanded = new Set();  // `${type}|${sub}` opened
const dtDrillCount = new Map();   // node id -> number
const dtDrillErr = new Map();     // node id -> error string
const dtDrillPending = new Set(); // node ids being counted
const dtClasses = new Map();      // `${type}|${sub}` -> { state, error, list:[{name,label,value}] }

const subId = (type, sub) => `${type}|${sub}`;
const classId = (type, sub, cls) => `${type}|${sub}|${cls}`;

// Subtypes and classifications come back as {label, value} with no name — the
// API name is the last segment of the value URL (…/subtypes/advertisement__c),
// just as the type list derives its own name. Fill it in so every consumer can
// read node.name.
function docNodeName(x) {
  return x.name || (String(x.value || x.link || "").split("/").pop()) || "";
}
function normalizeSubtypes(t) {
  for (const s of t.subtypes || []) if (!s.name) s.name = docNodeName(s);
}

function drillCountCell(id) {
  if (dtDrillErr.has(id)) return '<span class="dt-type-count failed" title="count failed">!</span>';
  if (dtDrillCount.has(id)) {
    const n = dtDrillCount.get(id);
    return `<span class="dt-type-count counted dt-drill-count t${countTier(n)}">${esc(compactCount(n))}</span>`;
  }
  return '<span class="dt-type-count dt-drill-count loading">…</span>';
}

function renderDrillChildren(t) {
  normalizeSubtypes(t);
  const subs = t.subtypes || [];
  if (!t.checkedAt && !subs.length) return '<div class="dt-children"><div class="dt-drill-empty">Loading subtypes…</div></div>';
  if (!subs.length) return '<div class="dt-children"><div class="dt-drill-empty">No subtypes</div></div>';
  let h = '<div class="dt-children">';
  for (const s of subs) {
    const sk = subId(t.name, s.name);
    const open = dtSubExpanded.has(sk);
    const cls = dtClasses.get(sk);
    const canTwist = !cls || cls.state === "loading" || (cls.list && cls.list.length > 0) || open;
    h += `<div class="dt-sub" data-sub="${esc(s.name)}">`;
    h += `<div class="dt-sub-row">`;
    h += canTwist ? `<span class="dt-twist${open ? " open" : ""}">${DT_CARET}</span>` : '<span class="dt-twist leaf"></span>';
    h += `<span class="dt-sub-label">${esc(s.label || s.name)}</span><span class="dt-tier">sub</span>`;
    h += drillCountCell(sk);
    h += `</div>`;
    if (open) {
      h += '<div class="dt-subchildren">';
      if (!cls || cls.state === "loading") h += '<div class="dt-drill-empty">Loading classifications…</div>';
      else if (cls.state === "error") h += `<div class="dt-drill-empty">Couldn't load: ${esc(cls.error)}</div>`;
      else if (!cls.list.length) h += '<div class="dt-drill-empty">No classifications</div>';
      else for (const c of cls.list) {
        const ck = classId(t.name, s.name, c.name);
        h += `<div class="dt-class-row"><span class="dt-twist leaf"></span>` +
          `<span class="dt-sub-label">${esc(c.label || c.name)}</span><span class="dt-tier">class</span>${drillCountCell(ck)}</div>`;
      }
      h += "</div>";
    }
    h += "</div>";
  }
  return h + "</div>";
}

// One filtered query per node, read from responseDetails.total, a few at a time.
async function drillCountBatch(items) {
  for (let i = 0; i < items.length; i += DT_BATCH) {
    const batch = items.slice(i, i + DT_BATCH).filter((it) => !dtDrillPending.has(it.id));
    if (!batch.length) continue;
    batch.forEach((it) => dtDrillPending.add(it.id));
    await Promise.all(batch.map(async (it) => {
      const q = `SELECT id FROM documents WHERE ${it.where.join(" AND ")} PAGESIZE 1`;
      const res = await apiCall("/query", "POST", `q=${encodeURIComponent(q)}`);
      const total = Number(res.data?.responseDetails?.total);
      if (apiOk(res) && Number.isFinite(total)) {
        // The real figure comes from responseDetails.total; the page itself holds
        // at most one row (PAGESIZE 1), so never fall back to its length.
        dtDrillCount.set(it.id, total);
        dtDrillErr.delete(it.id);
      } else {
        dtDrillErr.set(it.id, apiOk(res) ? "no count returned" : apiErr(res));
      }
      dtDrillPending.delete(it.id);
    }));
    renderDocTypeList();
  }
}

// Count a set of {id, where} nodes, skipping any already counted.
function queueCounts(items) {
  const todo = items.filter((it) => !dtDrillCount.has(it.id));
  if (todo.length) drillCountBatch(todo);
}

function countSubtypes(t) {
  normalizeSubtypes(t);
  queueCounts((t.subtypes || [])
    .filter((s) => s.name)
    .map((s) => ({
      id: subId(t.name, s.name),
      where: [`TONAME(type__v) = '${vqlStr(t.name)}'`, `TONAME(subtype__v) = '${vqlStr(s.name)}'`],
    })));
}

async function loadClasses(t, sub) {
  const key = subId(t.name, sub.name);
  const cur = dtClasses.get(key);
  if (cur && (cur.state === "loading" || cur.state === "done")) return;
  const path = vaultPath(sub.value || sub.link);
  if (!path) { dtClasses.set(key, { state: "done", list: [] }); return; }
  dtClasses.set(key, { state: "loading", list: [] });
  renderDocTypeList();
  const res = await apiCall(path);
  if (apiOk(res)) {
    dtClasses.set(key, {
      state: "done",
      list: (res.data?.classifications || []).map((c) => ({ name: docNodeName(c), label: c.label, value: c.value })),
    });
  } else {
    dtClasses.set(key, { state: "error", error: apiErr(res), list: [] });
  }
  renderDocTypeList();
}

function countClasses(t, sub) {
  const list = dtClasses.get(subId(t.name, sub.name))?.list || [];
  queueCounts(list.map((c) => ({
    id: classId(t.name, sub.name, c.name),
    where: [
      `TONAME(type__v) = '${vqlStr(t.name)}'`,
      `TONAME(subtype__v) = '${vqlStr(sub.name)}'`,
      `TONAME(classification__v) = '${vqlStr(c.name)}'`,
    ],
  })));
}

async function toggleTypeDrill(t) {
  if (dtExpanded.has(t.name)) { dtExpanded.delete(t.name); renderDocTypeList(); return; }
  dtExpanded.add(t.name);
  renderDocTypeList();
  if (!t.checkedAt) await fetchDocType(t);   // populates t.subtypes
  if (!dtExpanded.has(t.name)) return;       // collapsed again while fetching
  renderDocTypeList();
  countSubtypes(t);
}

async function toggleSubDrill(t, sub) {
  const key = subId(t.name, sub.name);
  if (dtSubExpanded.has(key)) { dtSubExpanded.delete(key); renderDocTypeList(); return; }
  dtSubExpanded.add(key);
  renderDocTypeList();
  await loadClasses(t, sub);
  if (!dtSubExpanded.has(key)) return;       // collapsed again while loading
  countClasses(t, sub);
}

// ---- Group documents by product (a field), not just by type -----------------
// Type/subtype/classification is a fixed tree; product is a field on the
// document, so it's a parallel axis. The group-by control pivots the count list.
// Counts reuse drillCountBatch; product nodes are namespaced with a "P|" prefix.
// Product is multi-value, so these counts can overlap (a doc with two products
// is counted under both).
let dtGroupBy = "type";          // "type" | "product"
let dtProducts = [];             // [{id, name}]
let dtProductsState = "idle";    // idle | loading | done | error
let dtProductsError = "";
let dtProdFilter = "";
const prodExpanded = new Set();      // product ids open
const prodTypeExpanded = new Set();  // `${prodId}|${typeName}` open
const P = "P";
const pId = (prod) => `${P}|${prod}`;
const ptId = (prod, type) => `${P}|${prod}|${type}`;
const ptsId = (prod, type, sub) => `${P}|${prod}|${type}|${sub}`;

function setGroupBy(gb) {
  if (dtGroupBy === gb) return;
  dtGroupBy = gb;
  for (const b of document.querySelectorAll("#dt-groupby .dt-sort-opt")) {
    const on = b.dataset.gb === gb;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  document.getElementById("dt-prod-filter-wrap")?.classList.toggle("hidden", gb !== "product");
  renderDocTypeList();
  paintSync();
  if (gb === "product") ensureProducts();
  else maybeCountTypes();
}

async function ensureProducts() {
  if (!state.sessionId) return;
  if (dtProductsState === "done") { countProducts(); return; }
  if (dtProductsState === "loading") return;
  dtProductsState = "loading";
  renderDocTypeList();
  const q = "SELECT id, name__v FROM product__v ORDER BY name__v ASC MAXROWS 1000";
  const res = await apiCall("/query", "POST", `q=${encodeURIComponent(q)}`);
  if (dtGroupBy !== "product") return;   // switched away while loading
  if (apiOk(res)) {
    dtProducts = (res.data?.data || []).map((r) => ({ id: r.id, name: r.name__v || r.id }));
    dtProductsState = "done";
  } else {
    dtProductsError = apiErr(res);
    dtProductsState = "error";
  }
  renderDocTypeList();
  if (dtProductsState === "done") countProducts();
}

function filteredProducts() {
  const f = dtProdFilter.trim().toLowerCase();
  return f ? dtProducts.filter((p) => p.name.toLowerCase().includes(f)) : dtProducts;
}

function countProducts() {
  queueCounts(filteredProducts()
    .map((p) => ({ id: pId(p.id), where: [`product__v = '${vqlStr(p.id)}'`] })));
}

function countProductTypes(p) {
  queueCounts(docTypes
    .filter((t) => t.name)
    .map((t) => ({ id: ptId(p.id, t.name), where: [`product__v = '${vqlStr(p.id)}'`, `TONAME(type__v) = '${vqlStr(t.name)}'`] })));
}

function countProductTypeSubs(p, t) {
  normalizeSubtypes(t);
  queueCounts((t.subtypes || [])
    .filter((s) => s.name)
    .map((s) => ({
      id: ptsId(p.id, t.name, s.name),
      where: [`product__v = '${vqlStr(p.id)}'`, `TONAME(type__v) = '${vqlStr(t.name)}'`, `TONAME(subtype__v) = '${vqlStr(s.name)}'`],
    })));
}

function toggleProduct(p) {
  if (prodExpanded.has(p.id)) { prodExpanded.delete(p.id); renderDocTypeList(); return; }
  prodExpanded.add(p.id);
  renderDocTypeList();
  countProductTypes(p);   // one count per vault type, filtered by this product
}

async function toggleProductType(p, t) {
  const key = `${p.id}|${t.name}`;
  if (prodTypeExpanded.has(key)) { prodTypeExpanded.delete(key); renderDocTypeList(); return; }
  prodTypeExpanded.add(key);
  renderDocTypeList();
  if (!t.checkedAt) await fetchDocType(t);   // needs the type's subtypes metadata
  if (!prodTypeExpanded.has(key)) return;
  renderDocTypeList();
  countProductTypeSubs(p, t);
}

// Within a product, show only the types/subtypes that actually have documents;
// the rest are noise. Rows order by count, biggest first.
function renderProductChildren(p) {
  let h = '<div class="dt-children">';
  const typed = docTypes.filter((t) => t.name);
  const counted = typed.filter((t) => (dtDrillCount.get(ptId(p.id, t.name)) || 0) > 0);
  const pending = typed.some((t) => !dtDrillCount.has(ptId(p.id, t.name)) && !dtDrillErr.has(ptId(p.id, t.name)));
  if (!counted.length) return h + `<div class="dt-drill-empty">${pending ? "Counting types…" : "No documents for this product"}</div></div>`;
  counted.sort((a, b) => (dtDrillCount.get(ptId(p.id, b.name)) || 0) - (dtDrillCount.get(ptId(p.id, a.name)) || 0));
  for (const t of counted) {
    const tk = `${p.id}|${t.name}`;
    const open = prodTypeExpanded.has(tk);
    normalizeSubtypes(t);
    const canTwist = !t.checkedAt || (t.subtypes?.length > 0) || open;
    h += `<div class="dt-sub" data-ptype="${esc(t.name)}">`;
    h += `<div class="dt-sub-row">`;
    h += canTwist ? `<span class="dt-twist${open ? " open" : ""}">${DT_CARET}</span>` : '<span class="dt-twist leaf"></span>';
    h += `<span class="dt-sub-label">${esc(t.label || t.name)}</span><span class="dt-tier">type</span>`;
    h += drillCountCell(ptId(p.id, t.name));
    h += `</div>`;
    if (open) {
      h += '<div class="dt-subchildren">';
      const subs = (t.subtypes || []).filter((s) => s.name);
      if (!t.checkedAt && !subs.length) h += '<div class="dt-drill-empty">Loading subtypes…</div>';
      else if (!subs.length) h += '<div class="dt-drill-empty">No subtypes</div>';
      else {
        const sc = subs.filter((s) => (dtDrillCount.get(ptsId(p.id, t.name, s.name)) || 0) > 0);
        const sp = subs.some((s) => !dtDrillCount.has(ptsId(p.id, t.name, s.name)) && !dtDrillErr.has(ptsId(p.id, t.name, s.name)));
        if (!sc.length) h += `<div class="dt-drill-empty">${sp ? "Counting subtypes…" : "No documents in a subtype"}</div>`;
        else {
          sc.sort((a, b) => (dtDrillCount.get(ptsId(p.id, t.name, b.name)) || 0) - (dtDrillCount.get(ptsId(p.id, t.name, a.name)) || 0));
          for (const s of sc) {
            h += `<div class="dt-class-row"><span class="dt-twist leaf"></span>` +
              `<span class="dt-sub-label">${esc(s.label || s.name)}</span><span class="dt-tier">sub</span>${drillCountCell(ptsId(p.id, t.name, s.name))}</div>`;
          }
        }
      }
      h += "</div>";
    }
    h += "</div>";
  }
  return h + "</div>";
}

function renderProductTree() {
  if (dtProductsState === "error") {
    dtTree.innerHTML = `<div class="dm-empty">Couldn't load products: ${esc(dtProductsError)}</div>`;
    return;
  }
  if (dtProductsState !== "done" && !dtProducts.length) {
    dtTree.innerHTML = '<div class="dt-drill-empty">Loading products…</div>';
    return;
  }
  const list = filteredProducts();
  if (!list.length) {
    dtTree.innerHTML = `<div class="dt-drill-empty">${dtProducts.length ? "No products match." : "This vault has no products."}</div>`;
    return;
  }
  let h = "";
  for (const p of list) {
    const open = prodExpanded.has(p.id);
    h += `<div class="dt-node" data-prod="${esc(p.id)}">`;
    h += `<div class="dt-node-header">`;
    h += `<span class="dt-twist${open ? " open" : ""}">${DT_CARET}</span>`;
    h += '<span class="dt-node-icon">&#128230;</span>';
    h += `<span class="dt-node-label">${esc(p.name)}</span>`;
    h += drillCountCell(pId(p.id));
    h += `</div>`;
    if (open) h += renderProductChildren(p);
    h += `</div>`;
  }
  dtTree.innerHTML = h;
}

function renderDocTypeList() {
  if (dtGroupBy === "product") return renderProductTree();
  // Most records first once counted (types not counted go last), A-Z for ties
  // and before any count. No toggle: one fixed order.
  const ordered = [...docTypes].sort(
    (a, b) => (b.docCount ?? -1) - (a.docCount ?? -1) || a.label.localeCompare(b.label)
  );

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
      // Over a day old: faded until this tab recounts it.
      const stale = countDue(t) ? " stale" : "";
      cell =
        `<span class="dt-type-count counted t${countTier(t.docCount)}${stale}">` +
        `${esc(compactCount(t.docCount))}</span>`;
    } else if (t.countError) {
      cell = '<span class="dt-type-count failed">!</span>';
    } else {
      // Not counted yet: the quiet field tally, as before.
      const fieldCount = t.error ? "!" : t.properties ? String(t.properties.length) : "–";
      cell = `<span class="dt-type-count">${esc(fieldCount)}</span>`;
    }

    // A twist shows while subtypes are unknown (optimistic) or when there are
    // some; a type confirmed to have none loses it.
    const canTwist = !t.checkedAt || (t.subtypes?.length > 0) || dtExpanded.has(t.name);
    const open = dtExpanded.has(t.name);

    html += `<div class="dt-node" data-name="${esc(t.name)}">`;
    html += `<div class="dt-node-header${dtSelected?.name === t.name ? " selected" : ""}" title="${esc(tip)}">`;
    html += canTwist ? `<span class="dt-twist${open ? " open" : ""}">${DT_CARET}</span>` : '<span class="dt-twist leaf"></span>';
    html += `<span class="dt-node-icon">&#128196;</span>`;
    html += `<span class="dt-node-label">${esc(t.label)}</span>`;
    if (t.docCount == null && !t.countError) html += `<span class="dt-node-sublabel">${esc(t.name)}</span>`;
    html += cell;
    html += `</div>`;
    if (open) html += renderDrillChildren(t);
    html += `</div>`;
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

dtTree.addEventListener("click", (e) => {
  if (dtGroupBy === "product") { handleProductClick(e); return; }
  const node = e.target.closest(".dt-node");
  const type = node ? docTypes.find((t) => t.name === node.dataset.name) : null;
  if (!type) return;

  const twist = e.target.closest(".dt-twist:not(.leaf)");
  const subRowEl = e.target.closest(".dt-sub");
  const sub = subRowEl ? (type.subtypes || []).find((s) => s.name === subRowEl.dataset.sub) : null;

  // A subtype row (its caret or its body) opens its classifications.
  if (sub && (twist || e.target.closest(".dt-sub-row"))) { toggleSubDrill(type, sub); return; }
  // The type's caret opens its subtypes.
  if (twist) { toggleTypeDrill(type); return; }
  // Classification rows are display-only for now.
  if (e.target.closest(".dt-class-row")) return;

  // Otherwise the type header selects it for the fields panel (unchanged).
  const header = e.target.closest(".dt-node-header");
  if (!header) return;
  dtTree.querySelectorAll(".dt-node-header.selected").forEach((h) => h.classList.remove("selected"));
  header.classList.add("selected");
  dtSelected = type;
  showDocTypeFields(type);
  refreshDocType(type);
});

// Clicks in product mode: a product opens its types; a type opens its subtypes.
function handleProductClick(e) {
  const node = e.target.closest(".dt-node[data-prod]");
  if (!node) return;
  const p = dtProducts.find((x) => x.id === node.dataset.prod);
  if (!p) return;
  const typeRow = e.target.closest(".dt-sub[data-ptype]");
  const twist = e.target.closest(".dt-twist:not(.leaf)");
  if (typeRow) {
    const t = docTypes.find((x) => x.name === typeRow.dataset.ptype);
    if (t && (twist || e.target.closest(".dt-sub-row"))) toggleProductType(p, t);
    return;
  }
  if (twist || e.target.closest(".dt-node-header")) toggleProduct(p);
}

// The group-by control and the product filter.
for (const b of document.querySelectorAll("#dt-groupby .dt-sort-opt")) {
  b.addEventListener("click", () => setGroupBy(b.dataset.gb));
}
$("#dt-prod-filter")?.addEventListener("input", (e) => {
  dtProdFilter = e.target.value;
  renderProductTree();
  countProducts();   // count whatever the filter now shows
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

const DT_FILTERS = { all: "All Fields", user: "User Fields" };

// Who fills a field, read from its definition alone: Vault (a system field
// the user can't edit, a formula or lookup, or read-only for this user),
// Vault first (a default value people may change), or people. Read-only can
// also be this user's access, so the tooltip says why.
function dtFillTag(p) {
  const t = String(p.type || "");
  if (/^(formula|lookup)$/i.test(t)) return { tag: "system", why: `${t.charAt(0).toUpperCase()}${t.slice(1).toLowerCase()} Field` };
  if (p.systemAttribute === true && p.editable === false) return { tag: "system", why: "Vault Managed Field" };
  if (p.editable === false) return { tag: "system", why: "Read-Only for User" };
  const def = Array.isArray(p.defaultValue) ? p.defaultValue.join(", ") : p.defaultValue;
  if (def != null && def !== "") return { tag: "default", why: "Default Value" };
  return { tag: "people", why: p.systemAttribute ? "Vault Standard Field" : "Vault Custom Field" };
}

// Not fieldRowHtml: that is the data model's row builder, and a second
// top-level function of the same name silently replaces the first everywhere.
// The layout list: plain fields stay quiet, picklists stand out with a preview
// of their values and a count; clicking one opens its values under the row.
function dtFieldRowHtml(p) {
  const name = esc(p.name || "");
  const req = p.required === true ? '<span class="dt-field-req" aria-label="required">*</span>' : "";
  const fill = dtFillTag(p);
  const group = fill.tag === "system" ? "system" : "user";
  const tip = [p.name, wbTypeLabel(p.type), p.required ? "required" : "", p.editable === false ? "read-only" : "",
    p.repeating ? "several values" : "", p.hidden ? "hidden" : "", p.scope || "", fill.why].filter(Boolean).join(" · ");
  if (isValueListProp(p)) {
    const ref = refObjectOf(p);
    return (
      `<div class="dt-field-row dt-pick${ref ? " dt-ref" : ""}" data-fname="${name}" data-tag="${group}" role="button" tabindex="0" aria-expanded="false" ` +
      `title="${esc(tip)}${ref ? ` → ${ref}` : ""} — click to show its ${ref ? "records" : "values"}">` +
      `<span class="dt-field-label">${esc(p.label || p.name || "")}</span>${req}` +
      `<span class="dt-field-name">${name}</span>` +
      `<span class="dt-pick-count"><span class="dt-pick-n"></span>` +
      '<svg class="dt-pick-caret" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></span></div>'
    );
  }
  return (
    `<div class="dt-field-row" data-fname="${name}" data-tag="${group}" title="${esc(tip)}">` +
    `<span class="dt-field-label">${esc(p.label || p.name || "")}</span>${req}` +
    `<span class="dt-field-name">${name}</span></div>`
  );
}

// ---- Picklist values ----------------------------------------------------------
// A picklist's values come from the type's own metadata (entryNames and
// entryLabels) when it carries them, else from Retrieve Picklist Values
// (GET /objects/picklists/{name}). Document fields don't name their picklist,
// so one describe query names every picklist on the type first. Each picklist
// on screen is loaded in the background, a few at a time, so its row can show
// a count and a preview before it is opened.
const picklistNames = new Map();     // document field -> picklist name, or null
const picklistValueSets = new Map(); // picklist -> Promise of { values } or null
const dtPickResults = new Map();     // "type|field" -> { values, source }
const DT_VALUES_FILTER_AT = 12;
const DT_PICK_CONCURRENCY = 3;

function isPicklistProp(p) {
  return /picklist/i.test(String(p?.type || ""));
}

// The object a reference field points at, as VQL names it. Document fields
// say "User" and "Group" for the system objects.
function refObjectOf(p) {
  if (!/objectreference/i.test(String(p?.type || ""))) return null;
  const t = String(p.objectType || "").trim().toLowerCase();
  if (!t) return null;
  const name = { user: "user__sys", group: "group__sys" }[t] || t;
  return /^[a-z_][a-z0-9_]*$/i.test(name) ? name : null;
}

function isValueListProp(p) {
  return isPicklistProp(p) || !!refObjectOf(p);
}

// A reference field's choices are its object's records: one query per object,
// shared by every field and type pointing at it, A-Z by name, capped. Status
// marks the inactive ones; an object without status__v is asked again without.
const DT_RECORD_LIMIT = 500;
const objectRecordSets = new Map(); // object -> Promise of { values, total } or null

async function dtQueryRows(q) {
  const res = await apiCall("/query", "POST", `q=${encodeURIComponent(q)}`);
  if (!apiOk(res)) return null;
  const rows = res.data?.data || [];
  return { rows, total: res.data?.responseDetails?.total ?? rows.length };
}

function loadObjectRecords(obj) {
  if (!objectRecordSets.has(obj)) {
    objectRecordSets.set(obj, (async () => {
      const tail = `FROM ${obj} ORDER BY name__v ASC MAXROWS ${DT_RECORD_LIMIT}`;
      const got = (await dtQueryRows(`SELECT id, name__v, status__v ${tail}`)) || (await dtQueryRows(`SELECT id, name__v ${tail}`));
      if (!got) return null;
      return {
        total: got.total,
        values: got.rows.map((row) => {
          const st = Array.isArray(row.status__v) ? row.status__v[0] : row.status__v;
          return {
            name: String(row.id ?? ""),
            label: row.name__v != null ? String(row.name__v) : String(row.id ?? ""),
            inactive: !!st && !/^active__v$/i.test(String(st)),
          };
        }),
      };
    })());
  }
  return objectRecordSets.get(obj);
}

const VQL_NAME_RE = /^[a-z_][a-z0-9_]*$/i;

async function describePicklists(fields) {
  const res = await apiCall(
    "/query", "POST",
    `q=${encodeURIComponent(`SELECT ${fields.join(", ")} FROM documents MAXROWS 1`)}`,
    { "X-VaultAPI-DescribeQuery": "true" }
  );
  if (!apiOk(res)) return null;
  const out = new Map();
  for (const f of res.data?.queryDescribe?.fields || []) {
    if (f?.name) out.set(String(f.name).toLowerCase(), f.picklist || null);
  }
  return out;
}

// Names the picklists behind several fields with one query. A field the query
// can't take (hidden from this user, say) fails the lot, so then each field is
// asked about on its own. Fields already being asked about wait for that.
const picklistNamePending = new Map(); // field -> the lookup in flight

async function picklistNamesFor(fields) {
  const open = [...new Set(fields)].filter((f) => VQL_NAME_RE.test(f) && !picklistNames.has(f));
  const waits = open.filter((f) => picklistNamePending.has(f)).map((f) => picklistNamePending.get(f));
  const want = open.filter((f) => !picklistNamePending.has(f));
  if (want.length) {
    const job = (async () => {
      const all = await describePicklists(want);
      if (all) {
        for (const f of want) picklistNames.set(f, all.get(f.toLowerCase()) ?? null);
        return;
      }
      for (const f of want) {
        const one = await describePicklists([f]);
        picklistNames.set(f, one?.get(f.toLowerCase()) ?? null);
      }
    })();
    for (const f of want) picklistNamePending.set(f, job);
    job.finally(() => {
      for (const f of want) picklistNamePending.delete(f);
    });
    waits.push(job);
  }
  await Promise.all(waits);
}

async function picklistNameFor(field) {
  if (!picklistNames.has(field)) await picklistNamesFor([field]);
  return picklistNames.get(field) ?? null;
}

async function loadPicklistValues(prop) {
  const ref = refObjectOf(prop);
  if (ref) {
    const set = await loadObjectRecords(ref);
    return set
      ? { values: set.values, total: set.total, records: true, source: `object ${ref}` }
      : { values: null, records: true, source: "" };
  }
  const fromType = Array.isArray(prop.entryNames)
    ? prop.entryNames.map((n, i) => ({ name: n, label: prop.entryLabels?.[i] ?? "" }))
    : null;
  const pick = prop.picklist || (fromType ? null : await picklistNameFor(prop.name));
  if (pick) {
    // One request per picklist, shared by every field and view asking for it.
    if (!picklistValueSets.has(pick)) {
      picklistValueSets.set(
        pick,
        apiCall(`/objects/picklists/${encodeURIComponent(pick)}`).then((res) =>
          apiOk(res) && Array.isArray(res.data?.picklistValues)
            ? {
                values: res.data.picklistValues.map((v) => ({ name: v.name, label: v.label || "" })),
              }
            : null
        )
      );
    }
    const set = await picklistValueSets.get(pick);
    if (set) return { values: set.values, source: `picklist ${pick}` };
  }
  if (fromType) return { values: fromType, source: "this type's metadata" };
  return { values: null, source: "" };
}

function dtPickKey(type, field) {
  return `${type?.name || ""}|${field}`;
}

async function pickResultFor(type, prop) {
  const key = dtPickKey(type, prop.name);
  if (!dtPickResults.has(key)) dtPickResults.set(key, loadPicklistValues(prop));
  return dtPickResults.get(key);
}

// The row's count and one-line preview, once its values are known.
function paintPickRow(row, result) {
  const n = row.querySelector(".dt-pick-n");
  if (!n) return;
  row.classList.remove("loading");
  if (!result.values) {
    n.textContent = "?";
    row.title = `${row.dataset.fname} — Vault didn't return values for this field`;
    return;
  }
  const count = result.records ? result.total ?? result.values.length : result.values.length;
  n.textContent = result.records ? compactCount(count) : String(count);
  // Nothing to show: the row stays, with its 0, but no longer opens.
  if (!count) {
    row.classList.add("dt-pick-empty");
    row.removeAttribute("role");
    row.removeAttribute("tabindex");
    row.removeAttribute("aria-expanded");
    row.title = `${row.dataset.fname} — no ${result.records ? "records" : "values"}`;
    if (row.nextElementSibling?.classList.contains("dt-values")) row.nextElementSibling.remove();
  }
}

// Loads every picklist on the shown type, a few at a time, painting each row
// as it arrives. Names first, in one query, for those the type doesn't list.
async function loadTypePicklists(type) {
  const rows = [...dtFields.querySelectorAll(".dt-pick")];
  if (!rows.length) return;
  const props = new Map((type.properties || []).map((p) => [p.name, p]));
  for (const row of rows) row.classList.add("loading");
  const needNames = rows
    .map((r) => props.get(r.dataset.fname))
    .filter((p) => p && isPicklistProp(p) && !p.picklist && !Array.isArray(p.entryNames))
    .map((p) => p.name);
  if (needNames.length) await picklistNamesFor(needNames);

  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const row = rows[i++];
      const prop = props.get(row.dataset.fname) || { name: row.dataset.fname };
      const result = await pickResultFor(type, prop);
      if (dtSelected !== type) return;
      const live = dtFields.querySelector(`.dt-pick[data-fname="${CSS.escape(row.dataset.fname)}"]`);
      if (live) paintPickRow(live, result);
    }
  };
  await Promise.all(Array.from({ length: DT_PICK_CONCURRENCY }, worker));
}

function renderDtValues(box, result, prop) {
  const vals = result.values;
  if (!vals) {
    box.innerHTML = '<div class="dt-values-head">Vault didn\'t return values for this field.</div>';
    return;
  }
  if (!vals.length) {
    box.innerHTML = `<div class="dt-values-head">${result.records ? "No records" : "No active values"} · ${esc(result.source)}</div>`;
    return;
  }
  const total = result.total ?? vals.length;
  // A record list cut short says so; otherwise the chips say enough.
  const capped = result.records && total > vals.length
    ? `First ${vals.length.toLocaleString()} of ${total.toLocaleString()} records`
    : "";
  // Long lists: how many on the left, the filter on the right. Typing turns
  // the count into "12 of 64 users".
  const ref = refObjectOf(prop);
  const noun = !result.records ? "values" : ref === "user__sys" ? "users" : ref === "group__sys" ? "groups" : "records";
  const top = vals.length > DT_VALUES_FILTER_AT
    ? `<div class="dt-values-top" data-noun="${noun}" data-total="${vals.length}">` +
      `<span class="dt-values-count">${esc(capped || `${vals.length.toLocaleString()} ${noun}`)}</span>` +
      '<label class="dt-values-filter-wrap">' +
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>' +
      `<input type="search" class="dt-values-filter" placeholder="Filter ${vals.length} ${noun}" aria-label="Filter ${noun}" spellcheck="false" /></label></div>` +
      '<div class="dt-values-none" hidden></div>'
    : capped ? `<div class="dt-values-head">${esc(capped)}</div>` : "";
  box.innerHTML =
    top +
    '<div class="dt-values-list">' +
    vals
      .map(
        (v) =>
          `<button type="button" class="dt-value${v.inactive ? " inactive" : ""}" data-name="${esc(v.name)}" ` +
          `title="Copy ${esc(v.name)}${v.inactive ? " · inactive" : ""}">` +
          `<span class="dt-value-label">${esc(v.label || v.name)}</span></button>`
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
  const type = dtSelected;
  const prop = (type?.properties || []).find((x) => x.name === field) || { name: field };
  const result = await pickResultFor(type, prop);
  paintPickRow(row, result);
  if (box.isConnected) renderDtValues(box, result, prop);
}

function showDocTypeFields(type) {
  dtBreadcrumb.innerHTML =
    '<span class="dt-bc-item">Documents</span>' +
    ' <span class="dt-bc-sep">&#8250;</span> ' +
    `<span class="dt-bc-item">${esc(type.label)}</span>`;

  if (type.error && !type.properties) {
    dtFields.innerHTML = `<div class="dm-empty">Couldn't load this type.<br />${esc(type.error)}</div>`;
    return;
  }

  if (!type.properties) {
    dtFields.innerHTML = '<div class="dm-empty">Loading fields…</div>';
    return;
  }
  const props = type.properties;
  const { onLayout, off, detected } = splitByLayout(props);

  if (!props.length) {
    dtFields.innerHTML = '<div class="dm-empty">This type declares no fields.</div>';
    return;
  }

  // Picklists opened before a re-render (a fresh fetch, say) open again after.
  const reopen = [...dtFields.querySelectorAll('.dt-pick[aria-expanded="true"]')].map((r) => r.dataset.fname);
  let html = "";

  if (!detected) {
    // No placement data, so payload order is the only sequence Vault gives —
    // bar the pinned boilerplate, which still belongs at the end.
    const order = new Map(props.map((p, i) => [p, i]));
    const flat = [...props].sort(
      (a, b) =>
        (isPinnedLast(a.name) ? 1 : 0) - (isPinnedLast(b.name) ? 1 : 0) ||
        order.get(a) - order.get(b)
    );
    // Only what a query can take, as the counts and the QUERY button go.
    type._ordered = flat.filter(dtQueryable);
    html += dtTagBarHtml(type._ordered);
    for (const p of type._ordered) html += dtFieldRowHtml(p);
    dtFields.innerHTML = html;
    finishDocTypeFields(type, reopen);
    return;
  }

  // Group into sections and reproduce the panel's own order: fields by
  // sectionPosition within a section, sections by where they first appear.
  // Fields Vault marks as not queryable (file metadata, sharing roles) are
  // left out, so the list, its counts and the QUERY button agree; a section
  // with none left goes too.
  const groups = new Map();
  for (const p of onLayout) {
    if (!dtQueryable(p)) continue;
    const s = fieldSection(p) || "General";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(p);
  }
  // Fields read in true form order: sectionPosition within the section, then the
  // order Vault returned. Required fields are marked, not reordered — moving them
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
  // General always leads, whatever Vault numbered it; plain "General" before
  // "General Information" and the like.
  const generalRank = (name) => {
    const label = String(sectionLabel(name)).trim().toLowerCase();
    const raw = String(name).toLowerCase();
    if (label === "general" || /^general(__[a-z]+)?$/.test(raw)) return 0;
    return /^general/.test(label) || /^general/.test(raw) ? 1 : 2;
  };
  const sectionNames = [...groups.keys()].sort((a, b) => {
    const general = generalRank(a) - generalRank(b);
    if (general) return general;
    const pinned = (isPinnedLast(a) ? 1 : 0) - (isPinnedLast(b) ? 1 : 0);
    if (pinned) return pinned;
    const pa = Math.min(...groups.get(a).map(fieldSectionPos));
    const pb = Math.min(...groups.get(b).map(fieldSectionPos));
    return pa - pb || sectionFirstSeen.get(a) - sectionFirstSeen.get(b);
  });

  type._ordered = sectionNames.flatMap((n) => groups.get(n));
  html += dtTagBarHtml(type._ordered);

  for (const name of sectionNames) {
    html += '<div class="dt-section">';
    html += `<div class="dt-section-header" data-section="${esc(name)}">${esc(sectionLabel(name))}</div>`;
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
  finishDocTypeFields(type, reopen);
}

function finishDocTypeFields(type, reopen) {
  applyDtTagFilter();
  if (!dtSectionLabels) {
    loadSectionLabels().then(() => {
      for (const h of dtFields.querySelectorAll(".dt-section-header[data-section]")) h.textContent = sectionLabel(h.dataset.section);
    });
  }
  for (const f of reopen) {
    const row = dtFields.querySelector(`.dt-pick[data-fname="${CSS.escape(f)}"]`);
    if (row) toggleDtValues(row);
  }
  loadTypePicklists(type);
}

// ---- Who fills it: filter, then query ----------------------------------------
// Chips filter the layout by tag; "Query these N" writes a query of the
// layout fields showing, in layout order, for this type, and opens it.
let dtTagFilter = "all";
chrome.storage.local.get("dtTagFilter").then((r) => {
  if (DT_FILTERS[r?.dtTagFilter]) dtTagFilter = r.dtTagFilter;
});

// An arrow on the chip: it takes the fields over to a query, it doesn't run one.
const DT_QUERY_ICON =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';

// The fields a query can take: on the layout, not hidden, queryable, a VQL name.
function dtQueryable(p) {
  return p.hidden !== true && p.queryable !== false && /^[a-z_][a-z0-9_]*$/i.test(p.name || "") && p.name !== "id";
}

function dtIsUserField(p) {
  return dtFillTag(p).tag !== "system";
}

// All Fields | User Fields on the left, the query on the right. The counts
// leave out what Vault marks as not queryable (file metadata, sharing roles),
// so each matches the QUERY button in its view.
function dtTagBarHtml(fields) {
  const queryable = fields.filter(dtQueryable);
  const counts = { all: queryable.length, user: queryable.filter(dtIsUserField).length };
  const opt = (key) =>
    `<button type="button" class="dt-sort-opt dt-tagchip" data-tag-filter="${key}" aria-pressed="false">` +
    `${DT_FILTERS[key]} <span class="dt-tagchip-n">${counts[key]}</span></button>`;
  return (
    '<div class="dt-tagbar">' +
    `<div class="dt-sort dt-fill-switch" role="group" aria-label="Show">${opt("all")}${opt("user")}</div>` +
    `<button type="button" class="model-chip dt-query-btn" id="dt-query-btn"><span class="model-chip-label dt-query-label"></span>${DT_QUERY_ICON}</button>` +
    "</div>"
  );
}

// Shows only the rows of the chosen tag; sections left empty fold away.
function applyDtTagFilter() {
  dtFields.dataset.tagFilter = dtTagFilter;
  for (const chip of dtFields.querySelectorAll(".dt-tagchip")) {
    const on = chip.dataset.tagFilter === dtTagFilter;
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  for (const sec of dtFields.querySelectorAll(".dt-section")) {
    const any = [...sec.querySelectorAll(".dt-field-row")].some((r) => dtTagFilter === "all" || r.dataset.tag === "user");
    sec.classList.toggle("dt-section-empty", !any);
  }
  const btn = dtFields.querySelector("#dt-query-btn");
  if (!btn) return;
  const fields = dtQueryFields(dtSelected);
  const n = fields.length;
  btn.querySelector(".dt-query-label").textContent = `QUERY ${n} FIELD${n === 1 ? "" : "S"}`;
  btn.disabled = !n;
  const where = WINDOW_MODE ? "in a new query tab" : "in the editor";
  btn.title = n
    ? `Write SELECT ${n === 1 ? "this field" : `these ${n} fields`} FROM ${dtSelected?.label || "this type"} ${where}`
    : "Non-Queryable Fields";
}

function dtQueryFields(type) {
  return (type?._ordered || []).filter((p) => (dtTagFilter === "all" || dtIsUserField(p)) && dtQueryable(p));
}

// SELECT id, then the fields a line at a time once the line runs long.
function dtBuildQuery(type, fields) {
  const items = ["id", ...fields.map((p) => p.name)];
  const lines = [];
  let line = "SELECT";
  for (let i = 0; i < items.length; i++) {
    const part = `${items[i]}${i < items.length - 1 ? "," : ""}`;
    if (line.length + part.length + 1 > 72 && line.trim() !== "SELECT") {
      lines.push(line);
      line = `  ${part}`;
    } else {
      line += ` ${part}`;
    }
  }
  lines.push(line);
  return `${lines.join("\n")}\nFROM documents\nWHERE TONAME(type__v) = '${vqlStr(type.name)}'`;
}

// A new tab in the full window; in the overlay it takes the editor, asking
// first if there's a query in it.
function openDtQuery() {
  const type = dtSelected;
  const fields = dtQueryFields(type);
  if (!type || !fields.length) return;
  const query = dtBuildQuery(type, fields);
  if (WINDOW_MODE) {
    if (activeQueryToken) {
      alert("A query is still running. Try again when it finishes.");
      return;
    }
    if (vqlInput.value.trim()) newQueryTab();
  } else if (vqlInput.value.trim() && vqlInput.value.trim() !== query && !confirm("Replace the query in the editor?")) {
    return;
  }
  insertIntoQuery(query, true);
  vqlInput.setSelectionRange(0, 0);
  vqlInput.scrollTop = 0;
}

// ---- Fresh fields on click ------------------------------------------------------
// Clicking a type asks Vault for it again (Retrieve Document Type), so the
// layout shown is the vault's now. Once per type per page; the saved copy is
// updated.
const dtFresh = new Set();

// Section headings by their label. The fields name their section; the labels
// are on the field layouts' configuration, one call per vault. Without it (a
// user who can't read configuration, or a built-in section), the name is
// tidied: general__c → General, generalProperties → General Properties.
let dtSectionLabels = null;        // section name (lower case) -> label
let dtSectionLabelsPending = null;

// A name tidied into a heading: no suffix, words split, a trailing "section"
// dropped, title case like Vault's own labels: product_information__c → Product Information.
function prettySection(name) {
  const s = String(name || "")
    .replace(/__[a-z]+$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\s]+/g, " ")
    .replace(/\s+section$/i, "")
    .trim()
    .toLowerCase();
  return s ? s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : String(name || "");
}

// A label as the heading shows it: single-spaced, and not in capitals.
function cleanSectionLabel(label) {
  const s = String(label || "").replace(/\s+/g, " ").trim();
  return s && s === s.toUpperCase() && /[A-Z]{2}/.test(s)
    ? s.toLowerCase().split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
    : s;
}

function sectionLabel(name) {
  return cleanSectionLabel(dtSectionLabels?.get(String(name).toLowerCase())) || prettySection(name);
}

function loadSectionLabels() {
  if (dtSectionLabels) return Promise.resolve(dtSectionLabels);
  if (!dtSectionLabelsPending) {
    dtSectionLabelsPending = apiCall("/configuration/Docfieldlayout")
      .then((res) => {
        const map = new Map();
        if (apiOk(res)) {
          for (const r of res.data?.data || []) if (r?.name && r.label) map.set(String(r.name).toLowerCase(), String(r.label));
        }
        dtSectionLabels = map;
        return map;
      })
      .catch(() => (dtSectionLabels = new Map()))
      .finally(() => {
        dtSectionLabelsPending = null;
      });
  }
  return dtSectionLabelsPending;
}

async function refreshDocType(type) {
  if (dtFresh.has(type.name)) return;
  await fetchDocType(type);
}

dtFields.addEventListener("click", async (e) => {
  const tagChip = e.target.closest(".dt-tagchip");
  if (tagChip) {
    dtTagFilter = tagChip.dataset.tagFilter;
    chrome.storage.local.set({ dtTagFilter });
    applyDtTagFilter();
    return;
  }
  if (e.target.closest("#dt-query-btn")) {
    openDtQuery();
    return;
  }
  const value = e.target.closest(".dt-value");
  if (value) {
    try {
      await navigator.clipboard.writeText(value.dataset.name);
    } catch (err) {
      return;
    }
    // The label says it was copied for a moment, then comes back.
    const label = value.querySelector(".dt-value-label");
    label.dataset.was ??= label.textContent;
    label.textContent = "Copied";
    value.classList.add("copied");
    clearTimeout(value.copiedTimer);
    value.copiedTimer = setTimeout(() => {
      label.textContent = label.dataset.was;
      delete label.dataset.was;
      value.classList.remove("copied");
    }, 1200);
    return;
  }
  const pick = e.target.closest(".dt-pick:not(.dt-pick-empty)");
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
  const pick = e.target.closest?.(".dt-pick:not(.dt-pick-empty)");
  if (pick && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    toggleDtValues(pick);
  }
});

dtFields.addEventListener("input", (e) => {
  const input = e.target.closest(".dt-values-filter");
  if (!input) return;
  const box = input.closest(".dt-values");
  const f = input.value.trim().toLowerCase();
  let shown = 0;
  for (const v of box.querySelectorAll(".dt-value")) {
    v.hidden = !!f && !v.textContent.toLowerCase().includes(f);
    if (!v.hidden) shown++;
  }
  // The count follows the filter; no match says so instead of going blank.
  const top = box.querySelector(".dt-values-top");
  const count = top?.querySelector(".dt-values-count");
  if (count) {
    count.dataset.rest ??= count.textContent;
    count.textContent = f ? `${shown.toLocaleString()} of ${Number(top.dataset.total).toLocaleString()} ${top.dataset.noun}` : count.dataset.rest;
  }
  const none = box.querySelector(".dt-values-none");
  if (none) {
    none.hidden = !(f && !shown);
    none.textContent = `No ${top?.dataset.noun || "values"} match “${input.value.trim()}”`;
  }
});

// ===================== API HELPER =====================
async function apiCall(endpoint, method = "GET", body = null, headers = null, contentType = null) {
  const res = await chrome.runtime.sendMessage({
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
  noteBurst(res?.burst);
  return res;
}

// ---- API download (binary) --------------------------------------------------
// The config report comes back as a ZIP, which runtime messages can't carry, so
// background.js hands it over as base64.
async function apiDownload(endpoint) {
  const res = await chrome.runtime.sendMessage({
    action: "apiDownload",
    domain: state.domain,
    sessionId: state.sessionId,
    version: state.apiVersion,
    endpoint,
  });
  noteBurst(res?.burst);
  return res;
}

function base64ToBlob(b64, type) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: type || "application/octet-stream" });
}


// ---- Configuration Report (whole-vault config export) -----------------------
// Starts Vault's config report job, waits for it, and saves the ZIP locally.
// Named component types are requested, so Vault leaves out the object-data
// (record) workbook. Needs the "Vault Configuration Report" permission.
const CONFIG_REPORT_COMPONENTS = "Doctype,Doclifecycle,Docfield,Object,Objectlifecycle,Picklist";
const CONFIG_REPORT_TERMINAL = ["ERRORS_ENCOUNTERED", "CANCELLED", "TIMEOUT", "MISSED_SCHEDULE"];
let configReportBusy = false;

// ---- Progress: an estimate bar tuned to a typical run ----
// Vault reports no real percentage for this job, so the fill eases toward a
// typical finish and the countdown self-corrects to "almost done" if it runs
// long — never a frozen 99% or a broken promise. The timer ticks every second,
// independent of the 12-second status checks.
const EXPORT_TYPICAL_SECS = 165;
let reportTimer = null;
let reportStartMs = 0;

function fmtClock(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function paintReportProgress() {
  const fill = document.getElementById("export-bar-fill");
  const text = document.getElementById("export-progress-text");
  if (!fill || !text) return;
  const e = (Date.now() - reportStartMs) / 1000;
  const easeOut = (t) => 1 - Math.pow(1 - t, 2.2);
  const w = e < EXPORT_TYPICAL_SECS
    ? easeOut(e / EXPORT_TYPICAL_SECS) * 0.94
    : 0.94 + Math.min(1, (e - EXPORT_TYPICAL_SECS) / EXPORT_TYPICAL_SECS) * 0.05;
  fill.style.width = `${(Math.min(w, 0.99) * 100).toFixed(1)}%`;
  const left = EXPORT_TYPICAL_SECS - e;
  text.className = "export-progress-text";
  text.textContent = left > 6 ? `${fmtClock(e)} · about ${fmtClock(left)} left` : `${fmtClock(e)} · almost done`;
}

function startReportProgress() {
  reportStartMs = Date.now();
  document.getElementById("export-progress")?.classList.remove("hidden", "done");
  document.getElementById("export-spin")?.classList.remove("hidden");
  const fill = document.getElementById("export-bar-fill");
  if (fill) fill.style.width = "0%";
  paintReportProgress();
  clearInterval(reportTimer);
  reportTimer = setInterval(paintReportProgress, 1000);
}

// A quiet finish: the bar fills green, no filename or size — the browser's own
// download already shows that.
function reportDone() {
  clearInterval(reportTimer);
  document.getElementById("export-spin")?.classList.add("hidden");
  const prog = document.getElementById("export-progress");
  const fill = document.getElementById("export-bar-fill");
  const text = document.getElementById("export-progress-text");
  prog?.classList.add("done");
  if (fill) fill.style.width = "100%";
  if (text) text.textContent = "";
  setTimeout(() => { if (!configReportBusy) prog?.classList.add("hidden"); }, 2500);
}

function reportError(msg) {
  clearInterval(reportTimer);
  document.getElementById("export-spin")?.classList.add("hidden");
  const fill = document.getElementById("export-bar-fill");
  const text = document.getElementById("export-progress-text");
  if (fill) fill.style.width = "0%";
  document.getElementById("export-progress")?.classList.remove("hidden", "done");
  if (text) { text.className = "export-progress-text error"; text.textContent = msg; }
}

async function runConfigReport() {
  if (configReportBusy || !state.sessionId) return;
  configReportBusy = true;
  try {
    startReportProgress();
    const start = await apiCall(
      "/objects/vault/actions/configreport",
      "POST",
      `component_types=${encodeURIComponent(CONFIG_REPORT_COMPONENTS)}&output_format=Excel`
    );
    const jobId = start?.data?.job_id;
    if (!apiOk(start) || start.data?.responseStatus !== "SUCCESS" || !jobId) {
      console.warn("[config report] could not start", start);
      // Vault refused (usually no permission) — show why, but leave the control
      // in place. The report is permanently placed.
      reportError(start?.success === true
        ? "Vault wouldn’t start the report — you may not have the Vault Configuration Report permission on this vault."
        : apiErr(start));
      return;
    }
    console.log("[config report] job_id", jobId);

    // Vault allows one status check per job every 10 seconds; the bar is driven
    // by its own 1-second timer meanwhile.
    let job = null, status = "";
    for (let i = 1; i <= 80; i++) {
      await sleep(12000);
      const st = await apiCall(`/services/jobs/${jobId}`);
      job = st?.data?.data || null;
      status = job?.status || "";
      if (status === "SUCCESS") break;
      if (CONFIG_REPORT_TERMINAL.includes(status)) {
        console.warn("[config report] job ended", job);
        reportError(`Job ended: ${status}`);
        return;
      }
    }
    if (status !== "SUCCESS") {
      reportError("Gave up waiting for the job.");
      return;
    }

    // Prefer the download link Vault names on the finished job (its href may be
    // a full vault URL); fall back to the documented report path.
    let endpoint = null;
    for (const link of job?.links || []) {
      if (/report/i.test(link.href || "") || /artifact/i.test(link.rel || "")) {
        endpoint = vaultPath(link.href);   // handles both a full vault URL and a bare path
        if (endpoint) break;
      }
    }
    endpoint = endpoint || `/objects/vault/actions/configreport/${jobId}/report`;
    const dl = await apiDownload(endpoint);
    if (!dl?.success || !dl.base64) {
      console.warn("[config report] download failed", dl, "job links:", job?.links);
      reportError(dl?.error || "Download failed.");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `${(state.domain || "vault").split(".")[0]}-config-${stamp}.zip`;
    downloadBlob(base64ToBlob(dl.base64, dl.contentType || "application/zip"), name);
    reportDone();
  } catch (e) {
    console.error("[config report]", e);
    reportError(e.message || "Something went wrong.");
  } finally {
    configReportBusy = false;
  }
}

// ---- Export menu ------------------------------------------------------------
const exportBtn = document.getElementById("export-btn");
const exportMenu = document.getElementById("export-menu");

function closeExportMenu() {
  // Keep it open while a report is running so its progress stays visible.
  if (configReportBusy) return;
  exportMenu?.classList.add("hidden");
  exportBtn?.setAttribute("aria-expanded", "false");
}

if (exportBtn && exportMenu) {
  exportBtn.addEventListener("click", () => {
    const open = exportMenu.classList.toggle("hidden");
    exportBtn.setAttribute("aria-expanded", String(!open));
  });
  document.getElementById("export-config-report")?.addEventListener("click", () => {
    if (!state.sessionId) { reportError("Connect to a Vault first."); return; }
    runConfigReport();
  });
  document.addEventListener("click", (e) => {
    if (!exportMenu.classList.contains("hidden") && !e.target.closest("#export-wrap")) closeExportMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !exportMenu.classList.contains("hidden")) { closeExportMenu(); exportBtn.focus(); }
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
const resultsFooter = $("#results-footer");
const resultsHint = $("#results-hint");
const pagePrev = $("#page-prev");
const pageNext = $("#page-next");
// The workbench wires these in initWorkbench; the panel here.
if (!WINDOW_MODE) {
  pagePrev.addEventListener("click", () => turnResultsPage(-1));
  pageNext.addEventListener("click", () => turnResultsPage(1));
}
const inspBody = $("#insp-body");
const inspTitle = $("#insp-title");
const inspFields = $("#insp-fields");
const inspOpen = $("#insp-open");
const inspCopy = $("#insp-copy");
const recentList = $("#recent-list");
const inspClose = $("#insp-close");
const railHistory = $("#rail-history");
const railSaved = $("#rail-saved");
const splitHandle = $("#split-handle");

// The explorer beside the rail: "model", "history", "saved", or null when closed.
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

  const ep = saved.explorerPanel;
  setExplorer(ep === "history" ? "history" : ep === "saved" ? "saved" : ep === "none" ? null : "model", false);
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

  railSaved.addEventListener("click", () => toggleExplorer("saved"));
  $("#es-add").addEventListener("click", saveCurrentQuery);

  inspClose.addEventListener("click", closeInspector);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !vqlPanel.classList.contains("row-open")) return;
    if (e.target.closest?.("input, textarea, select")) return;
    closeInspector();
  });

  wireSplit();

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
  railSaved.classList.toggle("on", panel === "saved");
  railSaved.setAttribute("aria-pressed", String(panel === "saved"));
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
      splitHandle.removeEventListener("pointerup", done);
      splitHandle.removeEventListener("pointercancel", done);
      document.body.classList.remove("resizing");
      saveEditorHeight();
    };
    splitHandle.addEventListener("pointermove", move);
    splitHandle.addEventListener("pointerup", done);
    splitHandle.addEventListener("pointercancel", done);
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
    option: null,        // ALLVERSIONS | RECENT | FAVORITES
    targetEnd: -1,       // offset just past the target word
    subqueries: [],      // { start, end, rel }
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
    const sub = { start: toks[i].at, end: q.length, rel: null };
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
    notes.push(`SHOW needs Vault API v25.2 or later. Dweller is using ${state.apiVersion || API_VERSION_FLOOR} with this vault.`);
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
// model is loaded, the API name otherwise. The top-level FROM, not the first
// one in the text: a subquery in SELECT has a FROM of its own, and a target
// option (FROM ALLVERSIONS documents) isn't the object.
function derivedTabLabel(t) {
  const q = t.query || "";
  const { target, targetEnd } = vqlShape(q);
  if (!target) return "New query";
  return modelObject(target)?.label || q.slice(targetEnd - target.length, targetEnd);
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
        ? `<button type="button" class="qtab-close" data-close="${esc(t.id)}" title="Close Tab" aria-label="Close ${esc(label)}">&times;</button>`
        : "") +
      "</div>";
  }
  html += '<button type="button" class="qtab-new" title="New Query" aria-label="New query tab">+</button>';
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
  if (!WINDOW_MODE) {
    resultsFooter.classList.remove("paged");
    return;
  }
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
  if (!WINDOW_MODE) {
    if (!queryRows.length) return;
    resultsView.page += step;
    paintPanelPage();
    resultsContainer.scrollTop = 0;
    return;
  }
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
