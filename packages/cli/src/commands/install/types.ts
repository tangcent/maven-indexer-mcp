/**
 * Type definitions for the `install` command (Module 7).
 *
 * The `AgentTarget` interface is the contract every agent-client target
 * implements. Adding a client = one file in `targets/` + one line in
 * `registry.ts`.
 */

export type Location = 'global' | 'local';

export interface InstallOptions {
  /** Auto-approve MCP tool calls (Claude: adds `mcp__maven-indexer__*` to permissions.allow). */
  autoAllow?: boolean;
  /** Print the plan without writing anything. */
  dryRun?: boolean;
  /** Non-interactive defaults (no confirmation prompts). */
  yes?: boolean;
}

export type ActionKind = 'created' | 'updated' | 'unchanged' | 'removed';

export interface InstallAction {
  /** Absolute (or project-relative) path that was touched. */
  path: string;
  action: ActionKind;
  /** Human-readable detail (e.g. "added maven-indexer to mcpServers"). */
  detail?: string;
}

export interface InstallPlan {
  targetId: string;
  location: Location;
  actions: InstallAction[];
}

export interface DetectResult {
  installed: boolean;
  /** Markers present but content differs from current instructions block. */
  stale?: boolean;
  configPath?: string;
  version?: string;
}

/**
 * Uniform per-target interface. Each agent client (Claude Code, Cursor, etc.)
 * implements this; the orchestrator dispatches across the registry.
 */
export interface AgentTarget {
  id: string;
  displayName: string;
  supportsLocation(loc: Location): boolean;
  /** Probe whether this target is installed at `loc`. Never throws. */
  detect(loc: Location): DetectResult;
  /** Write MCP config, permissions, and instructions block. Returns actions taken. */
  install(loc: Location, opts: InstallOptions): InstallAction[];
  /** Remove MCP config, permissions, and instructions block. Returns actions taken. */
  uninstall(loc: Location, opts: InstallOptions): InstallAction[];
  /** Print the MCP config block without writing. */
  printConfig(loc: Location): { path: string; content: string };
  /** List the filesystem paths this target touches at `loc` (for status display). */
  describePaths(loc: Location): string[];
}
