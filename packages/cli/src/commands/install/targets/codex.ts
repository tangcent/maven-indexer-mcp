import fs from 'fs';
import {
  AgentTarget,
  DetectResult,
  InstallAction,
  InstallOptions,
  Location,
} from '../types.js';
import {
  atomicWriteFileSync,
  replaceOrAppendMarkedSection,
  removeMarkedSection,
  computeMarkedSectionAction,
  computeRemoveMarkedSectionAction,
  resolveHome,
  resolveMcpEntry,
} from './shared.js';
import {
  INSTRUCTIONS_BLOCK,
  START_MARKER,
  END_MARKER,
} from '../instructions_block.js';

const MCP_KEY = 'maven-indexer';

interface CodexPaths {
  mcpConfig: string;
  instructions: string;
}

function pathsFor(loc: Location): CodexPaths {
  // Codex is GLOBAL-ONLY; loc is always 'global' here, but we accept the
  // parameter to satisfy the AgentTarget contract.
  void loc;
  return {
    mcpConfig: resolveHome('~/.codex/config.toml'),
    instructions: resolveHome('~/.codex/AGENTS.md'),
  };
}

// === Inline TOML helpers (scoped to this target — no shared toml module) ===

/**
 * Converts a resolved MCP entry to a TOML `[mcp_servers.<key>]` block (no
 * trailing newline). Omits `args` when empty.
 */
function entryToTomlBlock(key: string, entry: Record<string, unknown>): string {
  const lines: string[] = [`[mcp_servers.${key}]`];
  const command = entry.command;
  const args = entry.args;
  if (typeof command === 'string') {
    lines.push(`command = "${command}"`);
  }
  if (Array.isArray(args) && args.length > 0) {
    const argsStr = args.map(a => `"${a}"`).join(', ');
    lines.push(`args = [${argsStr}]`);
  }
  return lines.join('\n');
}

/**
 * Parses a single TOML value (string or array of strings) into string[].
 */
function parseTomlValue(v: string): string[] | null {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    const items: string[] = [];
    const re = /"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(inner)) !== null) {
      items.push(m[1]);
    }
    return items;
  }
  if (v.startsWith('"') && v.endsWith('"')) {
    return [v.slice(1, -1)];
  }
  return [v];
}

/**
 * Reads and parses `mcp_servers.*` sections from a TOML file.
 * Returns Map<serverName, Map<key, string[]>>. Empty Map if missing/malformed
 * (malformed files are backed up to `<path>.backup`).
 */
function readTomlFile(filePath: string): Map<string, Map<string, string[]>> {
  const result = new Map<string, Map<string, string[]>>();
  if (!fs.existsSync(filePath)) {
    return result;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }
  try {
    const lines = raw.split('\n');
    let currentServer: string | null = null;
    let currentMap: Map<string, string[]> | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      const m = trimmed.match(/^\[mcp_servers\.([^\]]+)\]$/);
      if (m) {
        currentServer = m[1];
        currentMap = new Map();
        result.set(currentServer, currentMap);
        continue;
      }
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        // Entering a non-mcp_servers section.
        currentServer = null;
        currentMap = null;
        continue;
      }
      if (!currentServer || !currentMap) continue;
      const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (!kvMatch) continue;
      const values = parseTomlValue(kvMatch[2]);
      if (values) {
        currentMap.set(kvMatch[1], values);
      }
    }
    return result;
  } catch {
    const backup = `${filePath}.backup`;
    try {
      fs.copyFileSync(filePath, backup);
      process.stderr.write(`Warning: ${filePath} was unparseable; backed up to ${backup}\n`);
    } catch {
      // best-effort
    }
    return result;
  }
}

/**
 * Serializes a Map<serverName, Map<key, string[]>> to TOML and writes it.
 */
function writeTomlFile(filePath: string, data: Map<string, Map<string, string[]>>): void {
  let content = '';
  for (const [server, keys] of data) {
    content += `[mcp_servers.${server}]\n`;
    for (const [k, values] of keys) {
      if (values.length === 1) {
        content += `${k} = "${values[0]}"\n`;
      } else if (values.length > 1) {
        const argsStr = values.map(v => `"${v}"`).join(', ');
        content += `${k} = [${argsStr}]\n`;
      }
    }
    content += '\n';
  }
  atomicWriteFileSync(filePath, content);
}

/**
 * Returns true if a `[mcp_servers.<key>]` section exists in the TOML text.
 */
function findTomlMcpEntry(tomlText: string, key: string): boolean {
  const header = `[mcp_servers.${key}]`;
  const lines = tomlText.split('\n');
  for (const line of lines) {
    if (line.trim() === header) {
      return true;
    }
  }
  return false;
}

/**
 * Finds the line range [start, end) of a `[mcp_servers.<header>]` section.
 * The section spans from its header line to the next `[...]` section header
 * (exclusive) or EOF. Trailing blank lines within the section are trimmed.
 */
function findTomlSectionLineRange(
  lines: string[],
  header: string,
): { start: number; end: number } | undefined {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      end = i;
      break;
    }
  }
  // Trim trailing empty lines from the section (keep at least the header line).
  while (end > start + 1 && lines[end - 1].trim() === '') {
    end--;
  }
  return { start, end };
}

/**
 * Surgically inserts or replaces the `[mcp_servers.<key>]` section in TOML
 * text, preserving all other content. Returns `{ changed, content }`.
 */
function setTomlMcpEntry(
  tomlText: string,
  key: string,
  entry: Record<string, unknown>,
): { changed: boolean; content: string } {
  const header = `[mcp_servers.${key}]`;
  const newBlockLines = entryToTomlBlock(key, entry).split('\n');
  const lines = tomlText.split('\n');
  const range = findTomlSectionLineRange(lines, header);

  if (!range) {
    // Append — ensure newline separation from existing content.
    let content = tomlText;
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }
    content += newBlockLines.join('\n') + '\n';
    return { changed: true, content };
  }

  // Compare existing section to new block (exact line match).
  const existingSectionLines = lines.slice(range.start, range.end);
  const matches =
    existingSectionLines.length === newBlockLines.length &&
    existingSectionLines.every((line, i) => line === newBlockLines[i]);
  if (matches) {
    return { changed: false, content: tomlText };
  }

  // Replace the section lines.
  const before = lines.slice(0, range.start);
  const after = lines.slice(range.end);
  const newLines = [...before, ...newBlockLines, ...after];
  let content = newLines.join('\n');
  if (!content.endsWith('\n')) {
    content += '\n';
  }
  return { changed: true, content };
}

/**
 * Surgically removes the `[mcp_servers.<key>]` section from TOML text.
 * Collapses any double blank lines left behind. Returns `{ changed, content }`.
 */
function removeTomlMcpEntry(
  tomlText: string,
  key: string,
): { changed: boolean; content: string } {
  const header = `[mcp_servers.${key}]`;
  const lines = tomlText.split('\n');
  const range = findTomlSectionLineRange(lines, header);

  if (!range) {
    return { changed: false, content: tomlText };
  }

  const before = lines.slice(0, range.start);
  const after = lines.slice(range.end);
  const newLines = [...before, ...after];
  let content = newLines.join('\n');
  // Collapse 3+ newlines (2+ blank lines) into a single blank line.
  content = content.replace(/\n{3,}/g, '\n\n');
  // Trim leading blank lines.
  content = content.replace(/^\n+/, '');
  if (content.length > 0 && !content.endsWith('\n')) {
    content += '\n';
  }
  return { changed: true, content };
}

/** Reads a file as UTF-8 text, returning '' if missing/unreadable. */
function readRawText(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export const codexTarget: AgentTarget = {
  id: 'codex',
  displayName: 'Codex',

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  },

  describePaths(loc: Location): string[] {
    const p = pathsFor(loc);
    return [p.mcpConfig, p.instructions];
  },

  detect(loc: Location): DetectResult {
    try {
      const p = pathsFor(loc);
      const raw = readRawText(p.mcpConfig);
      const exists = findTomlMcpEntry(raw, MCP_KEY);
      const instrAction = computeMarkedSectionAction(
        p.instructions, INSTRUCTIONS_BLOCK, START_MARKER, END_MARKER,
      );
      if (!exists) {
        return {
          installed: instrAction !== 'created',
          stale: instrAction === 'updated',
          configPath: p.mcpConfig,
        };
      }
      const data = readTomlFile(p.mcpConfig);
      const command = data.get(MCP_KEY)?.get('command')?.[0];
      return {
        installed: true,
        stale: instrAction === 'updated',
        configPath: p.mcpConfig,
        version: command,
      };
    } catch {
      return { installed: false };
    }
  },

  install(loc: Location, opts: InstallOptions): InstallAction[] {
    const p = pathsFor(loc);
    const actions: InstallAction[] = [];
    const entry = resolveMcpEntry();

    // 1. MCP server entry (TOML, surgical text edit)
    const mcpExisted = fs.existsSync(p.mcpConfig);
    const raw = readRawText(p.mcpConfig);
    const { changed, content } = setTomlMcpEntry(raw, MCP_KEY, entry);
    if (changed && !opts.dryRun) {
      atomicWriteFileSync(p.mcpConfig, content);
    }
    actions.push({
      path: p.mcpConfig,
      action: !changed ? 'unchanged' : (mcpExisted ? 'updated' : 'created'),
      detail: `${MCP_KEY} entry under mcp_servers (TOML)`,
    });

    // 2. Instructions block (AGENTS.md)
    const instrAction = opts.dryRun
      ? computeMarkedSectionAction(p.instructions, INSTRUCTIONS_BLOCK, START_MARKER, END_MARKER)
      : replaceOrAppendMarkedSection(p.instructions, INSTRUCTIONS_BLOCK, START_MARKER, END_MARKER);
    actions.push({
      path: p.instructions,
      action: instrAction,
      detail: 'marker-fenced instructions block',
    });

    return actions;
  },

  uninstall(loc: Location, opts: InstallOptions): InstallAction[] {
    const p = pathsFor(loc);
    const actions: InstallAction[] = [];

    // 1. MCP server entry (TOML)
    const raw = readRawText(p.mcpConfig);
    const { changed, content } = removeTomlMcpEntry(raw, MCP_KEY);
    if (!changed) {
      actions.push({ path: p.mcpConfig, action: 'unchanged', detail: `${MCP_KEY} not found in mcp_servers` });
    } else if (opts.dryRun) {
      const wouldBeEmpty = content.trim() === '';
      actions.push({
        path: p.mcpConfig,
        action: wouldBeEmpty ? 'removed' : 'updated',
        detail: `would remove ${MCP_KEY} from mcp_servers`,
      });
    } else {
      if (content.trim() === '') {
        if (fs.existsSync(p.mcpConfig)) {
          fs.unlinkSync(p.mcpConfig);
        }
        actions.push({ path: p.mcpConfig, action: 'removed', detail: 'empty config.toml deleted' });
      } else {
        atomicWriteFileSync(p.mcpConfig, content);
        actions.push({ path: p.mcpConfig, action: 'updated', detail: `removed ${MCP_KEY} from mcp_servers` });
      }
    }

    // 2. Instructions block (AGENTS.md)
    const instrResult = opts.dryRun
      ? computeRemoveMarkedSectionAction(p.instructions, START_MARKER, END_MARKER)
      : removeMarkedSection(p.instructions, START_MARKER, END_MARKER);
    actions.push({
      path: p.instructions,
      action: instrResult,
      detail: 'marker-fenced instructions block',
    });

    return actions;
  },

  printConfig(loc: Location): { path: string; content: string } {
    const p = pathsFor(loc);
    const entry = resolveMcpEntry();
    const block = entryToTomlBlock(MCP_KEY, entry);
    return {
      path: p.mcpConfig,
      content: block + '\n',
    };
  },
};

// Keep writeTomlFile referenced for tooling/exports (used by tests).
void writeTomlFile;
