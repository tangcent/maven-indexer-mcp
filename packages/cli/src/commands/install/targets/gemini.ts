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

interface GeminiPaths {
  mcpConfig: string;
  instructions: string;
}

function pathsFor(loc: Location): GeminiPaths {
  if (loc === 'global') {
    return {
      mcpConfig: resolveHome('~/.gemini/settings.json'),
      instructions: resolveHome('~/.gemini/GEMINI.md'),
    };
  }
  return {
    mcpConfig: './.gemini/settings.json',
    instructions: './.gemini/GEMINI.md',
  };
}

export const geminiTarget: AgentTarget = {
  id: 'gemini',
  displayName: 'Gemini CLI',

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
    } catch {
      return { installed: false };
    }
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
    const { changed, config: next } = removeMcpEntry(config, MCP_KEY);
    if (changed && !opts.dryRun) {
      if (Object.keys(next).length === 0) {
        // Config is now empty → delete the file.
        fs.unlinkSync(p.mcpConfig);
        actions.push({ path: p.mcpConfig, action: 'removed', detail: 'empty settings.json deleted' });
      } else {
        writeJsonFile(p.mcpConfig, next);
        actions.push({ path: p.mcpConfig, action: 'updated', detail: `removed ${MCP_KEY} from mcpServers` });
      }
    } else if (changed && opts.dryRun) {
      // Dry-run: would remove or update.
      const wouldBeEmpty = Object.keys(next).length === 0 && fs.existsSync(p.mcpConfig);
      actions.push({
        path: p.mcpConfig,
        action: wouldBeEmpty ? 'removed' : 'updated',
        detail: `would remove ${MCP_KEY} from mcpServers`,
      });
    } else {
      actions.push({ path: p.mcpConfig, action: 'unchanged', detail: `${MCP_KEY} not found in mcpServers` });
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
