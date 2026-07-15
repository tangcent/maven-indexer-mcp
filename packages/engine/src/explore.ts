/**
 * Module 2 — Explore Tool: the single composed query.
 *
 * Returns class source + implementations + callers/callees + call path in one
 * capped response. The primary tool of both faces (MCP default; CLI primary command).
 * Successor to `trace`, broadened to a bag of names + NL question.
 *
 * Design: see .spec/maven-indexer-redesign/design.md §D2.
 */

import { Indexer, Artifact } from './indexer.js';
import { ArtifactResolver } from './artifact_resolver.js';
import { SourceParser } from './source_parser.js';
import { resolveMainJar, resolveSourcesJar } from './path_helpers.js';
import { getProjectContext } from './project_context.js';
import type { ProjectContext, ProjectCoordinate } from './project_context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IncludeSection =
  | 'source' | 'signatures' | 'implementations' | 'callers' | 'callees'
  | 'path' | 'resources' | 'dependencies' | 'dependents';

export interface ExploreInput {
  /** Bag of names: class names (FQCN or simple), coordinates (g:a[:v]), method targets (Class.method), resource paths. At least one identifier required (unless `question` is provided). */
  identifiers: string[];
  /** Pin artifact version for all class/method identifiers. */
  coordinate?: string;
  /** Select which sections to populate. Omit = default set. */
  include?: IncludeSection[];
  /** Line budget (default 200). */
  maxLines?: number;
  /** Natural-language question (fallback to search-candidates mode when no identifier resolves). */
  question?: string;
  /** Absolute path to project root (Module 8 — optional; when absent, cache-wide resolution). */
  projectPath?: string;
}

export interface ClassEntry {
  className: string;
  artifact: string;
  signatures?: string[];
  source?: string;
  language?: string;
}

export interface EdgeEntry {
  className: string;
  methodName: string;
  artifact: string;
  sites: number;
}

export interface PathStep {
  from: string;
  to: string;
  via: string;
}

export interface ResourceEntry {
  path: string;
  artifact: string;
  type: string;
  content: string;
}

export interface DepEntry {
  groupId: string;
  artifactId: string;
  version: string;
  scope: string;
}

export interface ExploreResult {
  classes: ClassEntry[];
  implementations: { className: string; artifact: string }[];
  callers: EdgeEntry[];
  callees: EdgeEntry[];
  path?: PathStep[];
  resources?: ResourceEntry[];
  dependencies?: DepEntry[];
  dependents?: DepEntry[];
  _meta: {
    sections: Record<string, 'populated' | 'empty' | 'truncated'>;
    callGraphAvailable: boolean;
    totalLines: number;
    budget: number;
    resolved: Record<string, { artifact: string; policy: 'explicit' | 'project-pinned' | 'cache-wide' }>;
    unresolved: string[];
    mode: 'explore' | 'search';
    project: {
      kind: 'maven' | 'gradle' | 'none';
      projectCoordinate?: ProjectCoordinate;
      tree: 'declared' | 'resolved' | 'none';
      resolution: 'project-pinned' | 'cache-wide';
      buildFile?: string;
      buildFileMtime?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_INCLUDE: IncludeSection[] = ['signatures', 'implementations', 'callers', 'callees'];
const DEFAULT_MAX_LINES = 200;
const DEFAULT_LIMIT = 10;

/** Parse `Class.method` target — method names start lowercase, class names uppercase. */
function parseTarget(target: string): { className: string; methodName?: string } {
  const lastDot = target.lastIndexOf('.');
  if (lastDot > 0 && lastDot < target.length - 1) {
    const last = target.substring(lastDot + 1);
    if (last.length > 0 && last[0] >= 'a' && last[0] <= 'z') {
      return { className: target.substring(0, lastDot), methodName: last };
    }
  }
  return { className: target, methodName: undefined };
}

/** Detects if a string looks like a Maven coordinate `g:a[:v]`. */
function isCoordinate(s: string): boolean {
  const parts = s.split(':');
  return parts.length >= 2 && parts.length <= 3 && parts.every(p => p.length > 0);
}

function artifactCoord(a: Artifact): string {
  return `${a.groupId}:${a.artifactId}:${a.version}`;
}

/**
 * Per-process promise cache for project contexts, so concurrent explore() calls
 * with the same projectPath don't re-trigger getProjectContext (T8.3).
 */
const projectContextPromises = new Map<string, Promise<ProjectContext>>();

function getCachedProjectContext(projectPath: string): Promise<ProjectContext> {
  let promise = projectContextPromises.get(projectPath);
  if (!promise) {
    promise = getProjectContext(projectPath);
    projectContextPromises.set(projectPath, promise);
  }
  return promise;
}

/**
 * Project pinning (D8.3 / Req 3): if a project context is active, prefer
 * artifacts whose `groupId:artifactId` appears in the project's dependency tree.
 * The resolved-tree version wins over the declared-tree version (Req 3.2);
 * if no exact version match, prefer a source-bearing artifact among matches.
 */
function pickProjectArtifact(
  artifacts: Artifact[],
  projectContext?: ProjectContext,
): Artifact | undefined {
  if (!projectContext || projectContext.kind === 'none' || projectContext.tree === 'none') {
    return undefined;
  }

  // Build g:a -> version maps from resolved (preferred) and declared (fallback) trees
  const resolvedMap = new Map<string, string>();
  if (projectContext.resolved?.coordinates) {
    for (const dep of projectContext.resolved.coordinates) {
      if (dep.version) {
        resolvedMap.set(`${dep.groupId}:${dep.artifactId}`, dep.version);
      }
    }
  }
  const declaredMap = new Map<string, string>();
  for (const dep of projectContext.declared) {
    if (dep.version) {
      declaredMap.set(`${dep.groupId}:${dep.artifactId}`, dep.version);
    }
  }

  if (resolvedMap.size === 0 && declaredMap.size === 0) return undefined;

  // Find artifacts whose g:a appears in the project tree
  const matching: Artifact[] = [];
  for (const a of artifacts) {
    const key = `${a.groupId}:${a.artifactId}`;
    if (resolvedMap.has(key) || declaredMap.has(key)) {
      matching.push(a);
    }
  }

  if (matching.length === 0) return undefined;

  // Prefer the artifact whose version matches the resolved tree's version (Req 3.2)
  for (const a of matching) {
    const treeVersion = resolvedMap.get(`${a.groupId}:${a.artifactId}`);
    if (treeVersion && a.version === treeVersion) {
      return a;
    }
  }

  // Then prefer the artifact whose version matches the declared tree's version
  for (const a of matching) {
    const treeVersion = declaredMap.get(`${a.groupId}:${a.artifactId}`);
    if (treeVersion && a.version === treeVersion) {
      return a;
    }
  }

  // No exact version match — prefer source among matching, else first match
  const withSource = matching.filter(a => a.hasSource);
  if (withSource.length > 0) return withSource[0];
  return matching[0];
}

// ---------------------------------------------------------------------------
// Main explore function
// ---------------------------------------------------------------------------

/**
 * The single composed query. Collapses multiple round trips into one call.
 * Returns class source + implementations + callers/callees + call path, capped.
 */
export async function explore(input: ExploreInput): Promise<ExploreResult> {
  const indexer = Indexer.getInstance();
  const include = input.include ?? DEFAULT_INCLUDE;
  const maxLines = input.maxLines ?? DEFAULT_MAX_LINES;
  const wantsSource = include.includes('source');
  const wantsSignatures = include.includes('signatures');
  const wantsImpls = include.includes('implementations');
  const wantsCallers = include.includes('callers');
  const wantsCallees = include.includes('callees');
  const wantsPath = include.includes('path');
  const wantsResources = include.includes('resources');
  const wantsDeps = include.includes('dependencies');
  const wantsDependents = include.includes('dependents');

  const resolved: Record<string, { artifact: string; policy: 'explicit' | 'project-pinned' | 'cache-wide' }> = {};
  const unresolved: string[] = [];

  // --- 1. Classify inputs ---
  const classNames: string[] = [];
  const methodTargets: { className: string; methodName: string }[] = [];
  const coords: string[] = [];
  const resourcePaths: string[] = [];

  for (const id of input.identifiers ?? []) {
    if (isCoordinate(id)) {
      coords.push(id);
    } else if (id.includes('.')) {
      const { className, methodName } = parseTarget(id);
      if (methodName) {
        methodTargets.push({ className, methodName });
        classNames.push(className);
      } else {
        classNames.push(id);
      }
    } else {
      // Simple name — treat as class
      classNames.push(id);
    }
  }

  // --- 1b. Resolve project context (Module 8 — non-blocking, cached promise) ---
  let projectCtx: ProjectContext | undefined;
  if (input.projectPath) {
    try {
      projectCtx = await getCachedProjectContext(input.projectPath);
    } catch {
      // Graceful degradation: project context failure must never block the query (NFR-9)
      projectCtx = undefined;
    }
  }
  const projectActive = projectCtx !== undefined && projectCtx.kind !== 'none';

  // --- 2. Resolve explicit coordinate (if any) ---
  let pinnedArtifact: Artifact | undefined;
  let explicitCoordParts: [string, string, string] | undefined;
  if (input.coordinate) {
    const parts = input.coordinate.split(':');
    if (parts.length === 3) {
      explicitCoordParts = [parts[0], parts[1], parts[2]];
      pinnedArtifact = indexer.getArtifactByCoordinate(parts[0], parts[1], parts[2]);
      if (!pinnedArtifact) {
        unresolved.push(input.coordinate);
      }
    }
  }

  // --- 3. Resolve each class identifier ---
  const classes: ClassEntry[] = [];
  const allNamedSymbols: string[] = []; // for path computation

  for (const clsName of classNames) {
    const result = await resolveClassEntry(indexer, clsName, pinnedArtifact, explicitCoordParts, wantsSource, wantsSignatures, projectCtx);
    if (result) {
      classes.push(result.entry);
      resolved[clsName] = { artifact: result.entry.artifact, policy: result.policy };
      allNamedSymbols.push(clsName);
    } else {
      unresolved.push(clsName);
    }
  }

  // --- 4. Implementations ---
  let implementations: { className: string; artifact: string }[] = [];
  if (wantsImpls) {
    for (const clsName of classNames) {
      const impls = indexer.searchImplementations(clsName, DEFAULT_LIMIT + 1);
      for (const impl of impls.slice(0, DEFAULT_LIMIT)) {
        const art = impl.artifacts[0];
        implementations.push({
          className: impl.className,
          artifact: art ? artifactCoord(art) : '',
        });
      }
    }
  }

  // --- 5. Callers / Callees ---
  let callGraphAvailable = false;
  try { callGraphAvailable = indexer.isCallGraphAvailable(); } catch { callGraphAvailable = false; }

  let callers: EdgeEntry[] = [];
  let callees: EdgeEntry[] = [];

  if (callGraphAvailable) {
    if (wantsCallers) {
      for (const clsName of classNames) {
        const edges = indexer.searchCallers(clsName, undefined, DEFAULT_LIMIT + 1);
        callers.push(...edges.slice(0, DEFAULT_LIMIT).map(e => ({
          className: e.className,
          methodName: e.methodName,
          artifact: e.artifacts[0] ? artifactCoord(e.artifacts[0]) : '',
          sites: e.sites,
        })));
      }
    }
    if (wantsCallees) {
      for (const clsName of classNames) {
        const edges = indexer.searchCallees(clsName, undefined, DEFAULT_LIMIT + 1);
        callees.push(...edges.slice(0, DEFAULT_LIMIT).map(e => ({
          className: e.className,
          methodName: e.methodName,
          artifact: e.artifacts[0] ? artifactCoord(e.artifacts[0]) : '',
          sites: e.sites,
        })));
      }
    }
  }

  // --- 6. Path among named symbols (≥2) ---
  let path: PathStep[] | undefined;
  if (wantsPath && allNamedSymbols.length >= 2 && callGraphAvailable) {
    path = computePath(indexer, allNamedSymbols);
  }

  // --- 7. Resources ---
  let resources: ResourceEntry[] | undefined;
  if (wantsResources) {
    resources = [];
    for (const rPath of resourcePaths) {
      const matches = indexer.searchResources(rPath);
      for (const m of matches.slice(0, DEFAULT_LIMIT)) {
        // Fetch full content for the resource
        const full = indexer.getResource(m.artifact.groupId, m.artifact.artifactId, m.artifact.version, m.path);
        resources.push({
          path: m.path,
          artifact: artifactCoord(m.artifact),
          type: full?.type ?? 'unknown',
          content: full?.content ?? '',
        });
      }
    }
    // Also try class-name-derived resources (has content+type, but no artifact — use resolved class's artifact)
    for (const clsName of classNames) {
      const clsResources = indexer.getResourcesForClass(clsName);
      const resolvedArt = resolved[clsName]?.artifact ?? '';
      for (const r of clsResources.slice(0, 5)) {
        resources.push({
          path: r.path,
          artifact: resolvedArt,
          type: r.type,
          content: r.content,
        });
      }
    }
  }

  // --- 8. Dependencies / Dependents ---
  let dependencies: DepEntry[] | undefined;
  let dependents: DepEntry[] | undefined;
  if (wantsDeps || wantsDependents) {
    const artifactsToQuery = classes.map(c => c.artifact);
    for (const coordStr of artifactsToQuery) {
      const [g, a, v] = coordStr.split(':');
      if (wantsDeps) {
        if (!dependencies) dependencies = [];
        const deps = indexer.getDependencies(g, a, v);
        dependencies.push(...deps.map(d => ({ groupId: d.groupId, artifactId: d.artifactId, version: d.version, scope: d.scope })));
      }
      if (wantsDependents) {
        if (!dependents) dependents = [];
        const deps = indexer.findDependents(g, a);
        dependents.push(...deps.map(d => ({ groupId: d.groupId, artifactId: d.artifactId, version: d.version, scope: d.scope })));
      }
    }
  }

  // --- 9. NL fallback (search-candidates mode) ---
  let mode: 'explore' | 'search' = 'explore';
  if (classes.length === 0 && input.question) {
    mode = 'search';
    // Search candidates by token overlap
    const tokens = input.question.split(/\s+/).filter(t => t.length > 2);
    const candidates = new Map<string, Artifact[]>();
    for (const tok of tokens) {
      const matches = indexer.searchClass(tok);
      for (const m of matches.slice(0, 5)) {
        candidates.set(m.className, m.artifacts);
      }
    }
    // Render candidates as class entries with no source
    for (const [clsName, arts] of candidates) {
      // Apply project pinning in search mode too (D8.3)
      const pinned = pickProjectArtifact(arts, projectCtx);
      const bestArt = pinned ?? await ArtifactResolver.resolveBestArtifact(arts);
      classes.push({
        className: clsName,
        artifact: bestArt ? artifactCoord(bestArt) : '',
      });
      resolved[clsName] = {
        artifact: bestArt ? artifactCoord(bestArt) : '',
        policy: pinned ? 'project-pinned' : 'cache-wide',
      };
    }
  }

  // --- 10. Assemble result + _meta ---
  const sections: Record<string, 'populated' | 'empty' | 'truncated'> = {};
  sections.classes = classes.length > 0 ? 'populated' : 'empty';
  sections.implementations = implementations.length > 0 ? 'populated' : 'empty';
  sections.callers = callers.length > 0 ? 'populated' : 'empty';
  sections.callees = callees.length > 0 ? 'populated' : 'empty';
  if (path !== undefined) sections.path = path.length > 0 ? 'populated' : 'empty';
  if (resources !== undefined) sections.resources = resources.length > 0 ? 'populated' : 'empty';
  if (dependencies !== undefined) sections.dependencies = dependencies.length > 0 ? 'populated' : 'empty';
  if (dependents !== undefined) sections.dependents = dependents.length > 0 ? 'populated' : 'empty';

  const totalLines = estimateLines(classes, implementations, callers, callees, path, resources, dependencies, dependents);

  return {
    classes,
    implementations,
    callers,
    callees,
    ...(path !== undefined ? { path } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(dependencies !== undefined ? { dependencies } : {}),
    ...(dependents !== undefined ? { dependents } : {}),
    _meta: {
      sections,
      callGraphAvailable,
      totalLines,
      budget: maxLines,
      resolved,
      unresolved,
      mode,
      project: {
        kind: projectCtx?.kind ?? 'none',
        ...(projectCtx?.projectCoordinate ? { projectCoordinate: projectCtx.projectCoordinate } : {}),
        tree: projectCtx?.tree ?? 'none',
        resolution: projectActive ? 'project-pinned' : 'cache-wide',
        ...(projectCtx?.buildFile ? { buildFile: projectCtx.buildFile } : {}),
        ...(projectCtx?.buildFileMtime ? { buildFileMtime: projectCtx.buildFileMtime } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Class entry resolution
// ---------------------------------------------------------------------------

async function resolveClassEntry(
  indexer: Indexer,
  clsName: string,
  pinnedArtifact: Artifact | undefined,
  explicitCoord: [string, string, string] | undefined,
  wantsSource: boolean,
  wantsSignatures: boolean,
  projectContext?: ProjectContext,
): Promise<{ entry: ClassEntry; policy: 'explicit' | 'project-pinned' | 'cache-wide' } | null> {
  let artifact: Artifact | undefined = pinnedArtifact;
  // Policy: 'explicit' when user supplied --coordinate, 'project-pinned' when
  // matched against the project tree, 'cache-wide' as the fallback heuristic.
  let policy: 'explicit' | 'project-pinned' | 'cache-wide' = pinnedArtifact ? 'explicit' : 'cache-wide';

  if (!artifact) {
    // Search for the class
    const matches = indexer.searchClass(clsName);
    const exactMatch = matches.find(m => m.className === clsName);

    if (exactMatch) {
      // Project pinning (D8.3): prefer artifacts in the project's dependency tree.
      const pinned = pickProjectArtifact(exactMatch.artifacts, projectContext);
      if (pinned) {
        artifact = pinned;
        policy = 'project-pinned';
      } else {
        artifact = await ArtifactResolver.resolveBestArtifact(exactMatch.artifacts);
        policy = 'cache-wide';
      }
    } else {
      // Try inner class resolution: com.pkg.Outer.Inner -> com.pkg.Outer$Inner
      const parts = clsName.split('.');
      for (let i = parts.length - 1; i > 0; i--) {
        const candidate = parts.slice(0, i).join('.');
        const candidateMatches = indexer.searchClass(candidate);
        const candidateExact = candidateMatches.find(m => m.className === candidate);
        if (candidateExact) {
          const pinned = pickProjectArtifact(candidateExact.artifacts, projectContext);
          const bestArt = pinned ?? await ArtifactResolver.resolveBestArtifact(candidateExact.artifacts);
          if (bestArt) {
            // Resolve with inner-class $ notation
            const innerPart = parts.slice(i).join('$');
            const resolvedName = `${candidate}$${innerPart}`;
            const entry = await resolveClassDetail(bestArt, resolvedName, clsName, wantsSource, wantsSignatures);
            if (entry) {
              return { entry, policy: pinned ? 'project-pinned' : 'cache-wide' };
            }
          }
        }
      }
      return null;
    }
  }

  if (!artifact) return null;
  const entry = await resolveClassDetail(artifact, clsName, clsName, wantsSource, wantsSignatures);
  if (!entry) return null;
  return { entry, policy };
}

async function resolveClassDetail(
  artifact: Artifact,
  resolvedName: string,
  displayName: string,
  wantsSource: boolean,
  wantsSignatures: boolean,
): Promise<ClassEntry | null> {
  const detailType = wantsSource ? 'source' : 'signatures';

  // Try source jar first for source/docs
  if (wantsSource && artifact.hasSource) {
    const sourceJarPath = resolveSourcesJar(artifact);
    try {
      const detail = await SourceParser.getClassDetail(sourceJarPath, resolvedName, 'source');
      if (detail && detail.source) {
        return {
          className: detail.className ?? displayName,
          artifact: artifactCoord(artifact),
          source: detail.source,
          language: detail.language || 'java',
        };
      }
    } catch { /* fall through to main jar */ }
  }

  // Try main jar (decompilation fallback for source; signatures from main jar)
  const mainJarPath = resolveMainJar(artifact);
  try {
    const detail = await SourceParser.getClassDetail(mainJarPath, resolvedName, detailType);
    if (detail) {
      return {
        className: detail.className ?? displayName,
        artifact: artifactCoord(artifact),
        ...(wantsSignatures && detail.signatures ? { signatures: detail.signatures } : {}),
        ...(wantsSource && detail.source ? { source: detail.source, language: detail.language || 'java' } : {}),
      };
    }
  } catch { /* fall through */ }

  // Class exists in index but source not extractable — return minimal entry
  return {
    className: displayName,
    artifact: artifactCoord(artifact),
    signatures: [],
  };
}

// ---------------------------------------------------------------------------
// Path computation (BFS among named symbols, depth ≤ 2)
// ---------------------------------------------------------------------------

function computePath(indexer: Indexer, symbols: string[]): PathStep[] {
  const steps: PathStep[] = [];
  const symbolSet = new Set(symbols);

  // Check direct edges between each pair
  for (let i = 0; i < symbols.length; i++) {
    for (let j = 0; j < symbols.length; j++) {
      if (i === j) continue;
      const from = symbols[i];
      const to = symbols[j];

      // Does `from` call `to`? Check callees of `from`
      const callees = indexer.searchCallees(from, undefined, 200);
      for (const edge of callees) {
        if (edge.className === to || symbolSet.has(edge.className)) {
          steps.push({ from, to: edge.className, via: `${edge.className}.${edge.methodName}` });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return steps.filter(s => {
    const key = `${s.from}->${s.to}:${s.via}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

// ---------------------------------------------------------------------------
// Line estimation
// ---------------------------------------------------------------------------

function estimateLines(
  classes: ClassEntry[],
  impls: { className: string; artifact: string }[],
  callers: EdgeEntry[],
  callees: EdgeEntry[],
  path?: PathStep[],
  resources?: ResourceEntry[],
  deps?: DepEntry[],
  dependents?: DepEntry[],
): number {
  let count = 0;
  for (const c of classes) {
    count += 2; // header + artifact
    if (c.signatures) count += c.signatures.length;
    if (c.source) count += c.source.split('\n').length + 2;
  }
  if (impls.length > 0) count += 1 + impls.length;
  if (callers.length > 0) count += 1 + callers.length;
  if (callees.length > 0) count += 1 + callees.length;
  if (path && path.length > 0) count += 1 + path.length;
  if (resources) for (const r of resources) count += 2 + r.content.split('\n').length;
  if (deps) count += 1 + deps.length;
  if (dependents) count += 1 + dependents.length;
  return count;
}
