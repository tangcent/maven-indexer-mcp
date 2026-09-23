#!/usr/bin/env node
/**
 * Bundles one publishable package (mcp / cli) into a self-contained dist.
 *
 * Why bundling: `@maven-indexer/engine` is a private workspace package that is
 * never published. If `maven-indexer-mcp` shipped it as a runtime dependency,
 * `npm i maven-indexer-mcp` would fail to resolve it (404). Bundling folds the
 * engine source into the published artifact, so the published package only has
 * real npm dependencies.
 *
 * Node modules stay external: `better-sqlite3` is a native addon and cannot be
 * bundled (and must keep resolving from the consumer's node_modules). Everything
 * in EXTERNAL must also stay listed in the package's `dependencies`.
 *
 * Usage: node ../../scripts/bundle-package.mjs <packageDir> [entryFile]
 *   node ../../scripts/bundle-package.mjs packages/mcp src/index.ts
 *   node ../../scripts/bundle-package.mjs packages/cli src/cli.ts
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = resolve(ROOT, process.argv[2] ?? 'packages/mcp');
const entryFile = process.argv[3] ?? 'src/index.ts';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));

/**
 * Everything declared as a runtime dependency by the engine or by the package
 * itself stays external — `better-sqlite3` is a native addon and `npm`-installed
 * packages must keep resolving from the consumer's node_modules. Anything else
 * (workspace-only code, i.e. the engine) gets inlined.
 *
 * Deriving the list from package.json avoids the two declarations drifting apart.
 */
const EXTERNAL = [
  ...new Set([
    ...Object.keys(readJson(join(ROOT, 'packages/engine/package.json')).dependencies ?? {}),
    ...Object.keys(readJson(join(pkgDir, 'package.json')).dependencies ?? {}),
  ]),
];

const entryPoint = join(pkgDir, entryFile);
await build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: join(pkgDir, 'dist', `${basename(entryFile).replace(/\.ts$/, '.js')}`),
  external: EXTERNAL,
  sourcemap: true,
  logLevel: 'info',
});
// Note: no `banner` — both entry files already start with their own shebang,
// and a second one would be invalid syntax.

// The CFR decompiler jar must ship inside the published package. `Config`
// resolves it as `<dist>/../lib/cfr-0.152.jar`, so mirror that layout.
const engineLib = join(ROOT, 'packages/engine/lib/cfr-0.152.jar');
if (existsSync(engineLib)) {
  const targetDir = join(pkgDir, 'lib');
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(engineLib, join(targetDir, 'cfr-0.152.jar'));
} else {
  console.warn(`warning: ${engineLib} not found — skipping jar copy`);
}

// LICENSE lives at the repo root; `files: ["LICENSE"]` needs it in the package.
const license = join(ROOT, 'LICENSE');
if (existsSync(license)) copyFileSync(license, join(pkgDir, 'LICENSE'));

console.log(`bundled ${pkgDir}`);
