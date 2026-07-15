/**
 * Shared LLM output formatting helper (Module 3).
 *
 * Provides `trimForLlm` (returns a trimmed object for `--json --for-llm` and
 * MCP server-side use) and `renderForLlm` (returns trimmed text for `--for-llm`
 * alone). The per-command field selection is declarative via `FIELD_MAP` so
 * adding a command is a one-line change.
 *
 * Design goals (per requirements-llm-output.md):
 *   - Drop decorative elements (banners, separators, internal ids, absolute paths).
 *   - Group rows by a sensible key (e.g. results by artifact, methods by class).
 *   - Enforce a default line/token budget (200 lines) with a trailing
 *     `... (N more, refine your query)` marker when truncated.
 *   - Deterministic for a given input (no timestamps, no random ordering).
 */

export type CommandShape =
  | 'search-classes'
  | 'search-methods'
  | 'search-implementations'
  | 'get-class'
  | 'list-classes'
  | 'find-dependents'
  | 'get-dependencies'
  | 'trace'
  | 'explore'
  | 'search-artifacts'
  | 'search-resources'
  | 'info'
  | 'stats'
  | 'callers'
  | 'callees'
  | 'impact'
  | 'get-resource'
  | 'project-context';

export const DEFAULT_MAX_LINES = 200;

/**
 * Declarative per-command field selection.
 *
 * Each entry lists the keys to KEEP when trimming for LLM output. Keys not in
 * the list are dropped. Adding a command = one entry here + one entry in
 * `CommandShape`.
 */
export const FIELD_MAP: Record<CommandShape, string[]> = {
  'search-classes': ['className', 'artifacts'],
  'search-methods': ['methodName', 'className', 'artifacts'],
  'search-implementations': ['className', 'artifacts'],
  'get-class': [], // string output; trimmed by line budget, not field selection
  'list-classes': [], // array of strings; trimmed by line budget
  'find-dependents': ['groupId', 'artifactId', 'version', 'scope'],
  'get-dependencies': ['groupId', 'artifactId', 'version', 'scope', 'optional'],
  'trace': [], // composed object; trimmed by per-section line budget
  'explore': [], // composed ExploreResult; trimmed by line budget in renderForLlm
  'search-artifacts': ['groupId', 'artifactId', 'version', 'hasSource'],
  'search-resources': ['path', 'artifact'],
  'info': [],
  'stats': [],
  'callers': ['className', 'methodName', 'invokeKind', 'sites', 'artifacts'],
  'callees': ['className', 'methodName', 'invokeKind', 'sites', 'artifacts'],
  'impact': ['className', 'methodName', 'depth', 'path'],
  'get-resource': [],
  'project-context': [],
};

interface ArtifactCoord {
  groupId: string;
  artifactId: string;
  version: string;
}

/**
 * Trims a coordinate to just `g:a:v` for compactness.
 */
function coord(a: ArtifactCoord): string {
  return `${a.groupId}:${a.artifactId}:${a.version}`;
}

/**
 * Trims an artifact object to just the coordinate string.
 */
function trimArtifact(a: unknown): string {
  if (a && typeof a === 'object') {
    const obj = a as Record<string, unknown>;
    if (typeof obj.groupId === 'string' && typeof obj.artifactId === 'string' && typeof obj.version === 'string') {
      return coord({ groupId: obj.groupId, artifactId: obj.artifactId, version: obj.version });
    }
  }
  return String(a);
}

/**
 * Trims a result object for LLM consumption. Returns a trimmed object.
 *
 * For `--json --for-llm` mode: the result is a JSON-serializable object with
 * fewer fields and capped arrays.
 *
 * For `--for-llm` text mode: call `renderForLlm` instead, which calls this
 * function then renders to text.
 */
export function trimForLlm(command: CommandShape, rows: unknown, opts: { maxLines?: number }): unknown {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

  switch (command) {
    case 'search-classes':
    case 'search-implementations': {
      const items = (rows as { className: string; artifacts: ArtifactCoord[] }[]) ?? [];
      const result: { className: string; artifacts: string[] }[] = [];
      let totalLines = 0;
      let omitted = 0;
      for (const item of items) {
        const artifactStrings = item.artifacts.map(trimArtifact);
        // Each class entry uses 1 header line + 1 per artifact.
        const entryLines = 1 + artifactStrings.length;
        if (totalLines + entryLines > maxLines) {
          // Cap artifacts within this entry to fit the budget.
          const remaining = Math.max(0, maxLines - totalLines - 1);
          if (remaining > 0) {
            result.push({ className: item.className, artifacts: artifactStrings.slice(0, remaining) });
            omitted += artifactStrings.length - remaining;
          } else {
            omitted += artifactStrings.length;
          }
          // Stop after we hit the budget.
          const remainingItems = items.slice(items.indexOf(item) + 1);
          for (const r of remainingItems) {
            omitted += r.artifacts.length;
          }
          break;
        }
        result.push({ className: item.className, artifacts: artifactStrings });
        totalLines += entryLines;
      }
      if (omitted > 0) {
        return { results: result, _truncated: `... (${omitted} more, refine your query)` };
      }
      return { results: result };
    }

    case 'search-methods': {
      const items = (rows as { methodName: string; className: string; artifacts: ArtifactCoord[] }[]) ?? [];
      const result: { methodName: string; className: string; artifacts: string[] }[] = [];
      let totalLines = 0;
      let omitted = 0;
      for (const item of items) {
        const artifactStrings = item.artifacts.map(trimArtifact);
        const entryLines = 2 + artifactStrings.length;
        if (totalLines + entryLines > maxLines) {
          const remaining = Math.max(0, maxLines - totalLines - 2);
          if (remaining > 0) {
            result.push({ methodName: item.methodName, className: item.className, artifacts: artifactStrings.slice(0, remaining) });
            omitted += artifactStrings.length - remaining;
          } else {
            omitted += artifactStrings.length;
          }
          const remainingItems = items.slice(items.indexOf(item) + 1);
          for (const r of remainingItems) {
            omitted += r.artifacts.length;
          }
          break;
        }
        result.push({ methodName: item.methodName, className: item.className, artifacts: artifactStrings });
        totalLines += entryLines;
      }
      if (omitted > 0) {
        return { results: result, _truncated: `... (${omitted} more, refine your query)` };
      }
      return { results: result };
    }

    case 'get-class': {
      // String output — trim by line budget.
      const text = typeof rows === 'string' ? rows : JSON.stringify(rows, null, 2);
      const lines = text.split('\n');
      if (lines.length <= maxLines) {
        return text;
      }
      const trimmed = lines.slice(0, maxLines).join('\n');
      const omitted = lines.length - maxLines;
      return `${trimmed}\n... (${omitted} more lines, use --max-lines to see more)`;
    }

    case 'list-classes': {
      const items = (rows as string[]) ?? [];
      if (items.length <= maxLines) {
        return items;
      }
      const trimmed = items.slice(0, maxLines);
      const omitted = items.length - maxLines;
      return { results: trimmed, _truncated: `... (${omitted} more, refine your query)` };
    }

    case 'find-dependents':
    case 'get-dependencies': {
      const items = (rows as Record<string, unknown>[]) ?? [];
      const keep = FIELD_MAP[command];
      const trimmed = items.map(item => {
        const out: Record<string, unknown> = {};
        for (const k of keep) {
          if (k in item) out[k] = item[k];
        }
        return out;
      });
      if (trimmed.length <= maxLines) {
        return trimmed;
      }
      const capped = trimmed.slice(0, maxLines);
      const omitted = trimmed.length - maxLines;
      return { results: capped, _truncated: `... (${omitted} more, refine your query)` };
    }

    case 'trace': {
      // `trace` already applies per-section caps in its own command; we pass
      // through but ensure the total line budget is honored.
      return rows;
    }

    case 'explore': {
      // ExploreResult is a composed object; trimming is by line budget in renderForLlm.
      return rows;
    }

    case 'search-artifacts':
    case 'search-resources':
    case 'info':
    case 'stats':
    case 'callers':
    case 'callees':
    case 'impact':
    case 'get-resource':
    case 'project-context': {
      // These produce either string or array output; trim by line budget.
      if (typeof rows === 'string') {
        const lines = rows.split('\n');
        if (lines.length <= maxLines) return rows;
        const omitted = lines.length - maxLines;
        return `${lines.slice(0, maxLines).join('\n')}\n... (${omitted} more lines, use --max-lines to see more)`;
      }
      return rows;
    }

    default: {
      return rows;
    }
  }
}

/**
 * Renders a trimmed result as text for `--for-llm` (without `--json`) mode.
 *
 * Calls `trimForLlm` then renders the trimmed object to compact text.
 */
export function renderForLlm(command: CommandShape, rows: unknown, opts: { maxLines?: number }): string {
  const trimmed = trimForLlm(command, rows, opts);
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

  switch (command) {
    case 'search-classes':
    case 'search-implementations': {
      const obj = trimmed as { results: { className: string; artifacts: string[] }[]; _truncated?: string };
      if (!obj.results || obj.results.length === 0) {
        return 'No classes found.';
      }
      const lines: string[] = [];
      for (const item of obj.results) {
        lines.push(item.className);
        for (const a of item.artifacts) {
          lines.push(`  ${a}`);
        }
      }
      if (obj._truncated) lines.push(obj._truncated);
      return lines.join('\n');
    }

    case 'search-methods': {
      const obj = trimmed as { results: { methodName: string; className: string; artifacts: string[] }[]; _truncated?: string };
      if (!obj.results || obj.results.length === 0) {
        return 'No methods found.';
      }
      const lines: string[] = [];
      for (const item of obj.results) {
        lines.push(`${item.className}#${item.methodName}`);
        for (const a of item.artifacts) {
          lines.push(`  ${a}`);
        }
      }
      if (obj._truncated) lines.push(obj._truncated);
      return lines.join('\n');
    }

    case 'get-class': {
      return typeof trimmed === 'string' ? trimmed : JSON.stringify(trimmed, null, 2);
    }

    case 'list-classes': {
      if (Array.isArray(trimmed)) {
        const items = trimmed as string[];
        if (items.length === 0) return 'No classes found.';
        return items.join('\n');
      }
      const obj = trimmed as { results: string[]; _truncated?: string };
      if (!obj.results || obj.results.length === 0) return 'No classes found.';
      const lines = [...obj.results];
      if (obj._truncated) lines.push(obj._truncated);
      return lines.join('\n');
    }

    case 'find-dependents':
    case 'get-dependencies': {
      if (Array.isArray(trimmed)) {
        const items = trimmed as Record<string, unknown>[];
        if (items.length === 0) return 'No results found.';
        return items.map(d => {
          const g = d.groupId ?? '';
          const a = d.artifactId ?? '';
          const v = d.version ? `:${d.version}` : '';
          const s = d.scope ? ` (scope: ${d.scope})` : '';
          const o = d.optional ? ' (optional)' : '';
          return `${g}:${a}${v}${s}${o}`;
        }).join('\n');
      }
      const obj = trimmed as { results: Record<string, unknown>[]; _truncated?: string };
      if (!obj.results || obj.results.length === 0) return 'No results found.';
      const lines = obj.results.map(d => {
        const g = d.groupId ?? '';
        const a = d.artifactId ?? '';
        const v = d.version ? `:${d.version}` : '';
        const s = d.scope ? ` (scope: ${d.scope})` : '';
        const o = d.optional ? ' (optional)' : '';
        return `${g}:${a}${v}${s}${o}`;
      });
      if (obj._truncated) lines.push(obj._truncated);
      return lines.join('\n');
    }

    case 'trace': {
      // Trace has its own composed output; just JSON-stringify if it's not a string.
      return typeof trimmed === 'string' ? trimmed : JSON.stringify(trimmed, null, 2);
    }

    case 'explore': {
      // ExploreResult is a composed object; render to compact text with line budget.
      return renderExploreForLlm(trimmed, maxLines);
    }

    case 'search-artifacts':
    case 'search-resources':
    case 'info':
    case 'stats':
    case 'callers':
    case 'callees':
    case 'impact':
    case 'get-resource':
    case 'project-context': {
      return typeof trimmed === 'string' ? trimmed : JSON.stringify(trimmed, null, 2);
    }

    default: {
      return typeof trimmed === 'string' ? trimmed : JSON.stringify(trimmed, null, 2);
    }
  }
}

/**
 * Renders an ExploreResult object to compact text for LLM consumption.
 * Groups sections, caps total lines, appends a truncation marker.
 */
function renderExploreForLlm(result: unknown, maxLines: number): string {
  if (typeof result === 'string') return result;
  const obj = result as Record<string, unknown>;
  const lines: string[] = [];

  const classes = obj.classes as Array<Record<string, unknown>> | undefined;
  if (classes && classes.length > 0) {
    for (const c of classes) {
      lines.push(`### ${c.className}`);
      const art = c.artifact as string | undefined;
      if (art) lines.push(`Artifact: ${art}`);
      const sigs = c.signatures as string[] | undefined;
      if (sigs) { lines.push('Methods:'); for (const s of sigs) lines.push(`  ${s}`); }
      const src = c.source as string | undefined;
      if (src) { lines.push('```' + (c.language || 'java')); lines.push(src); lines.push('```'); }
    }
  }

  const impls = obj.implementations as Array<Record<string, unknown>> | undefined;
  if (impls && impls.length > 0) {
    lines.push(`\n### Implementations (${impls.length})`);
    for (const i of impls) {
      const art = i.artifact as string | undefined;
      lines.push(`  ${i.className}${art ? '  [' + art + ']' : ''}`);
    }
  }

  const callers = obj.callers as Array<Record<string, unknown>> | undefined;
  if (callers && callers.length > 0) {
    lines.push(`\n### Callers (${callers.length})`);
    for (const c of callers) {
      const art = c.artifact as string | undefined;
      lines.push(`  ${c.className}.${c.methodName} (${c.sites} sites)${art ? '  [' + art + ']' : ''}`);
    }
  }

  const callees = obj.callees as Array<Record<string, unknown>> | undefined;
  if (callees && callees.length > 0) {
    lines.push(`\n### Callees (${callees.length})`);
    for (const c of callees) {
      const art = c.artifact as string | undefined;
      lines.push(`  ${c.className}.${c.methodName} (${c.sites} sites)${art ? '  [' + art + ']' : ''}`);
    }
  }

  const path = obj.path as Array<Record<string, unknown>> | undefined;
  if (path && path.length > 0) {
    lines.push(`\n### Path`);
    for (const s of path) lines.push(`  ${s.from} -> ${s.to}`);
  }

  const meta = obj._meta as Record<string, unknown> | undefined;
  if (meta) {
    lines.push('\n### Meta');
    lines.push(`callGraphAvailable: ${meta.callGraphAvailable}`);
    const resolved = meta.resolved as Record<string, unknown> | undefined;
    if (resolved) {
      for (const [id, info] of Object.entries(resolved)) {
        const r = info as Record<string, unknown>;
        lines.push(`  ${id} -> ${r.artifact} (${r.policy})`);
      }
    }
    if (meta.unresolved) lines.push(`unresolved: ${JSON.stringify(meta.unresolved)}`);
  }

  if (lines.length <= maxLines) return lines.join('\n');
  const omitted = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join('\n')}\n... (${omitted} more lines, use --max-lines to see more)`;
}
