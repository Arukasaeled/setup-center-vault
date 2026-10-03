#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vaultDir = join(here, "..");

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
