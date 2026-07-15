/**
 * Orchestrator for the `install` and `uninstall` subcommands (Module 7).
 *
 * Responsibilities:
 *   - Parse and validate flags (`--target`, `--location`, `--auto-allow`,
 *     `--dry-run`, `--yes`, `--json`, `--status`, `--print-mcp-config`).
 *   - Resolve targets via the registry: `auto` (detected), `all`, `none`, or
 *     a csv of specific ids.
 *   - Dispatch install/uninstall/status/print-mcp-config.
 *   - Print every filesystem modification (path + action) for transparency.
 *
 * Binary-on-PATH verification and `npx` fallback live in `resolveMcpEntry()`
 * (shared.ts), so the orchestrator does not duplicate that logic.
 */

import { AgentTarget, InstallAction, InstallOptions, Location } from './types.js';
import { ALL_TARGETS, findTarget } from './targets/registry.js';

export interface InstallCliOpts {
  /** `auto` | `all` | `none` | csv of target ids (e.g. `claude,cursor`). Default: `auto`. */
  target?: string;
  /** `global` | `local`. Default: `global`. */
  location?: string;
  /** Auto-approve MCP tool calls (Claude: adds `mcp__maven-indexer__*`). */
  autoAllow?: boolean;
  /** Print the plan without writing. */
  dryRun?: boolean;
  /** Non-interactive (skip confirmation prompts). */
  yes?: boolean;
  /** JSON output. */
  json?: boolean;
  /** Show installation status per target. */
  status?: boolean;
  /** Print MCP config block without writing. */
  printMcpConfig?: boolean;
  /** Client name for `--print-mcp-config` (optional). */
  client?: string;
}

export interface UninstallCliOpts {
  target?: string;
  location?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

const DEFAULT_TARGET = 'auto';
const DEFAULT_LOCATION: Location = 'global';

/**
 * Resolves the `--target` flag into a list of `AgentTarget` objects.
 *
 * - `auto`: targets whose `detect()` reports installed; if none, falls back to
 *   the first target in the registry (the documented default — Claude Code).
 * - `all`: every target in the registry.
 * - `none`: empty array (skip agent writes).
 * - csv: specific target ids; unknown ids are reported on stderr and skipped.
 */
function resolveTargets(targetSpec: string, loc: Location): AgentTarget[] {
  if (targetSpec === 'none') {
    return [];
  }
  if (targetSpec === 'all') {
    return ALL_TARGETS.filter(t => t.supportsLocation(loc));
  }
  if (targetSpec === 'auto') {
    const detected = ALL_TARGETS.filter(t => t.supportsLocation(loc) && t.detect(loc).installed);
    if (detected.length > 0) {
      return detected;
    }
    // Fall back to the first supported target (documented default).
    const fallback = ALL_TARGETS.find(t => t.supportsLocation(loc));
    if (fallback) {
      process.stderr.write(`No targets detected; falling back to '${fallback.id}'.\n`);
      return [fallback];
    }
    return [];
  }
  // csv
  const ids = targetSpec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const result: AgentTarget[] = [];
  for (const id of ids) {
    const t = findTarget(id);
    if (!t) {
      process.stderr.write(`Warning: unknown target '${id}', skipping.\n`);
      continue;
    }
    if (!t.supportsLocation(loc)) {
      process.stderr.write(`Warning: target '${id}' does not support location '${loc}', skipping.\n`);
      continue;
    }
    result.push(t);
  }
  return result;
}

function parseLocation(s: string | undefined): Location {
  if (!s || s === 'global' || s === 'local') {
    return (s as Location) ?? DEFAULT_LOCATION;
  }
  process.stderr.write(`Warning: invalid location '${s}', defaulting to 'global'.\n`);
  return DEFAULT_LOCATION;
}

function actionSymbol(action: string): string {
  switch (action) {
    case 'created': return '+';
    case 'updated': return '~';
    case 'removed': return '-';
    case 'unchanged': return '=';
    default: return '?';
  }
}

function printActionsText(target: AgentTarget, loc: Location, actions: InstallAction[]): void {
  for (const a of actions) {
    process.stdout.write(`  [${actionSymbol(a.action)}] ${a.action.padEnd(10)} ${a.path}`);
    if (a.detail) {
      process.stdout.write(`  — ${a.detail}`);
    }
    process.stdout.write('\n');
  }
}

function printActionsJson(target: AgentTarget, loc: Location, actions: InstallAction[]): void {
  // Each target's actions are emitted as a separate JSON line (jsonl) so the
  // output is streamable and parseable incrementally.
  const obj = {
    target: target.id,
    displayName: target.displayName,
    location: loc,
    actions,
  };
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------

interface StatusEntry {
  target: string;
  displayName: string;
  location: Location;
  installed: boolean;
  stale: boolean;
  configPath?: string;
  version?: string;
  paths: string[];
}

function runStatus(loc: Location, json: boolean): void {
  const entries: StatusEntry[] = [];
  for (const t of ALL_TARGETS) {
    if (!t.supportsLocation(loc)) {
      continue;
    }
    const d = t.detect(loc);
    entries.push({
      target: t.id,
      displayName: t.displayName,
      location: loc,
      installed: d.installed,
      stale: Boolean(d.stale),
      configPath: d.configPath,
      version: d.version,
      paths: t.describePaths(loc),
    });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ status: entries }, null, 2) + '\n');
    return;
  }

  process.stdout.write(`maven-indexer install status (location: ${loc})\n`);
  process.stdout.write('─'.repeat(60) + '\n');
  for (const e of entries) {
    const state = !e.installed ? 'not installed' : (e.stale ? 'installed (stale)' : 'installed');
    process.stdout.write(`  ${e.displayName.padEnd(14)}  ${state}\n`);
    if (e.configPath) {
      process.stdout.write(`    config: ${e.configPath}\n`);
    }
    if (e.version) {
      process.stdout.write(`    command: ${e.version}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// --print-mcp-config
// ---------------------------------------------------------------------------

function runPrintMcpConfig(client: string | undefined, loc: Location): void {
  if (!client) {
    // Print for all targets, separated by headers.
    for (const t of ALL_TARGETS) {
      if (!t.supportsLocation(loc)) continue;
      const { path, content } = t.printConfig(loc);
      process.stdout.write(`# ${t.displayName} — ${path}\n`);
      process.stdout.write(content);
      process.stdout.write('\n');
    }
    return;
  }
  const t = findTarget(client);
  if (!t) {
    process.stderr.write(`Error: unknown client '${client}'. Known: ${ALL_TARGETS.map(x => x.id).join(', ')}.\n`);
    process.exit(1);
  }
  if (!t.supportsLocation(loc)) {
    process.stderr.write(`Error: client '${client}' does not support location '${loc}'.\n`);
    process.exit(1);
  }
  const { path, content } = t.printConfig(loc);
  process.stdout.write(`# ${t.displayName} — ${path}\n`);
  process.stdout.write(content);
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

export function runInstall(opts: InstallCliOpts): void {
  const loc = parseLocation(opts.location);
  const json = Boolean(opts.json);

  // --status short-circuits everything.
  if (opts.status) {
    runStatus(loc, json);
    return;
  }

  // --print-mcp-config short-circuits everything (no writes).
  if (opts.printMcpConfig) {
    runPrintMcpConfig(opts.client, loc);
    return;
  }

  const targetSpec = opts.target ?? DEFAULT_TARGET;
  const targets = resolveTargets(targetSpec, loc);

  if (targets.length === 0) {
    if (targetSpec === 'none') {
      process.stdout.write('No agent writes (--target=none).\n');
    } else {
      process.stdout.write('No targets selected. Nothing to do.\n');
    }
    return;
  }

  const installOpts: InstallOptions = {
    autoAllow: opts.autoAllow,
    dryRun: opts.dryRun,
    yes: opts.yes,
  };

  if (opts.dryRun) {
    process.stdout.write(`Dry run — no files will be written.\n`);
  }
  process.stdout.write(`Installing for location: ${loc}\n`);

  for (const t of targets) {
    const actions = t.install(loc, installOpts);
    if (json) {
      printActionsJson(t, loc, actions);
    } else {
      process.stdout.write(`\n${t.displayName}:\n`);
      printActionsText(t, loc, actions);
    }
  }

  if (!opts.dryRun && !json) {
    process.stdout.write('\nDone. Re-run with --dry-run to preview changes.\n');
  }
}

export function runUninstall(opts: UninstallCliOpts): void {
  const loc = parseLocation(opts.location);
  const json = Boolean(opts.json);
  const targetSpec = opts.target ?? DEFAULT_TARGET;
  const targets = resolveTargets(targetSpec, loc);

  if (targets.length === 0) {
    if (targetSpec === 'none') {
      process.stdout.write('No agent writes (--target=none).\n');
    } else {
      process.stdout.write('No targets selected. Nothing to do.\n');
    }
    return;
  }

  const installOpts: InstallOptions = {
    dryRun: opts.dryRun,
    yes: opts.yes,
  };

  if (opts.dryRun) {
    process.stdout.write(`Dry run — no files will be modified.\n`);
  }
  process.stdout.write(`Uninstalling for location: ${loc}\n`);

  for (const t of targets) {
    const actions = t.uninstall(loc, installOpts);
    if (json) {
      printActionsJson(t, loc, actions);
    } else {
      process.stdout.write(`\n${t.displayName}:\n`);
      printActionsText(t, loc, actions);
    }
  }

  if (!opts.dryRun && !json) {
    process.stdout.write('\nDone.\n');
  }
}
