#!/usr/bin/env node
/**
 * CI guard: detect duplicated module basenames across package src/ trees.
 *
 * Spec: requirements-engine-unification.md Req 3.3
 * "A repository-wide grep for duplicated module basenames across package `src/`
 * trees SHALL return no matches (a structural guard against re-fragmentation)."
 *
 * Exit non-zero if any .ts basename appears in 2+ DIFFERENT packages' src/ trees,
 * unless explicitly allowlisted below.
 *
 * Allowlist rationale:
 *   - index.ts: universal Node.js barrel/entry-point convention. Each package
 *     has its own index.ts serving a different role (engine barrel, mcp entry,
 *     cli install registry). Not duplicated logic.
 *   - explore.ts: engine/src/explore.ts is the core composed-query FUNCTION;
 *     cli/src/commands/explore.ts is a thin COMMAND WRAPPER. Different roles,
 *     not duplicated logic. The wrapper imports the engine function.
 *
 * Usage: node scripts/check-no-duplicate-basenames.js
 * CI: called from .github/workflows/ci.yml after build.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = __filename.substring(0, __filename.lastIndexOf('/'));
const ROOT = join(__dirname, '..');

const PACKAGES_DIR = join(ROOT, 'packages');

const ALLOWLIST = new Set([
  'index.ts',   // universal Node barrel/entry convention
  'explore.ts', // engine function vs cli command wrapper — different roles
]);

/**
 * Recursively collect all .ts files under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function listTsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      results.push(...listTsFiles(full));
    } else if (st.isFile() && entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

// Discover packages
let packages;
try {
  packages = readdirSync(PACKAGES_DIR).filter(name => {
    try {
      return statSync(join(PACKAGES_DIR, name)).isDirectory();
    } catch {
      return false;
    }
  });
} catch {
  console.error('packages/ directory not found');
  process.exit(1);
}

// basename -> Set<package>
const basenameToPackages = new Map();

for (const pkg of packages) {
  const srcDir = join(PACKAGES_DIR, pkg, 'src');
  const files = listTsFiles(srcDir);
  for (const file of files) {
    const name = basename(file);
    if (!basenameToPackages.has(name)) {
      basenameToPackages.set(name, new Set());
    }
    basenameToPackages.get(name).add(pkg);
  }
}

// Find violations
let violations = 0;
for (const [name, pkgs] of basenameToPackages) {
  if (ALLOWLIST.has(name)) continue;
  if (pkgs.size > 1) {
    console.error(`VIOLATION: basename '${name}' appears in ${pkgs.size} packages: ${[...pkgs].join(', ')}`);
    // Show the actual files
    for (const pkg of pkgs) {
      const files = listTsFiles(join(PACKAGES_DIR, pkg, 'src')).filter(f => basename(f) === name);
      for (const f of files) {
        console.error(`  ${relative(ROOT, f)}`);
      }
    }
    violations++;
  }
}

if (violations > 0) {
  console.error('');
  console.error(`Found ${violations} duplicated basename(s) across package src/ trees.`);
  console.error('This is a structural guard against re-fragmentation (spec Req 3.3).');
  console.error('Either rename the duplicate(s), or add to ALLOWLIST in this script with rationale.');
  process.exit(1);
}

console.log(`OK: no duplicated module basenames across package src/ trees (allowlisted: ${[...ALLOWLIST].join(', ')}).`);
