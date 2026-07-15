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
  writeWholeFile,
  computeWholeFileAction,
  removeWholeFile,
} from './shared.js';
import { INSTRUCTIONS_BLOCK } from '../instructions_block.js';

const MCP_KEY = 'maven-indexer';

interface CursorPaths {
  mcpConfig: string;
  rules: string;
}

function pathsFor(loc: Location): CursorPaths {
  if (loc === 'global') {
    return {
      mcpConfig: resolveHome('~/.cursor/mcp.json'),
      rules: resolveHome('~/.cursor/rules/maven-indexer.mdc'),
    };
  }
  return {
    mcpConfig: './.cursor/mcp.json',
    rules: './.cursor/rules/maven-indexer.mdc',
  };
}

/**
 * Cursor rules (.mdc) file content. YAML frontmatter + the standard
 * instructions block. The markers inside the block are harmless HTML comments
 * and keep a single source of truth across targets.
 */
const RULES_CONTENT = `---
description: When to reach for maven-indexer-cli (unknown Java/Kotlin imports)
globs: "**/*.java,**/*.kt,**/*.scala"
alwaysApply: false
---
${INSTRUCTIONS_BLOCK}
`;

export const cursorTarget: AgentTarget = {
  id: 'cursor',
  displayName: 'Cursor',

  supportsLocation(loc: Location): boolean {
    return loc === 'global' || loc === 'local';
  },

  describePaths(loc: Location): string[] {
    const p = pathsFor(loc);
    return [p.mcpConfig, p.rules];
  },

  detect(loc: Location): DetectResult {
    const p = pathsFor(loc);
    const config = readJsonFile(p.mcpConfig) as Record<string, unknown>;
    const entry = findMcpEntry(config, MCP_KEY);
    if (!entry) {
      // Maybe the rules file is present but MCP isn't.
      const rulesAction = computeWholeFileAction(p.rules, RULES_CONTENT);
      return {
        installed: rulesAction !== 'created',
        stale: rulesAction === 'updated',
        configPath: p.mcpConfig,
      };
    }
    const rulesAction = computeWholeFileAction(p.rules, RULES_CONTENT);
    return {
      installed: true,
      stale: rulesAction === 'updated',
      configPath: p.mcpConfig,
      version: typeof entry.command === 'string' ? String(entry.command) : undefined,
    };
  },

  install(loc: Location, opts: InstallOptions): InstallAction[] {
    const p = pathsFor(loc);
    const actions: InstallAction[] = [];
    const entry = resolveMcpEntry();

    // 1. MCP server entry
    const config = readJsonFile(p.mcpConfig) as Record<string, unknown>;
    const { changed, config: next } = setMcpEntry(config, MCP_KEY, entry);
    let mcpAction: 'created' | 'updated' | 'unchanged';
    if (!changed) {
      mcpAction = 'unchanged';
    } else if (opts.dryRun) {
      mcpAction = fs.existsSync(p.mcpConfig) ? 'updated' : 'created';
    } else {
      writeJsonFile(p.mcpConfig, next);
      mcpAction = 'updated';
    }
    actions.push({
      path: p.mcpConfig,
      action: mcpAction,
      detail: `${MCP_KEY} entry under mcpServers`,
    });

    // 2. Rules file (.mdc) — whole-file write
    const rulesAction = writeWholeFile(p.rules, RULES_CONTENT, Boolean(opts.dryRun));
    actions.push({
      path: p.rules,
      action: rulesAction,
      detail: 'Cursor rules file (frontmatter + instructions block)',
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
        actions.push({ path: p.mcpConfig, action: 'removed', detail: 'empty mcp.json deleted' });
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

    // 2. Rules file
    const rulesAction = removeWholeFile(p.rules, Boolean(opts.dryRun));
    actions.push({
      path: p.rules,
      action: rulesAction,
      detail: 'Cursor rules file',
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
