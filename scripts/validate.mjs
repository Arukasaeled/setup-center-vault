#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vaultDir = join(here, "..");

/** Run git in the vault repo; returns trimmed stdout or null when it fails. */
function git(args) {
  try {
    return execFileSync("git", args, { cwd: vaultDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const cliArgs = process.argv.slice(2);
const contentOnly = cliArgs.includes("--content-only");
const checkpointOnly = cliArgs.includes("--checkpoint-only");

console.log("🔍 [Setup Vault Validator] Checking repository:", vaultDir, contentOnly ? "(content-only mode)" : checkpointOnly ? "(checkpoint-only mode)" : "(full mode)");

let errors = 0;
let checkedItems = 0;

function fail(msg) {
  console.error(`❌ ${msg}`);
  errors++;
}

// Load JSON Schema validator if available
let cfValidator = null;
try {
  const cf = await import("@cfworker/json-schema");
  cfValidator = cf.Validator;
} catch {
  // Pure Node fallback if dependencies not yet installed
}

function loadSchema(name) {
  const p = join(vaultDir, "schemas", name);
  if (!existsSync(p)) {
    fail(`Schema missing: ${name}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

function validateWithSchema(data, schema, label) {
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

      for (const key of ["commitSha", "snapshotTag"]) {
        const pin = rel[key];
        if (!pin) continue;
        const resolved = git(["rev-parse", "--verify", "--quiet", `${pin.trim()}^{commit}`]);
        if (!resolved) {
          if (checkpointOnly) {
            fail(`Strict checkpoint verification failed: ${key} "${pin}" does not resolve to an existing git commit`);
          } else {
            console.warn(`· Warning: ${key} "${pin}" does not resolve to a local git commit (may be checked out from release archive or shallow clone)`);
          }
        } else {
          console.log(`✓ ${key} ${pin} → ${resolved.slice(0, 12)}`);
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
      console.log(`\n✨ Release checkpoint verified 100% green!`);
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

      if (st.cssPath && !existsSync(join(styleDir, dir.name, st.cssPath))) {
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
if (existsSync(resDir)) {
  for (const file of readdirSync(resDir).filter((f) => f.endsWith(".json"))) {
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
  console.log(`\n✨ Vault integrity verified 100% green! (${checkedItems} items checked)`);
  console.log(`   Styles: ${styleCount}, Resources: ${resourceCount}, Templates: ${templateCount}, Patterns: ${patternCount}, Skills: ${skillCount}`);
  process.exit(0);
}
