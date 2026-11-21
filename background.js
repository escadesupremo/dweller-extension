// Background service worker — reads TK cookie and handles Vault API calls

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
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, { action: "toggleOverlay" });
    } catch (err) {
      // A page that can't be scripted (an error page, say): nothing to open.
    }
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
    const burst = burstOf(response);
    let data;
    try {
      data = await response.json();
    } catch {
      // Not JSON: an error page from a proxy or the vault's front door. The
      // status says more than the parse error would.
      return { success: false, error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`, burst };
    }
    return { success: true, data, burst };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Vault's rate limit is a number of calls per 5-minute window for the whole
// vault, shared by every user and integration. Each response says how many
// are left, so the popup can slow its background loading before it costs
// anyone else.
function burstOf(response) {
  const limit = Number(response.headers.get("X-VaultAPI-BurstLimit"));
  const remaining = Number(response.headers.get("X-VaultAPI-BurstLimitRemaining"));
  if (!Number.isFinite(remaining) || response.headers.get("X-VaultAPI-BurstLimitRemaining") === null) return null;
  return { limit: Number.isFinite(limit) && limit > 0 ? limit : null, remaining };
}

// Earlier versions kept an AI provider key and installed skills in local
// storage. Neither feature exists any more, so drop what they left behind.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(["aiKey", "aiProvider", "aiKeyVerified", "aiModel", "skills"]);
});
