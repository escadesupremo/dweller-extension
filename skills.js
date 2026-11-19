// Skills: the format, the GitHub import and the saved list. Loaded by the
// service worker (importScripts) and by the tests; no page code reads it.
//
// A skill is a folder with a SKILL.md, the shape Claude's Agent Skills use:
// YAML front matter with a name and a description, Markdown instructions
// below, other files beside it. Vault Dweller's own settings sit under
// `metadata`, so the same folder still loads in Claude:
//
//   metadata:
//     vault-dweller-access: read | write
//     vault-dweller-tools: run_vql, doc_type_fields, open_query
//     vault-dweller-inputs: "doc_type: Document type; period: Period [30 days|90 days]"
//     version: "1.2"
//
// Scripts in the folder are listed and skipped: an extension can't run code it
// didn't ship with.

// ---- The tools a skill may be given ---------------------------------------------
// `can` is what the install preview says in plain words.
const SKILL_TOOLS = {
  run_vql: { can: "Run read-only VQL, up to 5,000 rows a query", write: false },
  count_by: { can: "Count records across many pages, by user, type or status", write: false },
  export_excel: { can: "Make an Excel file for you to download", write: false },
  describe_object: { can: "Read the fields and relationships of objects", write: false },
  list_doc_types: { can: "List the vault's document types", write: false },
  doc_type_fields: { can: "Read the fields on a document type's layout", write: false },
  picklist_values: { can: "Read picklist values", write: false },
  open_query: { can: "Put a query in a new tab for you to run", write: false },
  propose_changes: { can: "Propose changes to records and documents, which you approve first", write: true },
};
const SKILL_DEFAULT_TOOLS = ["run_vql", "count_by", "describe_object", "list_doc_types", "doc_type_fields", "picklist_values", "open_query", "export_excel"];

// ---- Front matter ---------------------------------------------------------------
// The YAML SKILL.md files use, and no more: top-level `key: value`, quoted
// strings, plain values that run on over indented lines, `|` and `>` blocks,
// `- item` lists, and one level of nested map (metadata).
function parseYamlSubset(yaml) {
  const lines = String(yaml).split("\n");
  const out = {};
  const unquote = (v) => {
    const s = v.trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
    return s;
  };
  const dedent = (block) => {
    const ind = Math.min(...block.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
    return block.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const km = line.match(/^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$/);
    i++;
    if (!km) continue;
    const key = km[1];
    const rest = (km[2] || "").replace(/\s+#.*$/, "");
    const cont = [];
    while (i < lines.length && (/^\s+\S/.test(lines[i]) || !lines[i].trim())) cont.push(lines[i++]);
    while (cont.length && !cont[cont.length - 1].trim()) cont.pop();

    if (/^[|>][+-]?$/.test(rest.trim())) {
      const body = dedent(cont);
      out[key] = rest.trim()[0] === "|"
        ? body.join("\n")
        : body.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ").trim();
    } else if (!rest.trim() && cont.length && cont.every((l) => !l.trim() || /^\s*-\s/.test(l) || /^\s*-$/.test(l))) {
      out[key] = cont.filter((l) => l.trim()).map((l) => unquote(l.replace(/^\s*-\s?/, "")));
    } else if (!rest.trim() && cont.length && /^\s+[A-Za-z0-9_.-]+\s*:/.test(cont.find((l) => l.trim()) || "")) {
      out[key] = parseYamlSubset(dedent(cont).join("\n"));
    } else {
      const joined = [rest, ...cont.map((l) => l.trim())].filter((s) => s !== "").join(" ");
      out[key] = unquote(joined);
    }
  }
  return out;
}

function parseSkillMd(text) {
  const src = String(text == null ? "" : text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { meta: {}, body: src.trim(), error: "SKILL.md has no front matter: it should start with --- and a name and description." };
  return { meta: parseYamlSubset(m[1]), body: src.slice(m[0].length).trim(), error: null };
}

// "doc_type: Document type; period: Period [30 days|90 days|365 days]"
function parseSkillInputs(text) {
  const out = [];
  for (const part of String(text || "").split(";")) {
    const m = part.trim().match(/^([a-z][a-z0-9_]{0,40})\s*:\s*([^[\]]+?)\s*(?:\[([^\]]*)\])?$/i);
    if (!m) continue;
    const options = m[3] ? m[3].split("|").map((s) => s.trim()).filter(Boolean).slice(0, 30) : null;
    out.push({ key: m[1], label: m[2].slice(0, 60), options: options && options.length ? options : null });
  }
  return out.slice(0, 8);
}

// The display title: the instructions' first heading, else the name in words.
function skillTitle(name, body) {
  const h = String(body || "").match(/^#\s+(.+)$/m);
  if (h) return h[1].trim().slice(0, 80);
  const s = String(name || "").replace(/-/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Untitled skill";
}

// Reads a parsed SKILL.md into what the extension keeps, with what's wrong.
function buildSkill(parsed, files, source) {
  const meta = parsed.meta || {};
  const md = meta.metadata && typeof meta.metadata === "object" ? meta.metadata : {};
  const errors = [];
  if (parsed.error) errors.push(parsed.error);
  const name = String(meta.name || "").trim();
  if (!name) errors.push("The front matter has no name.");
  else if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) errors.push("The name must be lower-case letters, digits and hyphens, 64 at most.");
  const description = String(meta.description || "").trim();
  if (!description) errors.push("The front matter has no description.");
  else if (description.length > 1024) errors.push("The description is over 1,024 characters.");
  if (!parsed.body) errors.push("There are no instructions below the front matter.");
  if (parsed.body && parsed.body.length > 60000) errors.push("The instructions are over 60,000 characters.");

  const access = /^write$/i.test(String(md["vault-dweller-access"] || "").trim()) ? "write" : "read";
  const listed = String(md["vault-dweller-tools"] || "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const unknown = listed.filter((t) => !SKILL_TOOLS[t]);
  let tools = listed.length ? listed.filter((t) => SKILL_TOOLS[t]) : [...SKILL_DEFAULT_TOOLS];
  if (access === "write" && !tools.includes("propose_changes")) tools.push("propose_changes");
  if (access !== "write") tools = tools.filter((t) => !SKILL_TOOLS[t].write);
  const warnings = unknown.length ? [`Unknown tools ignored: ${unknown.join(", ")}.`] : [];

  return {
    skill: {
      name,
      title: skillTitle(name, parsed.body),
      description,
      version: String(md.version || meta.version || "").slice(0, 20),
      access,
      tools,
      inputs: parseSkillInputs(md["vault-dweller-inputs"]),
      body: parsed.body,
      files: files.kept,
      skipped: files.skipped,
      source,
    },
    errors,
    warnings,
  };
}

// What the preview and the library say the skill can and can't do.
function skillCanCant(skill) {
  const can = skill.tools.map((t) => SKILL_TOOLS[t].can);
  if (skill.files.length) can.push("Read its own files");
  const cant = [];
  if (skill.access !== "write") cant.push("Change records or documents");
  cant.push("See your Vault session or your API key");
  cant.push("Reach any site but your AI provider");
  return { can, cant };
}

// ---- GitHub ---------------------------------------------------------------------
// Public repositories, read without a token: about 60 API requests an hour per
// address, three per import. File contents come from raw.githubusercontent.com,
// pinned to the commit, which doesn't count against that.
const GH_API = "https://api.github.com";
const GH_RAW = "https://raw.githubusercontent.com";
const GH_ORIGINS = ["https://api.github.com/*", "https://raw.githubusercontent.com/*"];

const SKILL_TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|vql|sql|ya?ml|xml|html?)$/i;
const SKILL_SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|sh|bash|zsh|ps1|psm1|bat|cmd|rb|pl|php|exe|dll|jar)$/i;
const SKILL_LIMITS = { files: 40, fileBytes: 200 * 1024, totalBytes: 1024 * 1024 };

// github.com/o/r · github.com/o/r/tree/ref/path · github.com/o/r/blob/ref/path/SKILL.md · o/r · o/r/path
function parseGithubUrl(input) {
  let s = String(input || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (/^github\.com\//i.test(s)) s = s.slice("github.com/".length);
  else if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) return null;
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, kind, ...rest] = parts;
  const okName = (x) => /^[A-Za-z0-9_.-]{1,100}$/.test(x);
  if (!okName(owner) || !okName(repo)) return null;
  let ref = null;
  let path = "";
  if (kind === "tree" || kind === "blob") {
    if (!rest.length) return null;
    ref = rest[0];
    path = rest.slice(1).join("/");
  } else if (kind) {
    path = [kind, ...rest].join("/");
  }
  if (/(^|\/)SKILL\.md$/i.test(path)) path = path.replace(/\/?SKILL\.md$/i, "");
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return { owner, repo, ref, path };
}

class SkillImportError extends Error {}

async function ghFetch(url, accept = "application/vnd.github+json") {
  let resp;
  try {
    resp = await fetch(url, { headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" } });
  } catch (e) {
    throw new SkillImportError(`Couldn't reach GitHub: ${e.message}`);
  }
  if (resp.status === 403 || resp.status === 429) {
    if (resp.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(resp.headers.get("x-ratelimit-reset")) * 1000;
      const at = reset ? new Date(reset).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "later";
      throw new SkillImportError(`GitHub's limit for requests without a sign-in is used up. Try again after ${at}.`);
    }
    throw new SkillImportError(`GitHub refused the request (HTTP ${resp.status}).`);
  }
  if (resp.status === 404) throw new SkillImportError("Not found on GitHub. Check the link; private repositories can't be read yet.");
  if (!resp.ok) throw new SkillImportError(`GitHub answered HTTP ${resp.status}.`);
  return resp;
}

// Looks a link up: the repository, the commit its branch points at, and every
// folder under the link that holds a SKILL.md.
async function resolveGithubSource(input) {
  const loc = parseGithubUrl(input);
  if (!loc) throw new SkillImportError("That isn't a GitHub repository link. Try github.com/owner/repo or a folder in it.");
  const { owner, repo } = loc;
  const repoInfo = await (await ghFetch(`${GH_API}/repos/${owner}/${repo}`)).json();
  if (repoInfo.private) throw new SkillImportError("That repository is private; only public ones can be read for now.");
  const ref = loc.ref || repoInfo.default_branch || "main";
  const commit = (await (await ghFetch(`${GH_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, "application/vnd.github.sha")).text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new SkillImportError(`Couldn't find the branch or tag "${ref}".`);
  const tree = await (await ghFetch(`${GH_API}/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`)).json();
  const blobs = (tree.tree || []).filter((e) => e.type === "blob" && typeof e.path === "string");
  const base = loc.path;
  const inBase = (p) => !base || p === base || p.startsWith(base + "/");
  const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const skillDirs = blobs
    .filter((e) => /(^|\/)SKILL\.md$/.test(e.path) && inBase(dirOf(e.path)))
    .map((e) => dirOf(e.path))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (!skillDirs.length) {
    throw new SkillImportError(base ? `No SKILL.md in ${base} or the folders under it.` : "No SKILL.md anywhere in that repository.");
  }
  return { owner, repo, ref, commit, base, skillDirs, blobs, truncated: !!tree.truncated };
}

function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

// Fetches one skill folder at the resolved commit: SKILL.md, then the text
// files beside it within the limits. Folders of other skills inside it are not
// part of it.
async function fetchGithubSkill(ctx, dir) {
  const { owner, repo, ref, commit, blobs, skillDirs } = ctx;
  const prefix = dir ? dir + "/" : "";
  const nested = skillDirs.filter((d) => d !== dir && (dir ? d.startsWith(prefix) : true));
  const mine = blobs.filter((e) => e.path.startsWith(prefix) && !nested.some((d) => e.path.startsWith(d + "/")));
  const raw = async (path) => {
    let resp;
    try {
      resp = await fetch(`${GH_RAW}/${owner}/${repo}/${commit}/${encodePath(path)}`);
    } catch (e) {
      throw new SkillImportError(`Couldn't download ${path}: ${e.message}`);
    }
    if (!resp.ok) throw new SkillImportError(`Couldn't download ${path} (HTTP ${resp.status}).`);
    return resp.text();
  };

  const kept = [];
  const skipped = [];
  let total = 0;
  let skillMd = null;
  for (const e of mine.sort((a, b) => a.path.localeCompare(b.path))) {
    const rel = e.path.slice(prefix.length);
    if (rel === "SKILL.md") {
      skillMd = await raw(e.path);
      total += skillMd.length;
      continue;
    }
    const size = Number(e.size) || 0;
    if (SKILL_SCRIPT_EXT.test(rel)) skipped.push({ path: rel, reason: "Scripts don't run in the extension" });
    else if (!SKILL_TEXT_EXT.test(rel)) skipped.push({ path: rel, reason: "Not a text file" });
    else if (size > SKILL_LIMITS.fileBytes) skipped.push({ path: rel, reason: "Over 200 KB" });
    else if (kept.length >= SKILL_LIMITS.files) skipped.push({ path: rel, reason: "Over 40 files" });
    else if (total + size > SKILL_LIMITS.totalBytes) skipped.push({ path: rel, reason: "Over 1 MB in all" });
    else {
      const text = await raw(e.path);
      total += text.length;
      kept.push({ path: rel, size: text.length, text });
    }
  }
  if (skillMd == null) throw new SkillImportError(`No SKILL.md in ${dir || "the repository root"}.`);
  const source = {
    type: "github",
    owner,
    repo,
    ref,
    path: dir,
    commit,
    url: `https://github.com/${owner}/${repo}/tree/${ref}${dir ? "/" + dir : ""}`,
  };
  return buildSkill(parseSkillMd(skillMd), { kept, skipped }, source);
}

// ---- The saved list ---------------------------------------------------------------
// In this browser's extension storage, like the API key. Previews wait in
// session storage, so a worker restarted between preview and install loses nothing.
async function listSkills() {
  const r = await chrome.storage.local.get("skills");
  return Array.isArray(r.skills) ? r.skills : [];
}

async function saveSkills(list) {
  await chrome.storage.local.set({ skills: list });
}

function skillSummary(s) {
  return {
    id: s.id,
    name: s.name,
    title: s.title,
    description: s.description,
    version: s.version,
    access: s.access,
    tools: s.tools,
    inputs: s.inputs,
    fileCount: s.files.length,
    source: s.source,
    installedAt: s.installedAt,
    updatedAt: s.updatedAt,
  };
}

function previewView(id, built, replaces) {
  const s = built.skill;
  return {
    id,
    replaces: replaces || null,
    title: s.title,
    name: s.name,
    description: s.description,
    version: s.version,
    access: s.access,
    source: s.source,
    files: [{ path: "SKILL.md", size: s.body.length, note: "instructions" }, ...s.files.map((f) => ({ path: f.path, size: f.size, note: "read when needed" }))],
    skipped: s.skipped,
    ...skillCanCant(s),
    errors: built.errors,
    warnings: built.warnings,
  };
}

// The import's first step: a single skill comes back as a preview, several as
// a list to pick from.
async function skillImportStart(url, replaces = null) {
  const ctx = await resolveGithubSource(url);
  if (ctx.skillDirs.length > 1) {
    const choices = [];
    for (const dir of ctx.skillDirs.slice(0, 30)) choices.push({ dir, label: dir || "(repository root)" });
    await chrome.storage.session.set({ skillImportCtx: { url, ctx: { ...ctx, blobs: ctx.blobs.slice(0, 20000) } } });
    return { success: true, choose: { repo: `${ctx.owner}/${ctx.repo}`, ref: ctx.ref, choices, truncated: ctx.truncated } };
  }
  return skillPreviewFor(ctx, ctx.skillDirs[0], replaces);
}

async function skillPickFolder(dir) {
  const r = await chrome.storage.session.get("skillImportCtx");
  const saved = r.skillImportCtx;
  if (!saved || !saved.ctx.skillDirs.includes(dir)) return { success: false, error: "That choice has expired; import the link again." };
  return skillPreviewFor(saved.ctx, dir, null);
}

async function skillPreviewFor(ctx, dir, replaces) {
  const built = await fetchGithubSkill(ctx, dir);
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.session.set({ [`skillPreview:${id}`]: built });
  return { success: true, preview: previewView(id, built, replaces) };
}

async function skillInstall(previewId) {
  const key = `skillPreview:${previewId}`;
  const r = await chrome.storage.session.get(key);
  const built = r[key];
  if (!built) return { success: false, error: "The preview has expired; import the link again." };
  if (built.errors.length) return { success: false, error: built.errors[0] };
  const list = await listSkills();
  const now = new Date().toISOString();
  const same = list.findIndex(
    (s) => s.name === built.skill.name && s.source?.owner === built.skill.source.owner && s.source?.repo === built.skill.source.repo
  );
  const skill = { ...built.skill, id: same >= 0 ? list[same].id : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, installedAt: same >= 0 ? list[same].installedAt : now, updatedAt: now };
  if (same >= 0) list[same] = skill;
  else list.push(skill);
  await saveSkills(list);
  await chrome.storage.session.remove(key);
  return { success: true, skill: skillSummary(skill) };
}

async function skillRemove(id) {
  const list = await listSkills();
  await saveSkills(list.filter((s) => s.id !== id));
  return { success: true };
}

// Checks the skill's source for a newer commit; a newer one comes back as a
// preview to install over it, so new permissions are seen before they apply.
async function skillCheckUpdate(id) {
  const s = (await listSkills()).find((x) => x.id === id);
  if (!s || s.source?.type !== "github") return { success: false, error: "This skill has no GitHub source." };
  const src = s.source;
  const ctx = await resolveGithubSource(`github.com/${src.owner}/${src.repo}/tree/${src.ref}${src.path ? "/" + src.path : ""}`);
  if (ctx.commit === src.commit) return { success: true, upToDate: true };
  const dir = ctx.skillDirs.includes(src.path) ? src.path : ctx.skillDirs[0];
  return skillPreviewFor(ctx, dir, id);
}

async function skillsMessage(request) {
  try {
    if (request.action === "skillsList") return { success: true, skills: (await listSkills()).map(skillSummary) };
    if (request.action === "skillsImport") return await skillImportStart(request.url);
    if (request.action === "skillsPick") return await skillPickFolder(request.dir);
    if (request.action === "skillsInstall") return await skillInstall(request.previewId);
    if (request.action === "skillsRemove") return await skillRemove(request.id);
    if (request.action === "skillsCheckUpdate") return await skillCheckUpdate(request.id);
  } catch (e) {
    return { success: false, error: e instanceof SkillImportError ? e.message : `Import failed: ${e.message}` };
  }
  return null;
}

if (typeof module !== "undefined") {
  module.exports = {
    parseYamlSubset, parseSkillMd, parseSkillInputs, buildSkill, skillCanCant, parseGithubUrl,
    resolveGithubSource, fetchGithubSkill, skillsMessage, SKILL_TOOLS, GH_ORIGINS,
  };
}
