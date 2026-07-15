import { Artifact, ArtifactInfo, IndexStats, CallEdgeResult, ImpactNode } from './indexer.js';
import { CommandShape, trimForLlm, renderForLlm } from './llm_format.js';

/** Missing artifact row (mirrors the CLI `doctor` command shape). */
export interface MissingArtifact {
  id: number;
  groupId: string;
  artifactId: string;
  version: string;
  abspath: string;
  layout: string | null;
}

/** Trace result shape (mirrors the CLI `trace` command shape). */
export interface TraceClassResult {
  className: string;
  artifact: string;
  signatures: string[];
}
export interface TraceNeighborResult {
  className: string;
  artifact: string;
}
export interface TraceCallEdgeResult {
  className: string;
  methodName: string;
  artifact: string;
  sites: number;
}
export interface TraceMeta {
  status: 'found' | 'not_found';
  callGraphAvailable: boolean;
  truncated: {
    implementations: number;
    callers: number;
    callees: number;
  };
}
export interface TraceResult {
  class: TraceClassResult | null;
  implementations: TraceNeighborResult[];
  callers: TraceCallEdgeResult[];
  callees: TraceCallEdgeResult[];
  _meta: TraceMeta;
}

export type CommandResult =
  | { command: 'search-classes'; result: { className: string; artifacts: Artifact[] }[] }
  | { command: 'search-artifacts'; result: Artifact[] }
  | { command: 'search-implementations'; result: { className: string; artifacts: Artifact[] }[] }
  | { command: 'search-resources'; result: { path: string; artifact: Artifact }[] }
  | { command: 'search-methods'; result: { methodName: string; className: string; artifacts: Artifact[] }[] }
  | { command: 'get-class'; result: string }
  | { command: 'info'; result: ArtifactInfo[] }
  | { command: 'stats'; result: IndexStats }
  | { command: 'list-classes'; result: string[] }
  | { command: 'get-resource'; result: { path: string; content: string; type: string } | null }
  | { command: 'get-dependencies'; result: { groupId: string; artifactId: string; version: string; scope: string; optional: boolean }[] }
  | { command: 'find-dependents'; result: { groupId: string; artifactId: string; version: string; scope: string }[] }
  | { command: 'callers'; result: { target: { className: string; methodName?: string }; edges: CallEdgeResult[]; callGraphAvailable: boolean } }
  | { command: 'callees'; result: { target: { className: string; methodName?: string }; edges: CallEdgeResult[]; callGraphAvailable: boolean } }
  | { command: 'impact'; result: { target: { className: string; methodName?: string }; nodes: ImpactNode[]; truncated: number; callGraphAvailable: boolean; maxDepth: number; maxNodes: number; format: 'flat' | 'tree' } }
  | { command: 'trace'; result: TraceResult }
  | { command: 'doctor'; result: MissingArtifact[] }
  | { command: string; result: unknown };

const LLM_SUPPORTED: Set<string> = new Set<string>([
  'search-classes',
  'search-methods',
  'search-implementations',
  'get-class',
  'list-classes',
  'find-dependents',
  'get-dependencies',
  'trace',
]);

export interface PrintOpts {
  json?: boolean;
  forLlm?: boolean;
  maxLines?: number;
}

export function print(command: CommandResult['command'], result: unknown, opts: PrintOpts): void {
  // --json --for-llm: trimmed JSON payload (fewer fields, capped arrays).
  if (opts.json && opts.forLlm && LLM_SUPPORTED.has(command)) {
    const trimmed = trimForLlm(command as CommandShape, result, { maxLines: opts.maxLines });
    process.stdout.write(JSON.stringify(trimmed, null, 2) + '\n');
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  // --for-llm alone (no --json): trimmed human-readable text.
  if (opts.forLlm && LLM_SUPPORTED.has(command)) {
    const text = renderForLlm(command as CommandShape, result, { maxLines: opts.maxLines });
    process.stdout.write(text + '\n');
    return;
  }

  let text: string;

  switch (command) {
    case 'search-classes': {
      const items = result as { className: string; artifacts: Artifact[] }[];
      if (items.length === 0) {
        text = 'No classes found.';
      } else {
        text = items.map(m => {
          const arts = m.artifacts.map(a => `  ${a.groupId}:${a.artifactId}:${a.version}`).join('\n');
          return `Class: ${m.className}\n${arts}`;
        }).join('\n\n');
      }
      break;
    }
    case 'search-artifacts': {
      const items = result as Artifact[];
      if (items.length === 0) {
        text = 'No artifacts found.';
      } else {
        text = items.map(a => `${a.groupId}:${a.artifactId}:${a.version} (Has Source: ${Boolean(a.hasSource)})`).join('\n');
      }
      break;
    }
    case 'search-implementations': {
      const items = result as { className: string; artifacts: Artifact[] }[];
      if (items.length === 0) {
        text = 'No implementations found.';
      } else {
        text = items.map(m => {
          const arts = m.artifacts.map(a => `  ${a.groupId}:${a.artifactId}:${a.version}`).join('\n');
          return `Implementation: ${m.className}\n${arts}`;
        }).join('\n\n');
      }
      break;
    }
    case 'search-resources': {
      const items = result as { path: string; artifact: Artifact }[];
      if (items.length === 0) {
        text = 'No resources found.';
      } else {
        text = items.map(m =>
          `Resource: ${m.path}\n  Artifact: ${m.artifact.groupId}:${m.artifact.artifactId}:${m.artifact.version}`
        ).join('\n\n');
      }
      break;
    }
    case 'search-methods': {
      const items = result as { methodName: string; className: string; artifacts: Artifact[] }[];
      if (items.length === 0) {
        text = 'No methods found.';
      } else {
        text = items.map(m => {
          const arts = m.artifacts.map(a => `  ${a.groupId}:${a.artifactId}:${a.version}`).join('\n');
          return `Method: ${m.methodName}\n  Class: ${m.className}\n${arts}`;
        }).join('\n\n');
      }
      break;
    }
    case 'get-class': {
      text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      break;
    }
    case 'info': {
      const items = result as ArtifactInfo[];
      if (items.length === 0) {
        text = 'No artifacts found.';
      } else {
        text = items.map(item => {
          const a = item.artifact;
          return [
            `Artifact: ${a.groupId}:${a.artifactId}:${a.version}`,
            `  Path: ${a.abspath}`,
            `  Layout: ${a.layout ?? 'unknown'}`,
            `  Has Source: ${a.hasSource}`,
            `  Main JAR Exists: ${item.mainJarExists}`,
            `  Class Count: ${item.classCount}`,
            `  Resource Count: ${item.resourceCount}`,
          ].join('\n');
        }).join('\n\n');
      }
      break;
    }
    case 'stats': {
      const stats = result as IndexStats;
      const lines = [
        `DB Path: ${stats.dbPath}`,
        `DB Size: ${stats.dbSizeBytes} bytes`,
        `Last Indexed At: ${stats.lastIndexedAt ?? 'never'}`,
        `Artifact Count: ${stats.artifactCount}`,
        `Class Count: ${stats.classCount}`,
        `Resource Count: ${stats.resourceCount}`,
      ];
      if (stats.skippedByExcludes && stats.skippedByExcludes > 0) {
        lines.push(`Skipped By Excludes: ${stats.skippedByExcludes}`);
      }
      text = lines.join('\n');
      break;
    }
    case 'list-classes': {
      const items = result as string[];
      if (items.length === 0) {
        text = 'No classes found.';
      } else {
        text = items.join('\n');
      }
      break;
    }
    case 'get-resource': {
      const resource = result as { path: string; content: string; type: string } | null;
      if (!resource) {
        text = 'Resource not found.';
      } else {
        text = `Path: ${resource.path}\nType: ${resource.type}\n\n${resource.content}`;
      }
      break;
    }
    case 'get-dependencies': {
      const items = result as { groupId: string; artifactId: string; version: string; scope: string; optional: boolean }[];
      if (items.length === 0) {
        text = 'No dependencies found.';
      } else {
        text = items.map(d => {
          const versionPart = d.version ? `:${d.version}` : '';
          const optPart = d.optional ? ' (optional)' : '';
          return `${d.groupId}:${d.artifactId}${versionPart} (scope: ${d.scope})${optPart}`;
        }).join('\n');
      }
      break;
    }
    case 'find-dependents': {
      const items = result as { groupId: string; artifactId: string; version: string; scope: string }[];
      if (items.length === 0) {
        text = 'No dependents found.';
      } else {
        text = items.map(d => `${d.groupId}:${d.artifactId}:${d.version} (scope: ${d.scope})`).join('\n');
      }
      break;
    }
    case 'doctor': {
      const items = result as MissingArtifact[];
      if (items.length === 0) {
        text = 'No missing artifacts found.';
      } else {
        text = `Missing artifacts (${items.length}):\n` + items
          .map(m => `  ${m.groupId}:${m.artifactId}:${m.version} (${m.abspath})`)
          .join('\n');
      }
      break;
    }
    case 'callers':
    case 'callees': {
      const payload = result as { target: { className: string; methodName?: string }; edges: CallEdgeResult[]; callGraphAvailable: boolean };
      const targetLabel = payload.target.methodName
        ? `${payload.target.className}.${payload.target.methodName}`
        : payload.target.className;
      if (!payload.callGraphAvailable) {
        text = `Call-graph index is empty (INDEX_CALL_GRAPH=0 or no artifacts indexed).\nNo ${command} for ${targetLabel}.`;
        break;
      }
      if (payload.edges.length === 0) {
        text = `No ${command} found for ${targetLabel}.`;
        break;
      }
      const lines: string[] = [`${command === 'callers' ? 'Callers' : 'Callees'} of ${targetLabel} (${payload.edges.length}):`];
      for (const edge of payload.edges) {
        const desc = edge.methodDescriptor ? ` ${edge.methodDescriptor}` : '';
        const resolved = edge.resolved ? '' : ' [unresolved]';
        const sites = edge.sites > 1 ? ` (${edge.sites} sites)` : '';
        const kind = edge.invokeKind;
        const arts = edge.artifacts.length > 0
          ? edge.artifacts.map(a => `    ${a.groupId}:${a.artifactId}:${a.version}`).join('\n')
          : '    (no indexed artifact)';
        lines.push(`  ${edge.className}.${edge.methodName}${desc} [${kind}]${resolved}${sites}`);
        lines.push(arts);
      }
      text = lines.join('\n');
      break;
    }
    case 'impact': {
      const payload = result as {
        target: { className: string; methodName?: string };
        nodes: ImpactNode[];
        truncated: number;
        callGraphAvailable: boolean;
        maxDepth: number;
        maxNodes: number;
        format: 'flat' | 'tree';
      };
      const targetLabel = payload.target.methodName
        ? `${payload.target.className}.${payload.target.methodName}`
        : payload.target.className;
      if (!payload.callGraphAvailable) {
        text = `Call-graph index is empty (INDEX_CALL_GRAPH=0 or no artifacts indexed).\nNo impact for ${targetLabel}.`;
        break;
      }
      if (payload.nodes.length === 0) {
        text = `No impact (transitive callers) found for ${targetLabel}.`;
        break;
      }
      const header = `Impact of ${targetLabel} (${payload.nodes.length} nodes, depth ${payload.maxDepth}, max ${payload.maxNodes})${payload.truncated > 0 ? `, truncated ${payload.truncated}` : ''}:`;
      if (payload.format === 'tree') {
        text = header + '\n' + renderImpactTree(payload.nodes, targetLabel);
      } else {
        const lines = [header];
        for (const node of payload.nodes) {
          const cycleFlag = node.cycle ? ' [cycle]' : '';
          const nodeLabel = node.methodName ? `${node.className}.${node.methodName}` : node.className;
          lines.push(`  [d${node.depth}] ${nodeLabel}${cycleFlag}  via  ${node.path.join(' -> ')}`);
        }
        text = lines.join('\n');
      }
      break;
    }
    case 'trace': {
      const payload = result as TraceResult;
      const lines: string[] = [];

      // Class section (always first, even if null)
      if (payload.class) {
        lines.push(`### Class: ${payload.class.className}`);
        lines.push(`Artifact: ${payload.class.artifact}`);
        if (payload.class.signatures.length > 0) {
          lines.push('Methods:');
          for (const sig of payload.class.signatures) {
            lines.push(`  ${sig}`);
          }
        }
      } else {
        lines.push(`### Class: (not found)`);
      }

      // Implementations section
      if (payload.implementations.length > 0) {
        lines.push('');
        lines.push(`### Implementations (${payload.implementations.length}${payload._meta.truncated.implementations > 0 ? `+${payload._meta.truncated.implementations} truncated` : ''})`);
        for (const impl of payload.implementations) {
          lines.push(`  ${impl.className}${impl.artifact ? '  [' + impl.artifact + ']' : ''}`);
        }
      }

      // Callers section
      if (payload._meta.callGraphAvailable && payload.callers.length > 0) {
        lines.push('');
        lines.push(`### Callers (${payload.callers.length}${payload._meta.truncated.callers > 0 ? `+${payload._meta.truncated.callers} truncated` : ''})`);
        for (const c of payload.callers) {
          lines.push(`  ${c.className}.${c.methodName} (${c.sites} site${c.sites > 1 ? 's' : ''})${c.artifact ? '  [' + c.artifact + ']' : ''}`);
        }
      }

      // Callees section
      if (payload._meta.callGraphAvailable && payload.callees.length > 0) {
        lines.push('');
        lines.push(`### Callees (${payload.callees.length}${payload._meta.truncated.callees > 0 ? `+${payload._meta.truncated.callees} truncated` : ''})`);
        for (const c of payload.callees) {
          lines.push(`  ${c.className}.${c.methodName} (${c.sites} site${c.sites > 1 ? 's' : ''})${c.artifact ? '  [' + c.artifact + ']' : ''}`);
        }
      }

      // Meta footer
      lines.push('');
      const metaParts = [`status: ${payload._meta.status}`, `callGraph: ${payload._meta.callGraphAvailable ? 'available' : 'unavailable'}`];
      const trunc = payload._meta.truncated;
      const truncParts: string[] = [];
      if (trunc.implementations > 0) truncParts.push(`impl:${trunc.implementations}`);
      if (trunc.callers > 0) truncParts.push(`callers:${trunc.callers}`);
      if (trunc.callees > 0) truncParts.push(`callees:${trunc.callees}`);
      if (truncParts.length > 0) metaParts.push(`truncated: ${truncParts.join(', ')}`);
      lines.push(`_meta: ${metaParts.join(' | ')}_`);

      text = lines.join('\n');
      break;
    }
    default: {
      text = JSON.stringify(result, null, 2);
    }
  }

  process.stdout.write(text + '\n');
}

/** Renders the impact nodes as an indented tree, grouped by depth. */
function renderImpactTree(nodes: ImpactNode[], rootLabel: string): string {
  // Build children-by-parent map keyed by the path's last element.
  const childrenOf = new Map<string, ImpactNode[]>();
  for (const node of nodes) {
    if (node.path.length < 2) continue;
    const parentKey = node.path[node.path.length - 2];
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    childrenOf.get(parentKey)!.push(node);
  }
  const renderNode = (key: string, indent: string): string[] => {
    const lines: string[] = [];
    const kids = childrenOf.get(key) ?? [];
    for (const kid of kids) {
      const label = kid.methodName ? `${kid.className}.${kid.methodName}` : kid.className;
      const cycleFlag = kid.cycle ? ' [cycle]' : '';
      lines.push(`${indent}- ${label}${cycleFlag}`);
      const kidKey = kid.methodName ? `${kid.className}.${kid.methodName}` : kid.className;
      lines.push(...renderNode(kidKey, indent + '  '));
    }
    return lines;
  };
  return renderNode(rootLabel, '').join('\n');
}
