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
  setMcpEntry,
  removeMcpEntry,
  findMcpEntry,
} from './shared.js';
import {
  INSTRUCTIONS_BLOCK,
  START_MARKER,
  END_MARKER,
} from '../instructions_block.js';

const MCP_KEY = 'maven-indexer';
const PERMISSION_PREFIX = 'mcp__maven-indexer__';
const PERMISSION_WILDCARD = 'mcp__maven-indexer__*';

interface ClaudePaths {
  mcpConfig: string;
  settings: string;
  instructions: string;
}

function pathsFor(loc: Location): ClaudePaths {
  if (loc === 'global') {
    return {
      mcpConfig: resolveHome('~/.claude.json'),
      settings: resolveHome('~/.claude/settings.json'),
      instructions: resolveHome('~/.claude/CLAUDE.md'),
    };
  }
  return {
    mcpConfig: './.mcp.json',
    settings: './.claude/settings.json',
    instructions: './.claude/CLAUDE.md',
  };
}

/**
 * Surgically adds `mcp__maven-indexer__*` to `permissions.allow`, creating the
 * container if absent. Dedups. Returns `{ changed, data }`.
 */
function addPermission(data: Record<string, unknown>): { changed: boolean; data: Record<string, unknown> } {
  const next: Record<string, unknown> = { ...data };
  if (!next.permissions || typeof next.permissions !== 'object') {
    next.permissions = {};
  }
  const perms = next.permissions as Record<string, unknown>;
  if (!Array.isArray(perms.allow)) {
    perms.allow = [];
  }
  const allow = perms.allow as string[];
  if (allow.some(e => e === PERMISSION_WILDCARD || e.startsWith(PERMISSION_PREFIX))) {
    return { changed: false, data };
  }
  perms.allow = [...allow, PERMISSION_WILDCARD];
  return { changed: true, data: next };
}

/**
 * Removes all entries starting with `mcp__maven-indexer__` from `permissions.allow`.
 * Prunes empty `allow` array and empty `permissions` container. Returns `{ changed, data }`.
 */
function removePermission(data: Record<string, unknown>): { changed: boolean; data: Record<string, unknown> } {
  const perms = data.permissions as Record<string, unknown> | undefined;
  if (!perms || !Array.isArray(perms.allow)) {
    return { changed: false, data };
  }
  const allow = perms.allow as string[];
  const filtered = allow.filter(e => !e.startsWith(PERMISSION_PREFIX));
  if (filtered.length === allow.length) {
    return { changed: false, data };
  }
  const next: Record<string, unknown> = { ...data };
  const nextPerms = { ...(next.permissions as Record<string, unknown>) };
  if (filtered.length === 0) {
    delete nextPerms.allow;
    if (Object.keys(nextPerms).length === 0) {
      delete next.permissions;
    } else {
      next.permissions = nextPerms;
    }
  } else {
    nextPerms.allow = filtered;
    next.permissions = nextPerms;
  }
  return { changed: true, data: next };
}

export const claudeTarget: AgentTarget = {
  id: 'claude',
  displayName: 'Claude Code',

  supportsLocation(loc: Location): boolean {
    return loc === 'global' || loc === 'local';
  },

  describePaths(loc: Location): string[] {
    const p = pathsFor(loc);
    return [p.mcpConfig, p.settings, p.instructions];
  },

  detect(loc: Location): DetectResult {
    const p = pathsFor(loc);
    const config = readJsonFile(p.mcpConfig) as Record<string, unknown>;
    const entry = findMcpEntry(config, MCP_KEY);
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
  },

  install(loc: Location, opts: InstallOptions): InstallAction[] {
    const p = pathsFor(loc);
    const actions: InstallAction[] = [];
    const entry = resolveMcpEntry();

    // 1. MCP server entry
    const mcpExisted = fs.existsSync(p.mcpConfig);
    const config = readJsonFile(p.mcpConfig) as Record<string, unknown>;
    const { changed, config: next } = setMcpEntry(config, MCP_KEY, entry);
    if (changed && !opts.dryRun) {
      writeJsonFile(p.mcpConfig, next);
    }
    actions.push({
      path: p.mcpConfig,
      action: !changed ? 'unchanged' : (mcpExisted ? 'updated' : 'created'),
      detail: `${MCP_KEY} entry under mcpServers`,
    });

    // 2. Permissions (only when autoAllow)
    if (opts.autoAllow) {
      const settingsExisted = fs.existsSync(p.settings);
      const settings = readJsonFile(p.settings) as Record<string, unknown>;
      const permResult = addPermission(settings);
      if (permResult.changed && !opts.dryRun) {
        writeJsonFile(p.settings, permResult.data);
      }
      actions.push({
        path: p.settings,
        action: !permResult.changed ? 'unchanged' : (settingsExisted ? 'updated' : 'created'),
        detail: `permissions.allow += ${PERMISSION_WILDCARD}`,
      });
    }

    // 3. Instructions block
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
    const { changed, config: next } = removeMcpEntry(config, MCP_KEY);
    if (changed && !opts.dryRun) {
      writeJsonFile(p.mcpConfig, next);
    }
    actions.push({
      path: p.mcpConfig,
      action: changed ? 'updated' : 'unchanged',
      detail: `removed ${MCP_KEY} from mcpServers`,
    });

    // 2. Permissions
    const settings = readJsonFile(p.settings) as Record<string, unknown>;
    const permResult = removePermission(settings);
    if (!permResult.changed) {
      actions.push({ path: p.settings, action: 'unchanged', detail: 'no maven-indexer permissions found' });
    } else if (opts.dryRun) {
      const wouldBeEmpty = Object.keys(permResult.data).length === 0;
      actions.push({
        path: p.settings,
        action: wouldBeEmpty ? 'removed' : 'updated',
        detail: 'would remove maven-indexer permissions',
      });
    } else {
      const remaining = permResult.data;
      if (Object.keys(remaining).length === 0) {
        fs.unlinkSync(p.settings);
        actions.push({ path: p.settings, action: 'removed', detail: 'empty settings file deleted' });
      } else {
        writeJsonFile(p.settings, remaining);
        actions.push({ path: p.settings, action: 'updated', detail: 'removed maven-indexer permissions' });
      }
    }

    // 3. Instructions block
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
      mcpServers: {
        [MCP_KEY]: entry,
      },
    };
    return {
      path: p.mcpConfig,
      content: JSON.stringify(block, null, 2) + '\n',
    };
  },
};
