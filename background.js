// Background service worker — reads TK cookie and handles Vault API calls

// Skills: the format, the GitHub import and the saved list (skills.js), and the
// run loop with its tools (skill-runner.js). Both use this file's Vault call,
// provider table and redaction, which are declared below and in scope by the
// time any of their functions run.
importScripts("skills.js", "skill-runner.js");

// Toolbar click toggles the overlay iframe injected by content.js into the Vault tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  if (!tab.url || !/^https:\/\/[^/]*\.veevavault\.com\//.test(tab.url)) {
    // Not a Vault tab — nothing to inject into.
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "toggleOverlay" });
  } catch (e) {
    // Content script may not be loaded yet (e.g. after install). Inject and retry.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { action: "toggleOverlay" });
  }
});

// Vault tenants live under veevavault.com. Enforced here as well as in the
// popup: the worker holds the cookie jar, so it does not take the caller's word
// for which host a session token may be read for or sent to.
const VAULT_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.veevavault\.com$/i;

function isVaultHost(host) {
  return VAULT_HOST_RE.test(String(host || ""));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only this extension's own pages and content scripts. externally_connectable
  // is unset, so nothing else can reach here today — this keeps that true if it
  // is ever set.
  if (sender.id !== chrome.runtime.id) return;

  if (request.action === "getToken") {
    getVaultToken(request.domain).then(sendResponse);
    return true; // keep channel open for async
  }

  if (request.action === "aiSaveKey") {
    saveAiKey(request.provider, request.key).then(sendResponse);
    return true;
  }

  if (request.action === "aiKeyState") {
    aiKeyState().then(sendResponse);
    return true;
  }

  if (request.action === "aiVerifyKey") {
    verifyAiKey().then(sendResponse);
    return true;
  }

  if (request.action === "aiModels") {
    listAiModels().then(sendResponse);
    return true;
  }

  if (request.action === "aiSetModel") {
    setAiModel(request.model).then(sendResponse);
    return true;
  }

  if (typeof request.action === "string" && request.action.startsWith("skills")) {
    skillsMessage(request).then((r) => sendResponse(r || { success: false, error: "Unknown request." }));
    return true;
  }

  if (request.action === "apiCall") {
    makeVaultApiCall(request.domain, request.sessionId, request.endpoint, request.method, request.body, {
      version: request.version,
      headers: request.headers,
      contentType: request.contentType,
    }).then(sendResponse);
    return true;
  }

});

async function getVaultToken(domain) {
  if (!isVaultHost(domain)) {
    return { success: false, error: "Not a Vault domain." };
  }
  try {
    // Try multiple cookie names Veeva Vault may use
    const cookieNames = ["TK", "tk"];
    for (const name of cookieNames) {
      const cookie = await chrome.cookies.get({
        url: `https://${domain}`,
        name: name,
      });
      if (cookie) {
        return { success: true, token: cookie.value };
      }
    }
    // Fallback: search all cookies for the domain for any token-like cookie
    const allCookies = await chrome.cookies.getAll({ domain: domain });
    const tkCookie = allCookies.find(
      (c) => c.name.toUpperCase() === "TK" || c.name === "sessionId"
    );
    if (tkCookie) {
      return { success: true, token: tkCookie.value };
    }
    return { success: false, error: "No TK token found. Make sure you are logged into Veeva Vault." };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// The version used until the vault says which ones it supports, and whenever
// it can't be asked.
const DEFAULT_API_VERSION = "v24.1";
const API_VERSION_RE = /^v\d{1,2}\.\d{1,2}$/;

// The only extra request headers the page may set: the VQL ones that add
// field metadata and per-record permissions to a query response.
const ALLOWED_HEADERS = new Set([
  "X-VaultAPI-DescribeQuery",
  "X-VaultAPI-RecordProperties",
  "X-VaultAPI-DocumentProperties",
]);

async function makeVaultApiCall(domain, sessionId, endpoint, method = "GET", body = null, opts = {}) {
  if (!isVaultHost(domain)) {
    return { success: false, error: "Not a Vault domain." };
  }
  // The session token rides in a header, so the path must not be able to steer
  // the request to another origin (a protocol-relative "//host" would).
  const path = String(endpoint || "");
  if (!path.startsWith("/") || path.startsWith("//")) {
    return { success: false, error: "Invalid API path." };
  }
  const version = API_VERSION_RE.test(opts.version || "") ? opts.version : DEFAULT_API_VERSION;
  try {
    // "/api/" itself lists the versions the vault supports. Vault's
    // responseDetails.next_page returns paths that already include
    // /api/vXX.X/... — pass those through unchanged. Otherwise prepend the version.
    const url = path === "/api/" || /^\/api\/v\d+(\.\d+)?\//.test(path)
      ? `https://${domain}${path}`
      : `https://${domain}/api/${version}${path}`;
    const options = {
      method,
      headers: {
        "Authorization": sessionId,
        "Accept": "application/json",
      },
    };
    for (const [name, value] of Object.entries(opts.headers || {})) {
      if (ALLOWED_HEADERS.has(name) && /^[\w-]{1,20}$/.test(String(value))) {
        options.headers[name] = String(value);
      }
    }
    if (body) {
      if (typeof body === "string") {
        // Form-encoded unless the caller names CSV, which the object update
        // endpoint takes.
        options.headers["Content-Type"] = opts.contentType === "text/csv" ? "text/csv" : "application/x-www-form-urlencoded";
        options.body = body;
      } else {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
    }
    const response = await fetch(url, options);
    const data = await response.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---- AI provider key -------------------------------------------------------
// The key stays in the service worker. popup.js can ask whether one exists and
// ask for it to be tested, but never receives the value back, so nothing in the
// page context can read it.
const AI_PROVIDERS = {
  anthropic: {
    verifyUrl: "https://api.anthropic.com/v1/models?limit=1",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // A service worker still presents a browser origin, so host_permissions
      // alone doesn't satisfy Anthropic — it refuses CORS requests without this.
      "anthropic-dangerous-direct-browser-access": "true",
    }),
  },
  openai: {
    verifyUrl: "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  gemini: {
    // Header auth rather than ?key= so the credential stays out of URLs and logs.
    verifyUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: (key) => ({ "x-goog-api-key": key }),
  },
};

// Provider error bodies are handed back to the popup, and some of them quote
// the key that failed (OpenAI returns "Incorrect API key provided: sk-proj-…").
// Nothing key-shaped reaches the page.
const KEY_PATTERNS = [
  /sk-[A-Za-z0-9_-]{6,}/g,
  /AIza[A-Za-z0-9_-]{6,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
];

async function redact(text) {
  let out = String(text == null ? "" : text);
  const store = await chrome.storage.local.get(["aiKey"]);
  // The literal key first — it may not match any pattern.
  if (store.aiKey && store.aiKey.length >= 8) {
    out = out.split(store.aiKey).join("[redacted]");
  }
  for (const re of KEY_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

// A brake on the page asking for key checks in a loop. The window lives in
// worker memory, so it resets if the worker is recycled; the provider's own
// limits are the real ones.
const AI_LIMITS = {
  windowMs: 60000,
  maxVerifies: 6,
};

const aiVerifyTimes = [];

function rateLimited(log, max) {
  const now = Date.now();
  while (log.length && now - log[0] > AI_LIMITS.windowMs) log.shift();
  if (log.length >= max) return true;
  log.push(now);
  return false;
}

async function saveAiKey(provider, key) {
  if (!AI_PROVIDERS[provider]) return { success: false, error: "Unknown provider" };
  const trimmed = String(key || "").trim();
  // A model belongs to one provider's key; a new key picks again.
  await chrome.storage.local.remove(["aiModel"]);
  if (!trimmed) {
    await chrome.storage.local.remove(["aiKey", "aiProvider", "aiKeyVerified"]);
    return { success: true, hasKey: false, provider: provider };
  }
  // A new key is unverified until it answers a test request.
  await chrome.storage.local.set({ aiProvider: provider, aiKey: trimmed, aiKeyVerified: false });
  return { success: true, hasKey: true, provider: provider };
}

async function aiKeyState() {
  const store = await chrome.storage.local.get(["aiProvider", "aiKey", "aiKeyVerified"]);
  const key = store.aiKey || "";
  const provider = store.aiProvider || "anthropic";
  return {
    success: true,
    hasKey: !!key,
    provider: provider,
    // null for a key stored before verification was tracked — the popup
    // re-tests those once rather than locking the user out.
    verified: key ? (store.aiKeyVerified ?? null) : false,
    // A masked tail is enough to tell two keys apart without exposing one.
    hint: key ? `…${key.slice(-4)}` : "",
  };
}

async function verifyAiKey() {
  if (rateLimited(aiVerifyTimes, AI_LIMITS.maxVerifies)) {
    return { success: false, error: "Too many checks in a row. Wait a moment." };
  }
  const store = await chrome.storage.local.get(["aiProvider", "aiKey"]);
  const provider = store.aiProvider || "anthropic";
  const key = store.aiKey;
  if (!key) return { success: false, error: "No key saved yet." };

  const cfg = AI_PROVIDERS[provider];
  if (!cfg) return { success: false, error: "Unknown provider" };

  try {
    const resp = await fetch(cfg.verifyUrl, { headers: cfg.headers(key) });
    if (resp.ok) {
      await chrome.storage.local.set({ aiKeyVerified: true });
      return { success: true, provider: provider, hint: `…${key.slice(-4)}` };
    }
    await chrome.storage.local.set({ aiKeyVerified: false });

    // Both providers describe the failure in the body; a bare status is useless.
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      detail = body?.error?.message || detail;
    } catch (e) {
      /* non-JSON error body */
    }
    if (resp.status === 401 || resp.status === 403) {
      return { success: false, error: `Key rejected — ${await redact(detail)}` };
    }
    return { success: false, error: await redact(detail) };
  } catch (err) {
    return { success: false, error: `Could not reach ${provider}: ${await redact(err.message)}` };
  }
}
