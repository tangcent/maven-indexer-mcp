import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

/**
 * Resolves the MCP server entry for `maven-indexer-mcp`.
 *
 * If the binary is on PATH, uses `{ type: "stdio", command: "maven-indexer-mcp", args: [] }`.
 * Otherwise falls back to the `npx -y maven-indexer-mcp@latest` form so the config
 * still works when the CLI was run via `npx`.
 */
export function resolveMcpEntry(): Record<string, unknown> {
  if (isOnPath('maven-indexer-mcp')) {
    return { type: 'stdio', command: 'maven-indexer-mcp', args: [] };
  }
  return { command: 'npx', args: ['-y', 'maven-indexer-mcp@latest'] };
}

/**
 * Checks whether a binary is on the system PATH. Never throws.
 */
export function isOnPath(binary: string): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execSync(`${cmd} ${binary}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared write/strip/idempotency helpers for the install command (Module 7 Req 2).
 *
 * Design goals (informed by the codegraph source study):
 *   - Never corrupt a user's existing config: atomic writes, surgical per-key edits,
 *     malformed-JSON backup-to-`.backup` before returning `{}`.
 *   - Idempotent: re-running install with unchanged content yields action=`unchanged`.
 *   - Reversible: uninstall strips surgically, preserving everything outside markers.
 */

/**
 * Reads and parses a JSON file.
 * - Missing file → returns `{}`.
 * - Unparseable file → backs up to `<path>.backup` then returns `{}`.
 *   Never silently overwrites a user's broken-but-real config.
 */
export function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Back up the malformed file before returning a fresh object.
    const backup = `${filePath}.backup`;
    try {
      fs.copyFileSync(filePath, backup);
      process.stderr.write(`Warning: ${filePath} was unparseable; backed up to ${backup}\n`);
    } catch {
      // Best-effort backup; continue even if it fails.
    }
    return {};
  }
}

/**
 * Atomically writes a file: writes to `<path>.tmp.<pid>` then renames.
 * Creates parent directories if needed. Cleans up the temp file on failure.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw e;
  }
}

/**
 * Pretty-prints `data` as JSON with a trailing newline and atomically writes it.
 */
export function writeJsonFile(filePath: string, data: unknown): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Order-insensitive deep equality for JSON values.
 * Objects compare equal regardless of key order; arrays are order-sensitive.
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((el, i) => jsonDeepEqual(el, b[i]));
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => k in bObj && jsonDeepEqual(aObj[k], bObj[k]));
  }
  return false;
}

/**
 * Upserts a marker-delimited block in a text file.
 *
 * `body` must include the start and end markers (it is the full block).
 * - If a block with the same markers exists and its content matches `body` → `unchanged`.
 * - If a block exists but content differs → replaces it → `updated`.
 * - If no block exists → appends `body` → `created`.
 *
 * Everything outside the markers is preserved verbatim. Creates the file if absent.
 */
export function replaceOrAppendMarkedSection(
  filePath: string,
  body: string,
  startMarker: string,
  endMarker: string,
): 'created' | 'updated' | 'unchanged' {
  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf-8');
  }

  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);

  if (startIdx >= 0 && endIdx > startIdx) {
    // Existing block found — extract and compare.
    const blockEnd = endIdx + endMarker.length;
    const currentBlock = existing.slice(startIdx, blockEnd);
    if (currentBlock === body) {
      return 'unchanged';
    }
    // Replace the block (and any single trailing newline immediately after it).
    let after = existing.slice(blockEnd);
    if (after.startsWith('\n')) after = after.slice(1);
    const updated = existing.slice(0, startIdx) + body + (after.length > 0 ? '\n' + after : '');
    atomicWriteFileSync(filePath, updated);
    return 'updated';
  }

  // No existing block — append.
  let prefix = existing;
  if (prefix.length > 0 && !prefix.endsWith('\n')) {
    prefix += '\n';
  }
  const result = prefix + body + '\n';
  atomicWriteFileSync(filePath, result);
  return 'created';
}

/**
 * Surgically removes a marker-delimited block from a text file.
 *
 * - Strips everything from `startMarker` to `endMarker` (inclusive) plus one
 *   trailing newline.
 * - If the file becomes empty (only whitespace) after removal → deletes the file.
 * - If no block is found → `unchanged` (no write).
 * - If the file doesn't exist → `unchanged`.
 */
export function removeMarkedSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
): 'removed' | 'unchanged' {
  if (!fs.existsSync(filePath)) {
    return 'unchanged';
  }
  const existing = fs.readFileSync(filePath, 'utf-8');

  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);

  if (startIdx < 0 || endIdx <= startIdx) {
    return 'unchanged';
  }

  const blockEnd = endIdx + endMarker.length;
  let after = existing.slice(blockEnd);
  if (after.startsWith('\n')) after = after.slice(1);
  const before = existing.slice(0, startIdx);
  const updated = before + after;

  if (updated.trim().length === 0) {
    // File would be empty → delete it.
    fs.unlinkSync(filePath);
    return 'removed';
  }
  atomicWriteFileSync(filePath, updated);
  return 'removed';
}

/**
 * Resolves `~` (home directory) in a path. Used by targets for global-scope paths.
 */
export function resolveHome(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Computes what `replaceOrAppendMarkedSection` would do, without writing.
 * Returns `'created'` | `'updated'` | `'unchanged'`. Used for `--dry-run`.
 */
export function computeMarkedSectionAction(
  filePath: string,
  body: string,
  startMarker: string,
  endMarker: string,
): 'created' | 'updated' | 'unchanged' {
  let existing = '';
  if (fs.existsSync(filePath)) {
    try {
      existing = fs.readFileSync(filePath, 'utf-8');
    } catch {
      existing = '';
    }
  }
  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx >= 0 && endIdx > startIdx) {
    const blockEnd = endIdx + endMarker.length;
    const currentBlock = existing.slice(startIdx, blockEnd);
    return currentBlock === body ? 'unchanged' : 'updated';
  }
  return 'created';
}

/**
 * Computes what `removeMarkedSection` would do, without writing.
 * Returns `'removed'` | `'unchanged'`. Used for `--dry-run`.
 */
export function computeRemoveMarkedSectionAction(
  filePath: string,
  startMarker: string,
  endMarker: string,
): 'removed' | 'unchanged' {
  if (!fs.existsSync(filePath)) {
    return 'unchanged';
  }
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 'unchanged';
  }
  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx < 0 || endIdx <= startIdx) {
    return 'unchanged';
  }
  return 'removed';
}

/**
 * Writes `content` to `filePath` as a whole file (no marker fencing).
 * - Missing file → `created`.
 * - Existing file with identical content → `unchanged` (no write).
 * - Existing file with different content → `updated`.
 * When `dryRun` is true, computes the action without writing.
 */
export function writeWholeFile(
  filePath: string,
  content: string,
  dryRun: boolean,
): 'created' | 'updated' | 'unchanged' {
  if (fs.existsSync(filePath)) {
    let existing = '';
    try {
      existing = fs.readFileSync(filePath, 'utf-8');
    } catch {
      existing = '';
    }
    if (existing === content) {
      return 'unchanged';
    }
    if (!dryRun) {
      atomicWriteFileSync(filePath, content);
    }
    return 'updated';
  }
  if (!dryRun) {
    atomicWriteFileSync(filePath, content);
  }
  return 'created';
}

/**
 * Computes what `writeWholeFile` would do, without writing.
 */
export function computeWholeFileAction(
  filePath: string,
  content: string,
): 'created' | 'updated' | 'unchanged' {
  if (!fs.existsSync(filePath)) {
    return 'created';
  }
  try {
    const existing = fs.readFileSync(filePath, 'utf-8');
    return existing === content ? 'unchanged' : 'updated';
  } catch {
    return 'updated';
  }
}

/**
 * Deletes `filePath` if it exists. Returns `'removed'` or `'unchanged'`.
 * When `dryRun` is true, computes the action without deleting.
 */
export function removeWholeFile(
  filePath: string,
  dryRun: boolean,
): 'removed' | 'unchanged' {
  if (!fs.existsSync(filePath)) {
    return 'unchanged';
  }
  if (!dryRun) {
    fs.unlinkSync(filePath);
  }
  return 'removed';
}

/**
 * Checks whether an MCP server entry for `maven-indexer` is present and matches
 * the expected shape. Returns the entry if present, else undefined.
 */
export function findMcpEntry(config: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object') return undefined;
  const entry = servers[key];
  if (entry && typeof entry === 'object') {
    return entry as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Surgically sets `mcpServers[key]` on a config object, creating the container
 * if absent. Returns `{ changed: boolean, config }` where `config` is the new
 * object (mutated copy).
 */
export function setMcpEntry(
  config: Record<string, unknown>,
  key: string,
  entry: Record<string, unknown>,
): { changed: boolean; config: Record<string, unknown> } {
  const next: Record<string, unknown> = { ...config };
  if (!next.mcpServers || typeof next.mcpServers !== 'object') {
    next.mcpServers = {};
  }
  const servers = next.mcpServers as Record<string, unknown>;
  if (jsonDeepEqual(servers[key], entry)) {
    return { changed: false, config };
  }
  servers[key] = entry;
  return { changed: true, config: next };
}

/**
 * Surgically removes `mcpServers[key]`. Prunes the `mcpServers` container if it
 * becomes empty. Returns `{ changed, config }`.
 */
export function removeMcpEntry(
  config: Record<string, unknown>,
  key: string,
): { changed: boolean; config: Record<string, unknown> } {
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !(key in servers)) {
    return { changed: false, config };
  }
  const next: Record<string, unknown> = { ...config };
  const nextServers = { ...(next.mcpServers as Record<string, unknown>) };
  delete nextServers[key];
  if (Object.keys(nextServers).length === 0) {
    delete next.mcpServers;
  } else {
    next.mcpServers = nextServers;
  }
  return { changed: true, config: next };
}
