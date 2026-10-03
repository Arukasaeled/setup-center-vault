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

console.log("🔍 [Setup Vault Validator] Checking repository:", vaultDir);

let errors = 0;
let checkedItems = 0;

function fail(msg) {
  console.error(`❌ ${msg}`);
  errors++;
}

// 1. releases/latest.json
const relPath = join(vaultDir, "releases", "latest.json");
if (!existsSync(relPath)) {
  fail("Missing releases/latest.json");
} else {
  const rel = JSON.parse(readFileSync(relPath, "utf8"));
  if (!rel.releaseVersion) fail("Missing releaseVersion");
  if (!rel.commitSha && !rel.snapshotTag) fail("Missing immutable commitSha or snapshotTag");
  // Presence was not enough. The checkpoint once shipped a commitSha that did
  // not exist on the remote; every client fetch 404'd, the client swallowed it
  // as a console.warn, and a clean install silently received no remote content
  // at all. A pin that does not resolve is a broken release, so resolve it.
  for (const key of ["commitSha", "snapshotTag"]) {
    const pin = rel[key];
    if (!pin) continue;
    if (typeof pin !== "string" || !pin.trim()) {
      fail(`${key} must be a non-empty string, got ${JSON.stringify(pin)}`);
      continue;
    }
    const resolved = git(["rev-parse", "--verify", "--quiet", `${pin.trim()}^{commit}`]);
    if (!resolved) fail(`${key} "${pin}" does not resolve to a commit in this repository`);
    else console.log(`✓ ${key} ${pin} → ${resolved.slice(0, 12)}`);
  }
  console.log(`✓ Release checkpoint: ${rel.releaseVersion}`);
}

// 2. manifest.json
const manPath = join(vaultDir, "manifest.json");
if (!existsSync(manPath)) {
  fail("Missing manifest.json");
} else {
  const man = JSON.parse(readFileSync(manPath, "utf8"));
  if (!man.contentVersion) fail("Missing contentVersion in manifest.json");
  console.log(`✓ Manifest content version: ${man.contentVersion}`);
}

// 2b. styles — Style Contract V2.
//
// A published style claims an Experience profile: shell, navigation, detail,
// card and composition grammar. The client renders each of those from a CLOSED
// enum. A manifest naming a grammar the client does not implement does not
// "degrade gracefully" — the release ships, every client fetches it, and the
// style renders as an unstyled default while the gallery claims otherwise.
// So the enums are mirrored here and a stray value is a release blocker.
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
/** The client's EXPERIENCE_RUNTIME_CAPABILITY — a style above this needs a newer app. */
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
if (existsSync(styleDir)) {
  for (const dir of readdirSync(styleDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const sPath = join(styleDir, dir.name, "manifest.json");
    if (!existsSync(sPath)) {
      fail(`Style ${dir.name} missing manifest.json`);
      continue;
    }
    checkedItems++;
    const st = JSON.parse(readFileSync(sPath, "utf8"));
    for (const key of ["id", "name", "version", "description", "palette", "tokens", "cssPath"]) {
      if (st[key] === undefined) fail(`Style ${dir.name} missing required V1 field ${key}`);
    }
    if (st.id && st.id !== dir.name) fail(`Style ${dir.name} declares id "${st.id}" — the directory name is the id clients resolve`);

    const exp = st.experience;
    if (!exp) {
      // Backward compatible on purpose: a V1 entry is a Tier-1/2 reskin and
      // still renders. Reporting it keeps the migration visible.
      console.log(`· Style ${dir.name}: V1 manifest (reskin tier, no experience profile)`);
    } else {
      if (!exp.tier) fail(`Style ${dir.name}: experience.tier is required when experience is present`);
      for (const [axis, allowed] of Object.entries(STYLE_GRAMMAR)) {
        const value = exp[axis];
        if (value === undefined) continue;
        if (!allowed.includes(value)) {
          fail(`Style ${dir.name}: ${axis}="${value}" is not a client grammar (${allowed.join(" / ")})`);
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
            fail(`Style ${dir.name}: locked.${k} needs a sentence explaining why — the client shows it beside the disabled control`);
          }
        }
        // A token that is both tweakable and locked would render as an enabled
        // control on one code path and a disabled one on another.
        const both = (exp.tweakable ?? []).filter((k) => k in exp.locked);
        if (both.length) fail(`Style ${dir.name}: ${both.join(", ")} listed as both tweakable and locked`);
      }
      if (exp.runtimeCapability !== undefined) {
        if (typeof exp.runtimeCapability !== "string" || !/^\d+\.\d+\.\d+$/.test(exp.runtimeCapability)) {
          fail(`Style ${dir.name}: runtimeCapability must be an x.y.z version`);
        } else if (compareVersions(exp.runtimeCapability, RUNTIME_CAPABILITY) > 0) {
          console.log(
            `· Style ${dir.name}: requires runtime ${exp.runtimeCapability} (client is ${RUNTIME_CAPABILITY}) — clients below it will show 「需要更新应用」`,
          );
        }
      }
      console.log(`✓ Style ${dir.name}: tier=${exp.tier} ${exp.shell ?? "-"}/${exp.navigation ?? "-"}/${exp.detail ?? "-"}/${exp.card ?? "-"}/${exp.composition ?? "-"}`);
    }

    if (st.cssPath && !existsSync(join(styleDir, dir.name, st.cssPath))) {
      fail(`Style ${dir.name}: cssPath "${st.cssPath}" does not exist beside the manifest`);
    }
  }
}

// 3. resources
const resDir = join(vaultDir, "resources");
if (existsSync(resDir)) {
  for (const file of readdirSync(resDir).filter((f) => f.endsWith(".json"))) {
    const list = JSON.parse(readFileSync(join(resDir, file), "utf8"));
    for (const r of list) {
      checkedItems++;
      if (!r.id || !r.name || !r.category) fail(`Resource invalid in ${file}`);
      if (!r.homepage && !r.repository && !r.downloadUrl) fail(`Resource ${r.id} is dead content`);
    }
  }
}

// 4. templates
const tplDir = join(vaultDir, "templates");
if (existsSync(tplDir)) {
  for (const dir of readdirSync(tplDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const tPath = join(tplDir, dir.name, "template.json");
    if (!existsSync(tPath)) fail(`Template ${dir.name} missing template.json`);
    else checkedItems++;
  }
}

// 5. patterns
const patDir = join(vaultDir, "patterns");
if (existsSync(patDir)) {
  for (const dir of readdirSync(patDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const pPath = join(patDir, dir.name, "pattern.json");
    if (!existsSync(pPath)) fail(`Pattern ${dir.name} missing pattern.json`);
    else checkedItems++;
  }
}

// 6. skills
const sklDir = join(vaultDir, "skills");
if (existsSync(sklDir)) {
  for (const f of readdirSync(sklDir).filter((f) => f.endsWith(".json"))) {
    const sPath = join(sklDir, f);
    const sk = JSON.parse(readFileSync(sPath, "utf8"));
    if (!sk.id || !sk.name || !sk.prompt) fail(`Skill ${f} invalid`);
    else checkedItems++;
  }
}

if (errors > 0) {
  console.error(`\nValidation failed with ${errors} error(s).`);
  process.exit(1);
} else {
  console.log(`\n✨ Vault integrity verified 100% green! (${checkedItems} items checked)`);
  process.exit(0);
}
