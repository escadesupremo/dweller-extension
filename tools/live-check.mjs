#!/usr/bin/env node
// Live checks against a real Vault, for building Dweller. READ-ONLY.
//
// Signs in as a test user, asks Vault the things the extension relies on but
// the mocks can only fake (how reference fields are described and returned,
// whether their IDs resolve to names), prints a PASS/FAIL report and signs
// out. Nothing is written to the vault.
//
// Credentials, from %USERPROFILE%\.dweller-test.env (or the same names as
// environment variables, which win):
//
//   VAULT_DOMAIN=yourvault-sandbox.veevavault.com
//   VAULT_USER=dweller.test@yourcompany.com
//   VAULT_PASSWORD=...
//
// Use a dedicated test user in a sandbox, read-only if you can. Never commit
// that file or paste it anywhere. The password goes only to VAULT_DOMAIN over
// HTTPS and is never printed; neither is the session.
//
// Run:  node tools/live-check.mjs

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENV_FILE = join(homedir(), ".dweller-test.env");
const VAULT_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.veevavault\.com$/i;
const API_CAP = "v26.2";          // the newest version the extension speaks
const CLIENT_ID = "dweller-live-check";

// ---- credentials ----------------------------------------------------------------
function loadCredentials() {
  const fromFile = {};
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      fromFile[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  const get = (k) => process.env[k] || fromFile[k] || "";
  return { domain: get("VAULT_DOMAIN").toLowerCase(), user: get("VAULT_USER"), password: get("VAULT_PASSWORD") };
}

const creds = loadCredentials();
if (!creds.domain || !creds.user || !creds.password) {
  console.log(`No test credentials found.

Create ${ENV_FILE} with:

  VAULT_DOMAIN=yourvault-sandbox.veevavault.com
  VAULT_USER=dweller.test@yourcompany.com
  VAULT_PASSWORD=...

(a dedicated sandbox test user, read-only if possible), then run again.`);
  process.exit(2);
}
if (!VAULT_HOST_RE.test(creds.domain)) {
  console.log(`VAULT_DOMAIN must be a *.veevavault.com host, got "${creds.domain}".`);
  process.exit(2);
}

// ---- Vault calls --------------------------------------------------------------
let version = "v24.1";            // any supported version can sign in
let session = "";

async function call(path, { method = "GET", form = null, versioned = true } = {}) {
  const url = `https://${creds.domain}${versioned ? `/api/${version}` : ""}${path}`;
  const headers = { Accept: "application/json", "X-VaultAPI-ClientID": CLIENT_ID };
  if (session) headers.Authorization = session;
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url, { method, headers, body });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  // Strictly true/false: a non-JSON 200 (an SSO or maintenance page) is a failure, not a skip.
  const ok = !!(res.ok && data && data.responseStatus !== "FAILURE");
  const error = data?.errors?.[0]?.message || data?.responseMessage || `HTTP ${res.status}`;
  return { ok, data, error };
}

const query = (q) => call("/query", { method: "POST", form: { q } });

const cmpVersion = (a, b) => {
  const pa = a.slice(1).split(".").map(Number), pb = b.slice(1).split(".").map(Number);
  return pa[0] - pb[0] || (pa[1] || 0) - (pb[1] || 0);
};

// ---- report ---------------------------------------------------------------------
const results = [];
function report(ok, name, detail) {
  results.push(ok);
  console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

// The object a document reference property points at, as the extension reads
// it (popup.js refObjectOf): ObjectReference + objectType, User/Group → *__sys.
function refObjectOf(p) {
  if (!/objectreference/i.test(String(p?.type || ""))) return null;
  const t = String(p.objectType || "").trim().toLowerCase();
  if (!t) return null;
  return { user: "user__sys", group: "group__sys" }[t] || t;
}

async function main() {
  // Sign in.
  const auth = await call("/auth", { method: "POST", form: { username: creds.user, password: creds.password } });
  if (!auth.ok || !auth.data?.sessionId) {
    report(false, "Sign in", auth.error);
    return;
  }
  session = auth.data.sessionId;
  report(true, "Sign in", `as ${creds.user} on ${creds.domain}`);

  try {
    // API version: the newest the vault offers, capped at what Dweller speaks.
    const api = await call("/api/", { versioned: false });
    const versions = Object.keys(api.data?.values || {}).filter((v) => /^v\d+(\.\d+)?$/.test(v)).sort(cmpVersion);
    if (versions.length) {
      const usable = versions.filter((v) => cmpVersion(v, API_CAP) <= 0);
      version = usable[usable.length - 1] || version;
    }
    report(versions.length > 0, "API version", versions.length ? `vault offers up to ${versions[versions.length - 1]}; using ${version}` : api.error);

    // 1. Document reference fields name their object.
    const docMeta = await call("/metadata/objects/documents/properties");
    const props = docMeta.data?.properties || [];
    const refProps = props.filter((p) => /objectreference/i.test(String(p.type || "")));
    const named = refProps.filter((p) => refObjectOf(p));
    report(docMeta.ok && named.length > 0, "Document reference fields name their object (objectType)",
      docMeta.ok
        ? `${named.length} of ${refProps.length} ObjectReference properties; e.g. ${named.slice(0, 6).map((p) => `${p.name} → ${refObjectOf(p)}`).join(", ") || "none"}`
        : docMeta.error);

    // 2. Object reference fields name their object (object.name), on an object
    //    one of those document fields points at (product__v when there is one).
    const objectTarget = (named.find((p) => p.name === "product__v") && "product__v")
      || named.map(refObjectOf).find((o) => o && !o.endsWith("__sys")) || "user__sys";
    const objMeta = await call(`/metadata/vobjects/${encodeURIComponent(objectTarget)}`);
    const objFields = objMeta.data?.object?.fields || [];
    const objRefs = objFields.filter((f) => f.object?.name);
    const types = [...new Set(objRefs.map((f) => f.type))].join(", ");
    report(objMeta.ok && objRefs.length > 0, `Object reference fields name their object (object.name) on ${objectTarget}`,
      objMeta.ok
        ? `${objRefs.length} fields with object.name (types: ${types || "none"}); e.g. ${objRefs.slice(0, 5).map((f) => `${f.name} → ${f.object.name}`).join(", ")}`
        : objMeta.error);

    // 3. A document reference field's values, and whether they resolve to names.
    const sampleProp = named.find((p) => p.name === "product__v") || named.find((p) => !refObjectOf(p).endsWith("__sys"));
    if (!sampleProp) {
      report(null, "Reference values come back as IDs, and resolve to names", "no object reference property on documents to try");
    } else {
      const target = refObjectOf(sampleProp);
      const docs = await query(`SELECT id, ${sampleProp.name} FROM documents WHERE ${sampleProp.name} != null MAXROWS 20`);
      const values = (docs.data?.data || []).map((r) => r[sampleProp.name]);
      const shapes = [...new Set(values.map((v) => (Array.isArray(v) ? "list" : typeof v)))].join(", ");
      report(docs.ok, `Values of documents.${sampleProp.name}`,
        docs.ok ? `${values.length} documents; values arrive as: ${shapes || "nothing"}` : docs.error);
      const ids = [...new Set(values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((x) => x !== null && x !== "").map(String))].slice(0, 200);
      if (ids.length) {
        const lookup = await query(`SELECT id, name__v FROM ${target} WHERE id CONTAINS (${ids.map((i) => `'${i}'`).join(", ")})`);
        const found = (lookup.data?.data || []).filter((r) => r.name__v);
        report(lookup.ok && found.length > 0, `IDs resolve to names on ${target} (name__v, id CONTAINS)`,
          lookup.ok ? `${found.length} of ${ids.length} IDs named` : lookup.error);
      }
    }

    // 4. Document user fields → user__sys names.
    const users = await query("SELECT id, created_by__v FROM documents MAXROWS 20");
    const userIds = [...new Set((users.data?.data || []).map((r) => r.created_by__v).filter((x) => x !== null && x !== undefined).map(String))];
    const userShape = [...new Set((users.data?.data || []).map((r) => typeof r.created_by__v))].join(", ");
    if (!users.ok || !userIds.length) {
      report(users.ok ? null : false, "User fields resolve to names on user__sys", users.ok ? "no created_by__v values to try" : users.error);
    } else {
      const lookup = await query(`SELECT id, name__v FROM user__sys WHERE id CONTAINS (${userIds.map((i) => `'${i}'`).join(", ")})`);
      const found = (lookup.data?.data || []).filter((r) => r.name__v);
      report(lookup.ok && found.length > 0, "User fields resolve to names on user__sys (name__v)",
        lookup.ok ? `created_by__v arrives as ${userShape}; ${found.length} of ${userIds.length} users named` : lookup.error);
    }

    // 5. Groups are named by label__v.
    const groups = await query("SELECT id, label__v FROM group__sys MAXROWS 5");
    const labelled = (groups.data?.data || []).filter((r) => r.label__v);
    report(groups.ok && labelled.length > 0, "Groups are named by label__v on group__sys",
      groups.ok ? `${labelled.length} of ${(groups.data?.data || []).length} groups have label__v` : groups.error);
  } finally {
    // Sign out: end the session rather than leave it to time out.
    await call("/session", { method: "DELETE" }).catch(() => {});
  }
}

main()
  .catch((e) => report(false, "Run", e.message))
  .finally(() => {
    const failed = results.filter((r) => r === false).length;
    console.log(`\n${results.filter((r) => r === true).length} passed, ${failed} failed, ${results.filter((r) => r === null).length} skipped.`);
    process.exit(failed ? 1 : 0);
  });
