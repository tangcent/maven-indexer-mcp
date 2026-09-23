import fs from 'fs';
import {
  AgentTarget,
  DetectResult,
  InstallAction,
  InstallOptions,
  Location,
} from '../types.js';
import {
  readJsonFile,
  writeJsonFile,
  replaceOrAppendMarkedSection,
  removeMarkedSection,
  computeMarkedSectionAction,
  computeRemoveMarkedSectionAction,
  resolveHome,
  resolveMcpEntry,
  jsonDeepEqual,
} from './shared.js';
import {
  INSTRUCTIONS_BLOCK,
  START_MARKER,
  END_MARKER,
} from '../instructions_block.js';

const MCP_KEY = 'maven-indexer';

interface OpencodePaths {
  mcpConfig: string;
  instructions: string;
}

function pathsFor(loc: Location): OpencodePaths {
  if (loc === 'global') {
    return {
      mcpConfig: resolveHome('~/.config/opencode/opencode.json'),
      instructions: resolveHome('~/.config/opencode/AGENTS.md'),
    };
  }
  return {
    mcpConfig: './.opencode.json',
    instructions: './AGENTS.md',
  };
}

/**
 * Finds the MCP server entry for `key` under the `mcp.servers` path (opencode's
 * nesting convention, distinct from the `mcpServers` top-level used by
 * Claude/Cursor/Gemini/Windsurf). Returns the entry if present, else undefined.
 */
function findOpencodeEntry(config: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp || typeof mcp !== 'object') return undefined;
  const servers = mcp.servers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object') return undefined;
  const entry = servers[key];
  if (entry && typeof entry === 'object') {
    return entry as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Surgically sets `mcp.servers[key]` on a config object, creating the `mcp` and
 * `mcp.servers` containers if absent. Returns `{ changed, config }` where
 * `config` is the new object (mutated copy).
 */
function setOpencodeEntry(
  config: Record<string, unknown>,
  key: string,
  entry: Record<string, unknown>,
): { changed: boolean; config: Record<string, unknown> } {
  const next: Record<string, unknown> = { ...config };
  if (!next.mcp || typeof next.mcp !== 'object') {
    next.mcp = {};
  }
  const mcp = next.mcp as Record<string, unknown>;
  if (!mcp.servers || typeof mcp.servers !== 'object') {
    mcp.servers = {};
  }
  const servers = mcp.servers as Record<string, unknown>;
  if (jsonDeepEqual(servers[key], entry)) {
    return { changed: false, config };
  }
  servers[key] = entry;
  return { changed: true, config: next };
}

/**
 * Surgically removes `mcp.servers[key]`. Prunes the `servers` container and the
 * `mcp` container if either becomes empty. Returns `{ changed, config }`.
 */
function removeOpencodeEntry(
  config: Record<string, unknown>,
  key: string,
): { changed: boolean; config: Record<string, unknown> } {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp) return { changed: false, config };
  const servers = mcp.servers as Record<string, unknown> | undefined;
  if (!servers || !(key in servers)) {
    return { changed: false, config };
  }
  const next: Record<string, unknown> = { ...config };
  const nextMcp = { ...(next.mcp as Record<string, unknown>) };
  const nextServers = { ...(nextMcp.servers as Record<string, unknown>) };
  delete nextServers[key];
  if (Object.keys(nextServers).length === 0) {
    delete nextMcp.servers;
    if (Object.keys(nextMcp).length === 0) {
      delete next.mcp;
    } else {
      next.mcp = nextMcp;
    }
  } else {
    nextMcp.servers = nextServers;
    next.mcp = nextMcp;
  }
  return { changed: true, config: next };
}

export const opencodeTarget: AgentTarget = {
  id: 'opencode',
  displayName: 'opencode',

  supportsLocation(loc: Location): boolean {
    return loc === 'global' || loc === 'local';
  },

  describePaths(loc: Location): string[] {
    const p = pathsFor(loc);
    return [p.mcpConfig, p.instructions];
  },

  detect(loc: Location): DetectResult {
    try {
      const p = pathsFor(loc);
      const config = readJsonFile(p.mcpConfig) as Record<string, unknown>;
      const entry = findOpencodeEntry(config, MCP_KEY);
      if (!entry) {
        // Maybe the instructions block is present but MCP isn't — still report stale.
        const instrAction = computeMarkedSectionAction(p.instructions, INSTRUCTIONS_BLOCK, START_MARKER, END_MARKER);
        return {
          installed: instrAction !== 'created',
          stale: instrAction === 'updated',
          configPath: p.mcpConfig,
        };
      }
      const instrAction = computeMarkedSectionAction(p.instructions, INSTRUCTIONS_BLOCK, START_MARKER, END_MARKER);
      return {
        installed: true,
        stale: instrAction === 'updated',
        configPath: p.mcpConfig,
        version: typeof entry.command === 'string' ? String(entry.command) : undefined,
      };
    } catch {
      return { installed: false };
    }
  },

  install(loc: Location, opts: InstallOptions): InstallAction[] {
    const p = pathsFor(loc);
    const actions: InstallAction[] = [];
    const entry = resolveMcpEntry();

    // 1. MCP server entry (under mcp.servers, not mcpServers)
    const mcpExisted = fs.existsSync(p.mcpConfig);
    const config = readJsonFile(p.mcpConfig) as Record<string, unknown>;
    const { changed, config: next } = setOpencodeEntry(config, MCP_KEY, entry);
    if (changed && !opts.dryRun) {
      writeJsonFile(p.mcpConfig, next);
    }
    actions.push({
      path: p.mcpConfig,
      action: !changed ? 'unchanged' : (mcpExisted ? 'updated' : 'created'),
      detail: `${MCP_KEY} entry under mcp.servers`,
    });

    // 2. Instructions block
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

    // 1. MCP server entry
    const config = readJsonFile(p.mcpConfig) as Record<string, unknown>;
    const { changed, config: next } = removeOpencodeEntry(config, MCP_KEY);
    if (changed && !opts.dryRun) {
      if (Object.keys(next).length === 0) {
        // Config is now empty → delete the file.
        fs.unlinkSync(p.mcpConfig);
        actions.push({ path: p.mcpConfig, action: 'removed', detail: 'empty opencode.json deleted' });
      } else {
        writeJsonFile(p.mcpConfig, next);
        actions.push({ path: p.mcpConfig, action: 'updated', detail: `removed ${MCP_KEY} from mcp.servers` });
      }
    } else if (changed && opts.dryRun) {
      // Dry-run: would remove or update.
      const wouldBeEmpty = Object.keys(next).length === 0 && fs.existsSync(p.mcpConfig);
      actions.push({
        path: p.mcpConfig,
        action: wouldBeEmpty ? 'removed' : 'updated',
        detail: `would remove ${MCP_KEY} from mcp.servers`,
      });
    } else {
      actions.push({ path: p.mcpConfig, action: 'unchanged', detail: `${MCP_KEY} not found in mcp.servers` });
    }

    // 2. Instructions block
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
    const block = {
      mcp: {
        servers: {
          [MCP_KEY]: entry,
        },
      },
    };
    return {
      path: p.mcpConfig,
      content: JSON.stringify(block, null, 2) + '\n',
    };
  },
};
