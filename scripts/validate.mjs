#!/usr/bin/env node

import { readFileSync as readDisk, existsSync as existsOnDisk, readdirSync as listDisk } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vaultDir = join(here, "..");

/** Run git in the vault repo; returns trimmed stdout or null when it fails. */
function git(args) {
  try {
    return execFileSync("git", args, { cwd: vaultDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const cliArgs = process.argv.slice(2);
const contentOnly = cliArgs.includes("--content-only");
const checkpointOnly = cliArgs.includes("--checkpoint-only");
function option(name) {
  const index = cliArgs.indexOf(name);
  if (index < 0) return null;
  const value = cliArgs[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

let snapshotCommit = null;
let expectedVersion = null;
let snapshotFiles = null;
try {
  const requestedCommit = option("--snapshot-commit");
  expectedVersion = option("--expected-version");
  if (contentOnly && checkpointOnly) throw new Error("Content-only and checkpoint-only are mutually exclusive");
  if (expectedVersion && !/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$/.test(expectedVersion)) {
    throw new Error("Invalid expected content version");
  }
  if (requestedCommit) {
    if (!contentOnly || !/^[0-9a-fA-F]{40}$/.test(requestedCommit)) {
      throw new Error("Snapshot validation requires --content-only and a full existing commit ID");
    }
    snapshotCommit = git(["rev-parse", "--verify", "--quiet", `${requestedCommit}^{commit}`]);
    if (!snapshotCommit) throw new Error("Requested snapshot commit does not exist");
    const tree = git(["ls-tree", "-r", "--name-only", "-z", snapshotCommit]);
    if (tree === null) throw new Error("Cannot read the requested snapshot tree");
    snapshotFiles = new Set(tree.split("\0").filter(Boolean));
  }
} catch (error) {
  console.error(`Cannot select validation snapshot: ${error.message}`);
  process.exit(1);
}

function snapshotPath(path) {
  const local = relative(vaultDir, path).replace(/\\/g, "/");
  if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error("Path escapes the vault root");
  return local;
}

// Read immutable A directly. The validator and its installed dependencies remain from this workflow checkout.
function readFileSync(path, encoding) {
  if (!snapshotCommit) return readDisk(path, encoding);
  const content = git(["show", `${snapshotCommit}:${snapshotPath(path)}`]);
  if (content === null) throw new Error(`Missing snapshot file: ${snapshotPath(path)}`);
  return content;
}
function existsSync(path) {
  if (!snapshotFiles) return existsOnDisk(path);
  const local = snapshotPath(path);
  return snapshotFiles.has(local) || [...snapshotFiles].some((file) => file.startsWith(`${local}/`));
}
function readdirSync(path, options) {
  if (!snapshotFiles) return listDisk(path, options);
  const prefix = `${snapshotPath(path)}/`;
  const entries = new Map();
  for (const file of snapshotFiles) {
    if (!file.startsWith(prefix)) continue;
    const remainder = file.slice(prefix.length);
    const name = remainder.split("/")[0];
    entries.set(name, remainder.includes("/"));
  }
  return options?.withFileTypes
    ? [...entries].map(([name, directory]) => ({ name, isDirectory: () => directory }))
    : [...entries.keys()];
}

console.log("🔍 [Setup Vault Validator] Checking repository:", snapshotCommit ?? vaultDir, contentOnly ? "(content-only mode)" : checkpointOnly ? "(checkpoint-only mode)" : "(full mode)");

let errors = 0;
let checkedItems = 0;

function fail(msg) {
  console.error(`❌ ${msg}`);
  errors++;
}

// Schema validation is mandatory; missing dependencies must not silently bypass it.
let cfValidator = null;
try {
  const cf = await import("@cfworker/json-schema");
  cfValidator = cf.Validator;
  if (typeof cfValidator !== "function") throw new Error("JSON Schema Validator export is unavailable");
} catch (error) {
  console.error(`Required JSON Schema validator could not be loaded: ${error.message}`);
  process.exit(1);
}

function loadSchema(name) {
  const p = join(vaultDir, "schemas", name);
  if (!existsSync(p)) {
    fail(`Schema missing: ${name}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (error) {
    fail(`Schema cannot be loaded: ${name}: ${error.message}`);
    return null;
  }
}

function validateWithSchema(data, schema, label) {
  if (!cfValidator || !schema) {
    fail(`Schema validation unavailable for ${label}`);
    return false;
  }
  if (cfValidator && schema) {
    try {
      const v = new cfValidator(schema);
      const res = v.validate(data);
      if (!res.valid) {
        for (const err of res.errors) {
          fail(`Schema violation in ${label}: ${err.error} at ${err.instanceLocation}`);
        }
        return false;
      }
    } catch (e) {
      fail(`Schema validator crashed on ${label}: ${e.message}`);
      return false;
    }
  }
  return true;
}

function safeContentPath(path) {
  return typeof path === "string" && path.length > 0
    && !/[\\\x00-\x1f:?*"<>|]/.test(path)
    && path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

/** The release summary counts actual published items; resource manifest.count counts category files. */
function validatePinnedCounts(manifest, checkpoint, commit) {
  const tree = git(["ls-tree", "-r", "--name-only", "-z", commit]);
  if (tree === null) { fail("Cannot read pinned content tree"); return; }
  const files = new Set(tree.split("\0").filter(Boolean));
  validateWithSchema(manifest, loadSchema("vault-manifest.schema.json"), "pinned manifest.json");
  for (const section of ["styles", "resources", "templates", "patterns", "skills"]) {
    const collection = manifest.collections?.[section];
    if (!collection && section === "skills") continue;
    if (!Array.isArray(collection?.items)) { fail(`Pinned ${section} index is missing`); continue; }
    if (collection.count !== collection.items.length) fail(`Pinned ${section} index count does not match its entries`);
    const paths = new Set();
    const ids = new Set();
    let itemCount = 0;
    for (const ref of collection.items) {
      if (!safeContentPath(ref.path) || !ref.path.startsWith(`${section}/`) || !files.has(ref.path)) {
        fail(`Pinned ${section} path is invalid or missing: ${ref.path}`);
        continue;
      }
      if (paths.has(ref.path) || ids.has(ref.id)) fail(`Duplicate pinned ${section} index entry: ${ref.id}`);
      paths.add(ref.path); ids.add(ref.id);
      try {
        const raw = git(["show", `${commit}:${ref.path}`]);
        if (raw === null) throw new Error("Cannot read pinned asset");
        const asset = JSON.parse(raw);
        if (section === "resources") {
          if (!Array.isArray(asset)) throw new Error("Resource category is not an array");
          itemCount += asset.length;
        } else {
          if (asset.id !== ref.id) fail(`Pinned index ID differs from asset ID: ${ref.path}`);
          itemCount++;
          if (section === "styles") {
            const css = ref.cssPath ?? `${ref.path.slice(0, ref.path.lastIndexOf("/") + 1)}${asset.cssPath}`;
            if (!safeContentPath(css) || !css.startsWith("styles/") || !files.has(css)) {
              fail(`Pinned style CSS is invalid or missing: ${css}`);
            }
          }
        }
      } catch (error) {
        fail(`Pinned asset cannot be read: ${ref.path}: ${error.message}`);
      }
    }
    if (section === "resources") {
      const categories = collection.categories;
      if (!Array.isArray(categories) || categories.length !== collection.count
        || new Set(categories).size !== categories.length || categories.some((id) => !ids.has(id))) {
        fail("Pinned resource categories do not match the category index");
      }
    }
    if (checkpoint.collections?.[section] !== itemCount) {
      fail(`Release ${section} count ${checkpoint.collections?.[section]} differs from pinned items ${itemCount}`);
    }
  }
  if (checkpoint.collections?.inbox !== undefined) {
    let inboxCount = 0;
    for (const path of files) {
      if (!/^inbox\/[^/]+\.json$/.test(path)) continue;
      try {
        const item = JSON.parse(git(["show", `${commit}:${path}`]));
        inboxCount += Array.isArray(item) ? item.length : 1;
      } catch (error) { fail(`Pinned inbox cannot be read: ${path}: ${error.message}`); }
    }
    if (checkpoint.collections.inbox !== inboxCount) fail("Release inbox count differs from pinned items");
  }
}

// 1. releases/latest.json
if (!contentOnly) {
  const relSchema = loadSchema("release-checkpoint.schema.json");
  const relPath = join(vaultDir, "releases", "latest.json");
  if (!existsSync(relPath)) {
    fail("Missing releases/latest.json");
  } else {
    try {
      const rel = JSON.parse(readFileSync(relPath, "utf8"));
      validateWithSchema(rel, relSchema, "releases/latest.json");

      if (!rel.releaseVersion || !/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$/.test(rel.releaseVersion)) {
        fail(`Invalid releaseVersion format in releases/latest.json: ${rel.releaseVersion}`);
      }
      if (!rel.commitSha || !/^[0-9a-fA-F]{40}$/.test(rel.commitSha)) {
        fail(`commitSha must be a strict 40-character hexadecimal Git commit SHA, got: ${rel.commitSha}`);
      }
      if (!rel.snapshotTag || !/^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$/.test(rel.snapshotTag)) {
        fail(`snapshotTag must match vYYYY.MM.DD[.patch], got: ${rel.snapshotTag}`);
      }
      if (rel.snapshotTag !== `v${rel.releaseVersion}`) {
        fail("snapshotTag must equal v + releaseVersion");
      }

      const resolvedCommit = rel.commitSha ? git(["rev-parse", "--verify", "--quiet", `${rel.commitSha.trim()}^{commit}`]) : null;
      const resolvedTag = rel.snapshotTag ? git(["rev-parse", "--verify", "--quiet", `${rel.snapshotTag.trim()}^{commit}`]) : null;

      if (!resolvedCommit) {
        fail(`Checkpoint commitSha "${rel.commitSha}" does not resolve to an existing git commit`);
      } else {
        console.log(`✓ commitSha ${rel.commitSha} → ${resolvedCommit.slice(0, 12)}`);
      }

      if (!resolvedTag) {
        fail(`Checkpoint snapshotTag "${rel.snapshotTag}" does not resolve to an existing git commit`);
      } else {
        console.log(`✓ snapshotTag ${rel.snapshotTag} → ${resolvedTag.slice(0, 12)}`);
      }

      if (resolvedCommit && resolvedTag) {
        if (resolvedCommit !== resolvedTag) {
          fail(`Strict checkpoint mismatch: snapshotTag (${rel.snapshotTag} -> ${resolvedTag}) does not resolve to commitSha (${rel.commitSha} -> ${resolvedCommit})`);
        } else {
          console.log(`✓ snapshotTag and commitSha co-resolve to ${resolvedCommit.slice(0, 12)}`);
        }
      }

      if (resolvedCommit) {
        const pinnedManifestRaw = git(["show", `${resolvedCommit}:manifest.json`]);
        if (!pinnedManifestRaw) {
          fail(`Strict checkpoint verification failed: could not read manifest.json from pinned commit ${resolvedCommit}`);
        } else {
          try {
            const pinnedManifest = JSON.parse(pinnedManifestRaw);
            validatePinnedCounts(pinnedManifest, rel, resolvedCommit);
            if (pinnedManifest.contentVersion !== rel.releaseVersion) {
              fail(`Strict checkpoint mismatch: pinned manifest version (${pinnedManifest.contentVersion}) does not match releases/latest.json releaseVersion (${rel.releaseVersion})`);
            } else {
              console.log(`✓ Pinned commit manifest version matches releaseVersion: ${rel.releaseVersion}`);
            }
          } catch (e) {
            fail(`Failed to parse pinned manifest.json from commit ${resolvedCommit}: ${e.message}`);
          }
        }
      }

      console.log(`✓ Release checkpoint: ${rel.releaseVersion}`);
      checkedItems++;
    } catch (e) {
      fail(`Failed to parse releases/latest.json: ${e.message}`);
    }
  }

  if (checkpointOnly) {
    if (errors > 0) {
      console.error(`\nCheckpoint validation failed with ${errors} error(s).`);
      process.exit(1);
    } else {
      console.log(`\nRelease checkpoint verified against its pinned snapshot.`);
      process.exit(0);
    }
  }
}

// 2. manifest.json
const manSchema = loadSchema("vault-manifest.schema.json");
const manPath = join(vaultDir, "manifest.json");
let manifest = null;
if (!existsSync(manPath)) {
  fail("Missing manifest.json");
} else {
  try {
    manifest = JSON.parse(readFileSync(manPath, "utf8"));
    validateWithSchema(manifest, manSchema, "manifest.json");

    if (!manifest.contentVersion) fail("Missing contentVersion in manifest.json");
    if (expectedVersion && manifest.contentVersion !== expectedVersion) {
      fail(`Snapshot contentVersion ${manifest.contentVersion} does not match requested version ${expectedVersion}`);
    }
    if (!manifest.collections) fail("Missing collections in manifest.json");
    console.log(`✓ Manifest content version: ${manifest.contentVersion}`);
    checkedItems++;
  } catch (e) {
    fail(`Failed to parse manifest.json: ${e.message}`);
  }
}

const seenIds = new Set();
function checkUniqueId(id, type) {
  if (!id || typeof id !== "string") {
    fail(`Missing or non-string id for ${type}`);
    return;
  }
  const fullKey = `${type}:${id}`;
  if (seenIds.has(fullKey)) {
    fail(`Duplicate ID detected: ${fullKey}`);
  }
  seenIds.add(fullKey);
}

// 3. styles — Style Contract V2
const styleSchema = loadSchema("style.schema.json");
const STYLE_GRAMMAR = {
  tier: ["token", "component", "composition", "experience"],
  shell: ["sidebar", "topbar", "dock", "dual-pane", "windowed", "command-centered", "editorial", "canvas", "stacked"],
  navigation: ["sidebar", "topbar", "dock", "tab-strip", "command-bar", "menu-bar", "keyboard-menu"],
  detail: ["rail", "modal", "sheet", "floating-inspector", "window", "inline", "full-page"],
  card: ["panel", "flat-row", "editorial-block", "poster", "terminal-line", "window", "tile", "index-entry", "floating-surface", "borderless-group", "sticker"],
  composition: ["solid-grid", "magazine-index", "news-columns", "character-list", "finder-list", "poster-wall", "drafting-index", "floating-panels", "ledger", "roadmap"],
  density: ["compact", "normal", "spacious"],
  motion: ["reduced", "normal", "expressive"],
};
const TOKEN_KEYS = [
  "panelRadius", "controlRadius", "borderWidth", "shadow", "accent", "accentSecondary",
  "surface", "text", "density", "headingScale", "bodyScale", "motion",
];
const RUNTIME_CAPABILITY = "1.0.0";

function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const styleDir = join(vaultDir, "styles");
let styleCount = 0;
if (existsSync(styleDir)) {
  for (const dir of readdirSync(styleDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const sPath = join(styleDir, dir.name, "manifest.json");
    if (!existsSync(sPath)) {
      fail(`Style ${dir.name} missing manifest.json`);
      continue;
    }
    styleCount++;
    checkedItems++;
    try {
      const st = JSON.parse(readFileSync(sPath, "utf8"));
      validateWithSchema(st, styleSchema, `styles/${dir.name}/manifest.json`);

      checkUniqueId(st.id, "style");
      for (const key of ["id", "name", "version", "description", "palette", "tokens", "cssPath"]) {
        if (st[key] === undefined) fail(`Style ${dir.name} missing required V1 field ${key}`);
      }
      if (st.id && st.id !== dir.name) fail(`Style ${dir.name} declares id "${st.id}" — must match directory name`);

      const exp = st.experience;
      if (!exp) {
        console.log(`· Style ${dir.name}: V1 manifest (reskin tier, no experience profile)`);
      } else {
        if (!exp.tier) fail(`Style ${dir.name}: experience.tier is required when experience is present`);
        for (const [axis, allowed] of Object.entries(STYLE_GRAMMAR)) {
          const value = exp[axis];
          if (value === undefined) continue;
          if (!allowed.includes(value)) {
            fail(`Style ${dir.name}: ${axis}="${value}" is not a valid client grammar (${allowed.join(" / ")})`);
          }
        }
        if (exp.tweakable !== undefined) {
          if (!Array.isArray(exp.tweakable)) fail(`Style ${dir.name}: experience.tweakable must be an array`);
          else {
            for (const k of exp.tweakable) {
              if (!TOKEN_KEYS.includes(k)) fail(`Style ${dir.name}: tweakable names unknown token "${k}"`);
            }
          }
        }
        if (exp.locked !== undefined) {
          for (const [k, reason] of Object.entries(exp.locked)) {
            if (!TOKEN_KEYS.includes(k)) fail(`Style ${dir.name}: locked names unknown token "${k}"`);
            if (typeof reason !== "string" || !reason.trim()) {
              fail(`Style ${dir.name}: locked.${k} needs an explanatory reason`);
            }
          }
          const both = (exp.tweakable ?? []).filter((k) => k in exp.locked);
          if (both.length) fail(`Style ${dir.name}: ${both.join(", ")} listed as both tweakable and locked`);
        }
        if (exp.runtimeCapability !== undefined) {
          if (typeof exp.runtimeCapability !== "string" || !/^\d+\.\d+\.\d+$/.test(exp.runtimeCapability)) {
            fail(`Style ${dir.name}: runtimeCapability must be an x.y.z version`);
          } else if (compareVersions(exp.runtimeCapability, RUNTIME_CAPABILITY) > 0) {
            console.log(`· Style ${dir.name}: requires runtime ${exp.runtimeCapability} (client is ${RUNTIME_CAPABILITY})`);
          }
        }
      }

      if (st.cssPath && (!safeContentPath(st.cssPath) || !existsSync(join(styleDir, dir.name, st.cssPath)))) {
        fail(`Style ${dir.name}: cssPath "${st.cssPath}" does not exist beside the manifest`);
      }
    } catch (e) {
      fail(`Failed to parse style ${dir.name}/manifest.json: ${e.message}`);
    }
  }
}

// 4. resources
const resSchema = loadSchema("resource.schema.json");
const resDir = join(vaultDir, "resources");
let resourceCount = 0;
let resourceCategoryCount = 0;
if (existsSync(resDir)) {
  for (const file of readdirSync(resDir).filter((f) => f.endsWith(".json"))) {
    resourceCategoryCount++;
    try {
      const list = JSON.parse(readFileSync(join(resDir, file), "utf8"));
      if (!Array.isArray(list)) {
        fail(`Resource file ${file} must contain an array`);
        continue;
      }
      for (const r of list) {
        resourceCount++;
        checkedItems++;
        validateWithSchema(r, resSchema, `resources/${file} (${r.id || "unknown"})`);
        checkUniqueId(r.id, "resource");
        if (!r.id || !r.name || !r.category) fail(`Resource invalid in ${file}`);
        if (!r.homepage && !r.repository && !r.downloadUrl) fail(`Resource ${r.id} is dead content (missing link)`);
      }
    } catch (e) {
      fail(`Failed to parse resource file ${file}: ${e.message}`);
    }
  }
}

// 5. templates
const tplSchema = loadSchema("template.schema.json");
const tplDir = join(vaultDir, "templates");
let templateCount = 0;
if (existsSync(tplDir)) {
  for (const dir of readdirSync(tplDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const tPath = join(tplDir, dir.name, "template.json");
    if (!existsSync(tPath)) {
      fail(`Template ${dir.name} missing template.json`);
    } else {
      templateCount++;
      checkedItems++;
      try {
        const tpl = JSON.parse(readFileSync(tPath, "utf8"));
        validateWithSchema(tpl, tplSchema, `templates/${dir.name}/template.json`);
        checkUniqueId(tpl.id, "template");
      } catch (e) {
        fail(`Failed to parse template ${dir.name}/template.json: ${e.message}`);
      }
    }
  }
}

// 6. patterns
const patSchema = loadSchema("pattern.schema.json");
const patDir = join(vaultDir, "patterns");
let patternCount = 0;
if (existsSync(patDir)) {
  for (const dir of readdirSync(patDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const pPath = join(patDir, dir.name, "pattern.json");
    if (!existsSync(pPath)) {
      fail(`Pattern ${dir.name} missing pattern.json`);
    } else {
      patternCount++;
      checkedItems++;
      try {
        const pat = JSON.parse(readFileSync(pPath, "utf8"));
        validateWithSchema(pat, patSchema, `patterns/${dir.name}/pattern.json`);
        checkUniqueId(pat.id, "pattern");
      } catch (e) {
        fail(`Failed to parse pattern ${dir.name}/pattern.json: ${e.message}`);
      }
    }
  }
}

// 7. skills
const sklSchema = loadSchema("skill.schema.json");
const sklDir = join(vaultDir, "skills");
let skillCount = 0;
if (existsSync(sklDir)) {
  for (const f of readdirSync(sklDir).filter((f) => f.endsWith(".json"))) {
    const sPath = join(sklDir, f);
    skillCount++;
    checkedItems++;
    try {
      const sk = JSON.parse(readFileSync(sPath, "utf8"));
      validateWithSchema(sk, sklSchema, `skills/${f}`);
      checkUniqueId(sk.id, "skill");
      if (!sk.id || !sk.name || !sk.prompt) fail(`Skill ${f} invalid`);
    } catch (e) {
      fail(`Failed to parse skill ${f}: ${e.message}`);
    }
  }
}

// 8. inbox
const inbSchema = loadSchema("inbox.schema.json");
const inbDir = join(vaultDir, "inbox");
let inboxCount = 0;
if (existsSync(inbDir)) {
  for (const f of readdirSync(inbDir).filter((f) => f.endsWith(".json"))) {
    try {
      const content = JSON.parse(readFileSync(join(inbDir, f), "utf8"));
      const items = Array.isArray(content) ? content : [content];
      for (const item of items) {
        inboxCount++;
        checkedItems++;
        validateWithSchema(item, inbSchema, `inbox/${f}`);
        checkUniqueId(item.id, "inbox");
      }
    } catch (e) {
      fail(`Failed to parse inbox item ${f}: ${e.message}`);
    }
  }
}

// Verify counts against manifest collections
if (manifest && manifest.collections) {
  if (manifest.collections.inbox && manifest.collections.inbox.count !== inboxCount) {
    fail(`Inbox count mismatch: manifest says ${manifest.collections.inbox.count}, but found ${inboxCount}`);
  }
  const discoveredCounts = { styles: styleCount, resources: resourceCategoryCount, templates: templateCount, patterns: patternCount, skills: skillCount };
  for (const [section, count] of Object.entries(discoveredCounts)) {
    const collection = manifest.collections[section];
    if (!collection && section === "skills" && count === 0) continue;
    if (!Array.isArray(collection?.items)) {
      fail(`Missing ${section} item index`);
      continue;
    }
    if (collection.count !== count || collection.items.length !== count) {
      fail(`${section} count must match both indexed entries and snapshot files (${count})`);
    }
    const paths = new Set();
    const ids = new Set();
    for (const ref of collection.items) {
      if (!safeContentPath(ref.path) || !ref.path.startsWith(`${section}/`) || !existsSync(join(vaultDir, ref.path))) {
        fail(`Invalid or missing ${section} index path: ${ref.path}`);
        continue;
      }
      if (paths.has(ref.path) || ids.has(ref.id)) fail(`Duplicate ${section} index entry: ${ref.id}`);
      paths.add(ref.path); ids.add(ref.id);
      try {
        const asset = JSON.parse(readFileSync(join(vaultDir, ref.path), "utf8"));
        if (section === "resources") {
          if (!Array.isArray(asset)) fail(`Indexed resource category is not an array: ${ref.path}`);
        } else if (asset.id !== ref.id) fail(`Index and asset IDs differ: ${ref.path}`);
        if (section === "styles" && (!safeContentPath(ref.cssPath) || !ref.cssPath.startsWith("styles/") || !existsSync(join(vaultDir, ref.cssPath)))) {
          fail(`Invalid or missing indexed style CSS: ${ref.cssPath}`);
        }
      } catch (error) { fail(`Indexed asset cannot be read: ${ref.path}: ${error.message}`); }
    }
    if (section === "resources") {
      const categories = collection.categories;
      if (!Array.isArray(categories) || categories.length !== count
        || new Set(categories).size !== count || categories.some((id) => !ids.has(id))) {
        fail("Resource category list differs from category files and index");
      }
    }
  }
  if (manifest.collections.styles && manifest.collections.styles.count !== styleCount) {
    fail(`Style count mismatch: manifest says ${manifest.collections.styles.count}, but found ${styleCount}`);
  }
  if (manifest.collections.templates && manifest.collections.templates.count !== templateCount) {
    fail(`Template count mismatch: manifest says ${manifest.collections.templates.count}, but found ${templateCount}`);
  }
  if (manifest.collections.patterns && manifest.collections.patterns.count !== patternCount) {
    fail(`Pattern count mismatch: manifest says ${manifest.collections.patterns.count}, but found ${patternCount}`);
  }
  if (manifest.collections.skills && manifest.collections.skills.count !== skillCount) {
    fail(`Skill count mismatch: manifest says ${manifest.collections.skills.count}, but found ${skillCount}`);
  }
}

if (errors > 0) {
  console.error(`\nValidation failed with ${errors} error(s).`);
  process.exit(1);
} else {
  console.log(`\nVault content validation completed (${checkedItems} items checked).`);
  console.log(`   Styles: ${styleCount}, Resources: ${resourceCount}, Templates: ${templateCount}, Patterns: ${patternCount}, Skills: ${skillCount}`);
  process.exit(0);
}
