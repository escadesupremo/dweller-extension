// Injects Dweller's popup.html as an overlay iframe on Vault pages.
// Toggled by clicking the extension toolbar icon.

(function () {
  // The toolbar click injects this file again when the page was still loading.
  // One set of listeners is enough; two would open and close the panel at once.
  if (window.__dwellerOverlay) return;
  window.__dwellerOverlay = true;

  const IFRAME_ID = "dweller-overlay-iframe";
  const WRAP_ID = "dweller-overlay-wrap";

  function create() {
    const wrap = document.createElement("div");
    wrap.id = WRAP_ID;
    Object.assign(wrap.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      width: "660px",
      // Height tracks the panel's own content (see dweller-height below),
      // so only the width is user-resizable. It is eased rather than snapped:
      // the panel reports a new height whenever its content changes size.
      height: "300px",
      transition: "height .22s cubic-bezier(.4, 0, .2, 1)",
      minWidth: "360px",
      maxWidth: "calc(100vw - 40px)",
      maxHeight: "calc(100vh - 40px)",
      resize: "horizontal",
      zIndex: "2147483647",
      boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
      borderRadius: "14px",
      overflow: "hidden",
      background: "#f0f2f5",
      border: "1px solid rgba(0,0,0,0.1)",
    });

    const iframe = document.createElement("iframe");
    iframe.id = IFRAME_ID;
    // Copy JSON and the value chips write to the clipboard, which a frame from
    // another origin may only do when the page embedding it allows it.
    iframe.allow = "clipboard-write";
    iframe.src = chrome.runtime.getURL("popup.html");
    Object.assign(iframe.style, {
      width: "100%",
      height: "100%",
      border: "0",
      display: "block",
    });

    wrap.appendChild(iframe);
    document.documentElement.appendChild(wrap);
  }

  function toggle() {
    const existing = document.getElementById(WRAP_ID);
    if (existing) {
      existing.remove();
    } else {
      create();
    }
  }

  // ---- "Query this record": tell the panel which record this page shows ----
  // Read straight from the Vault URL. Documents are #doc_info/{id}; standard
  // object records carry the object and record id in the hash; Vault EDC uses
  // an object-redirect link. The panel turns this into a one-click query.
  function parseRecord() {
    const hash = location.hash || "";
    let m = hash.match(/#doc_info\/(\d+)/i);
    if (m) return { kind: "document", id: m[1], label: pageLabel() };
    m = hash.match(/#object\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9]+)/);
    if (m) return { kind: "object", object: m[1], id: m[2], label: pageLabel() };
    m = hash.match(/object-redirect\?([^#]*)/i);
    if (m) {
      const p = new URLSearchParams(m[1]);
      const object = p.get("object_type");
      const id = p.get("object_id");
      if (object && id) return { kind: "object", object, id, label: pageLabel() };
    }
    return null;
  }

  // Vault puts the record's name in the tab title on a record page — a good
  // label for the offer. Kept short and treated as display text by the panel.
  function pageLabel() {
    const t = (document.title || "").replace(/\s*[|–—-]\s*Vault\s*$/i, "").trim();
    return t.length > 1 && t.length <= 80 ? t : "";
  }

  function sendRecord() {
    const iframe = document.getElementById(IFRAME_ID);
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: "dweller-record", record: parseRecord() }, "*");
    }
  }

  // The panel re-queries on SPA navigation (the hash changes without a reload).
  window.addEventListener("hashchange", sendRecord);

  function open() {
    if (!document.getElementById(WRAP_ID)) create();
  }

  function close() {
    document.getElementById(WRAP_ID)?.remove();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.action === "toggleOverlay") toggle();
    if (msg.action === "openOverlay") open();
  });

  function setHeight(px) {
    const wrap = document.getElementById(WRAP_ID);
    if (!wrap || !Number.isFinite(px)) return;
    const max = window.innerHeight - 40;
    wrap.style.height = `${Math.max(120, Math.min(px, max))}px`;
  }

  // The panel reports its own height and asks for teardown from inside the
  // iframe. Only trust these when they actually came from that iframe's window —
  // any script on the host page can post to us.
  window.addEventListener("message", (e) => {
    const type = e.data?.type;
    if (type !== "dweller-close" && type !== "dweller-height" && type !== "dweller-ready") return;
    const iframe = document.getElementById(IFRAME_ID);
    if (!iframe || e.source !== iframe.contentWindow) return;
    if (type === "dweller-close") close();
    else if (type === "dweller-ready") sendRecord();   // panel just initialised
    else setHeight(e.data.height);
  });
})();
