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
  resolveHome,
  resolveMcpEntry,
  setMcpEntry,
  removeMcpEntry,
  findMcpEntry,
} from './shared.js';

const MCP_KEY = 'maven-indexer';

interface WindsurfPaths {
  mcpConfig: string;
}

function pathsFor(loc: Location): WindsurfPaths {
  if (loc === 'global') {
    return {
      mcpConfig: resolveHome('~/.codeium/windsurf/mcp_config.json'),
    };
  }
  return {
    mcpConfig: './.codeium/windsurf/mcp_config.json',
  };
}

export const windsurfTarget: AgentTarget = {
  id: 'windsurf',
  displayName: 'Windsurf',

  supportsLocation(loc: Location): boolean {
    return loc === 'global' || loc === 'local';
  },

  describePaths(loc: Location): string[] {
    const p = pathsFor(loc);
    return [p.mcpConfig];
  },

  detect(loc: Location): DetectResult {
    try {
      const p = pathsFor(loc);
      const config = readJsonFile(p.mcpConfig) as Record<string, unknown>;
      const entry = findMcpEntry(config, MCP_KEY);
      if (!entry) {
        return {
          installed: false,
          configPath: p.mcpConfig,
        };
      }
      return {
        installed: true,
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

    // MCP server entry (no separate instructions file — Windsurf uses MCP server
    // `description` field only, so we only touch the JSON config here).
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

    return actions;
  },

  uninstall(loc: Location, opts: InstallOptions): InstallAction[] {
    const p = pathsFor(loc);
    const actions: InstallAction[] = [];

    const config = readJsonFile(p.mcpConfig) as Record<string, unknown>;
    const { changed, config: next } = removeMcpEntry(config, MCP_KEY);
    if (changed && !opts.dryRun) {
      if (Object.keys(next).length === 0) {
        // Config is now empty → delete the file.
        fs.unlinkSync(p.mcpConfig);
        actions.push({ path: p.mcpConfig, action: 'removed', detail: 'empty mcp_config.json deleted' });
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
