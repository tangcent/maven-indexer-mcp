/**
 * Module 2 — Explore Tool: the single composed query.
 *
 * Returns class source + implementations + callers/callees + call path in one
 * capped response. The primary tool of both faces (MCP default; CLI primary command).
 * Successor to `trace`, broadened to a bag of names + NL question.
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

/** Extensions identifying a JAR resource path rather than a class name. */
const RESOURCE_EXTENSIONS = [
  '.xml', '.properties', '.proto', '.json', '.yaml', '.yml', '.toml', '.ini',
  '.cfg', '.txt', '.md', '.sql', '.factories', '.MF', '.service', '.gradle',
  '.bnd', '.policy', '.list', '.jks', '.p12', '.xsd', '.wsdl', '.tld',
];

/** Detects a Maven coordinate `g:a[:v]`. */
function isCoordinate(s: string): boolean {
  const parts = s.split(':');
  return parts.length >= 2 && parts.length <= 3 && parts.every(p => p.length > 0);
}

/**
 * Distinguishes a JAR resource path from a class name.
 *
 * A segmented path (`META-INF/spring.factories`) or a known resource extension
 * means resource; anything else falls through to the class/method heuristic.
 * Checked before `parseTarget` so resource paths are no longer mis-split into
 * "package + method".
 */
function isResourcePath(s: string): boolean {
  if (s.includes('/')) return true;
  const lower = s.toLowerCase();
  return RESOURCE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

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

/** A coordinate supplied via `identifiers` that pins resolution to one artifact. */
interface CoordinatePin {
  label: string;
  artifact?: Artifact;      // exact `g:a:v` match found in the index
  groupId?: string;         // `g:a` without version — scope filter
  artifactId?: string;
}

function artifactCoord(a: Artifact): string {
  return `${a.groupId}:${a.artifactId}:${a.version}`;
}

/** Rendered-line cost of a class entry (mirrors `renderExploreForLlm`). */
function estimateClassLines(c: ClassEntry): number {
  let n = 2; // "### <name>" + "Artifact: g:a:v"
  if (c.signatures) n += 1 + c.signatures.length; // "Methods:" header + lines
  if (c.source) n += 2 + c.source.split('\n').length; // opening + closing fence
  return n;
}

/** Rendered-line cost of a resource entry. */
function estimateResourceLines(r: ResourceEntry): number {
  return 2 + r.content.split('\n').length;
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

/** True when the context actually carries dependency data we can pin against. */
function hasPinningData(ctx?: ProjectContext): boolean {
  if (!ctx || ctx.kind === 'none') return false;
  if (ctx.declared.length > 0) return true;
  return Boolean(ctx.resolved && ctx.resolved.coordinates.length > 0);
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
  if (!hasPinningData(projectContext) || !projectContext) return undefined;

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

/**
 * Applies the coordinate pins supplied via `identifiers`, so `g:a[:v]` inputs
 * actually constrain resolution instead of being silently dropped.
 */
function pickPinnedArtifact(candidates: Artifact[], pins: CoordinatePin[]): Artifact | undefined {
  for (const pin of pins) {
    if (pin.artifact) {
      const hit = candidates.find(
        c => c.groupId === pin.artifact!.groupId
          && c.artifactId === pin.artifact!.artifactId
          && c.version === pin.artifact!.version,
      );
      if (hit) return hit;
    }
    if (pin.groupId && pin.artifactId) {
      const hit = candidates.find(
        c => c.groupId === pin.groupId && c.artifactId === pin.artifactId,
      );
      if (hit) return hit;
    }
  }
  return undefined;
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
  // Order matters: coordinates and resource paths carry characters that would
  // otherwise be mis-read as "package.method" by parseTarget().
  const classNames: string[] = [];
  const methodTargets: { className: string; methodName: string }[] = [];
  const coordInputs: string[] = [];
  const resourcePaths: string[] = [];

  for (const id of input.identifiers ?? []) {
    if (isCoordinate(id)) {
      coordInputs.push(id);
    } else if (isResourcePath(id)) {
      resourcePaths.push(id);
    } else if (id.includes('.')) {
      const { className, methodName } = parseTarget(id);
      if (methodName) {
        methodTargets.push({ className, methodName });
        if (!classNames.includes(className)) classNames.push(className);
      } else if (!classNames.includes(id)) {
        classNames.push(id);
      }
    } else if (!classNames.includes(id)) {
      // Simple name — treat as class
      classNames.push(id);
    }
  }

  /** Methods named per class, so callers/callees can be filtered accordingly. */
  const methodsByClass = new Map<string, string[]>();
  for (const { className, methodName } of methodTargets) {
    const existing = methodsByClass.get(className);
    if (existing) {
      if (!existing.includes(methodName)) existing.push(methodName);
    } else {
      methodsByClass.set(className, [methodName]);
    }
  }

  // --- 1b. Resolve coordinate identifiers into explicit pins ---
  const pins: CoordinatePin[] = [];
  for (const id of coordInputs) {
    const parts = id.split(':');
    if (parts.length === 3) {
      const art = indexer.getArtifactByCoordinate(parts[0], parts[1], parts[2]);
      if (art) {
        pins.push({ label: id, artifact: art });
      } else {
        unresolved.push(id);
      }
    } else {
      // `g:a` without a version scopes resolution but cannot pin exactly.
      pins.push({ label: id, groupId: parts[0], artifactId: parts[1] });
    }
  }

  // --- 1c. Resolve project context (Module 8 — non-blocking, cached promise) ---
  let projectCtx: ProjectContext | undefined;
  if (input.projectPath) {
    try {
      projectCtx = await getCachedProjectContext(input.projectPath);
    } catch {
      // Graceful degradation: project context failure must never block the query (NFR-9)
      projectCtx = undefined;
    }
  }
  // Only claim project pinning when the context actually carries dependencies —
  // a bare settings.gradle yields kind='gradle' but an empty tree.
  const projectActive = hasPinningData(projectCtx);

  // --- 2. Resolve explicit coordinate option (if any) ---
  let pinnedArtifact: Artifact | undefined;
  if (input.coordinate) {
    const parts = input.coordinate.split(':');
    if (parts.length === 3) {
      pinnedArtifact = indexer.getArtifactByCoordinate(parts[0], parts[1], parts[2]);
      if (pinnedArtifact) {
        pins.unshift({ label: input.coordinate, artifact: pinnedArtifact });
      } else {
        unresolved.push(input.coordinate);
      }
    }
  }

  // --- 3. Resolve each class identifier ---
  const classes: ClassEntry[] = [];
  const allNamedSymbols: string[] = []; // for path computation

  for (const clsName of classNames) {
    const result = await resolveClassEntry(
      indexer, clsName, pinnedArtifact,
      wantsSource, wantsSignatures, projectCtx, pins,
    );
    if (result) {
      classes.push(result.entry);
      resolved[clsName] = { artifact: result.entry.artifact, policy: result.policy };
      allNamedSymbols.push(clsName);
    } else {
      // Either the class is unknown, or it was found but nothing could be
      // extracted — report it so callers don't get a silent hole.
      unresolved.push(clsName);
    }
  }

  // --- 4. Implementations ---
  const implementations: { className: string; artifact: string }[] = [];
  let implementationsTrimmed = false;
  if (wantsImpls) {
    for (const clsName of classNames) {
      const impls = indexer.searchImplementations(clsName, DEFAULT_LIMIT + 1);
      if (impls.length > DEFAULT_LIMIT) implementationsTrimmed = true;
      for (const impl of impls.slice(0, DEFAULT_LIMIT)) {
        const art = impl.artifacts[0];
        implementations.push({
          className: impl.className,
          artifact: art ? artifactCoord(art) : '',
        });
      }
    }
  }

  // --- 5. Callers / Callees (method-filtered when input named a method) ---
  let callGraphAvailable = false;
  try { callGraphAvailable = indexer.isCallGraphAvailable(); } catch { callGraphAvailable = false; }

  const callers: EdgeEntry[] = [];
  const callees: EdgeEntry[] = [];
  let callersTrimmed = false;
  let calleesTrimmed = false;

  if (callGraphAvailable) {
    if (wantsCallers) {
      for (const clsName of classNames) {
        for (const method of methodsByClass.get(clsName) ?? [undefined]) {
          const edges = indexer.searchCallers(clsName, method, DEFAULT_LIMIT + 1);
          if (edges.length > DEFAULT_LIMIT) callersTrimmed = true;
          callers.push(...edges.slice(0, DEFAULT_LIMIT).map(e => ({
            className: e.className,
            methodName: e.methodName,
            artifact: e.artifacts[0] ? artifactCoord(e.artifacts[0]) : '',
            sites: e.sites,
          })));
        }
      }
    }
    if (wantsCallees) {
      for (const clsName of classNames) {
        for (const method of methodsByClass.get(clsName) ?? [undefined]) {
          const edges = indexer.searchCallees(clsName, method, DEFAULT_LIMIT + 1);
          if (edges.length > DEFAULT_LIMIT) calleesTrimmed = true;
          callees.push(...edges.slice(0, DEFAULT_LIMIT).map(e => ({
            className: e.className,
            methodName: e.methodName,
            artifact: e.artifacts[0] ? artifactCoord(e.artifacts[0]) : '',
            sites: e.sites,
          })));
        }
      }
    }
  }

  // --- 6. Path among named symbols (≥2). Direct callee edges — see computePath. ---
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
      if (matches.length === 0) unresolved.push(rPath);
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
      if (!g || !a || !v) continue;
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

  const sections: Record<string, 'populated' | 'empty' | 'truncated'> = {};
  const result: ExploreResult = {
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
      totalLines: 0,
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

  // Per-section caps already applied above; fold them into the status map.
  if (wantsImpls) {
    sections.implementations = implementations.length === 0
      ? 'empty'
      : (implementationsTrimmed ? 'truncated' : 'populated');
  }
  if (wantsCallers) {
    sections.callers = callers.length === 0
      ? 'empty'
      : (callersTrimmed ? 'truncated' : 'populated');
  }
  if (wantsCallees) {
    sections.callees = callees.length === 0
      ? 'empty'
      : (calleesTrimmed ? 'truncated' : 'populated');
  }

  // --- 10. Overall line budget (applies to JSON output too) ---
  applyLineBudget(result, maxLines);
  return result;
}

// ---------------------------------------------------------------------------
// Line budget enforcement
// ---------------------------------------------------------------------------

/**
 * Caps every populated section so the rendered payload stays within `maxLines`.
 *
 * Sections are spent in priority order: classes first (they carry the payload
 * the caller actually asked for), then the neighborhood sections. Dropped items
 * show up in `_meta.sections` as 'truncated'. This runs on the result object,
 * so the budget holds for `--json` as well as for the text renderer.
 */
function applyLineBudget(result: ExploreResult, maxLines: number): void {
  const sections = result._meta.sections;
  let used = 0;

  /** Keeps leading items while they fit; returns how many survived. */
  const spend = <T>(items: T[], cost: (item: T) => number): T[] => {
    const kept: T[] = [];
    for (const item of items) {
      const c = cost(item);
      if (used + c > maxLines) break;
      kept.push(item);
      used += c;
    }
    return kept;
  };

  /** Records the final status of a section, preserving a prior 'truncated'. */
  const settle = (name: string, kept: number, original: number): void => {
    if (original === 0) {
      sections[name] = 'empty';
    } else if (kept < original || sections[name] === 'truncated') {
      sections[name] = 'truncated';
    } else {
      sections[name] = 'populated';
    }
  };

  // Classes — keep whole entries where possible, clip an oversized source to fit.
  const originalClasses = result.classes.length;
  const keptClasses: ClassEntry[] = [];
  let classesClipped = false;
  for (const c of result.classes) {
    const cost = estimateClassLines(c);
    if (used + cost <= maxLines) {
      keptClasses.push(c);
      used += cost;
      continue;
    }
    // Try to fit a clipped source instead of dropping the class outright.
    const headroom = maxLines - used - 6; // header + artifact + two fences + notice
    if (c.source && headroom > 8) {
      const lines = c.source.split('\n');
      const clipped: ClassEntry = {
        ...c,
        source: `${lines.slice(0, headroom).join('\n')}\n... (source truncated: ${lines.length} lines total — raise --max-lines)`,
      };
      keptClasses.push(clipped);
      used += estimateClassLines(clipped);
      classesClipped = true;
    }
    break; // budget exhausted; remaining classes are dropped
  }
  result.classes = keptClasses;
  settle('classes', keptClasses.length, originalClasses);
  if (classesClipped && sections.classes === 'populated') sections.classes = 'truncated';

  const implCount = result.implementations.length;
  if (implCount > 0) used += 1; // "### Implementations (n)" header
  result.implementations = spend(result.implementations, () => 1);
  settle('implementations', result.implementations.length, implCount);

  const callersCount = result.callers.length;
  if (callersCount > 0) used += 1;
  result.callers = spend(result.callers, () => 1);
  settle('callers', result.callers.length, callersCount);

  const calleesCount = result.callees.length;
  if (calleesCount > 0) used += 1;
  result.callees = spend(result.callees, () => 1);
  settle('callees', result.callees.length, calleesCount);

  if (result.path) {
    const original = result.path.length;
    const keptPath = spend(result.path, () => 1);
    sections.path = original === 0 ? 'empty' : (keptPath.length < original ? 'truncated' : 'populated');
    result.path = keptPath;
  }

  if (result.resources) {
    const original = result.resources.length;
    const keptResources = spend(result.resources, estimateResourceLines);
    settle('resources', keptResources.length, original);
    result.resources = keptResources;
  }

  if (result.dependencies) {
    const original = result.dependencies.length;
    if (original > 0) used += 1;
    const kept = spend(result.dependencies, () => 1);
    settle('dependencies', kept.length, original);
    result.dependencies = kept;
  }

  if (result.dependents) {
    const original = result.dependents.length;
    if (original > 0) used += 1;
    const kept = spend(result.dependents, () => 1);
    settle('dependents', kept.length, original);
    result.dependents = kept;
  }

  result._meta.totalLines = estimateLines(result);
}

// ---------------------------------------------------------------------------
// Class entry resolution
// ---------------------------------------------------------------------------

async function resolveClassEntry(
  indexer: Indexer,
  clsName: string,
  pinnedArtifact: Artifact | undefined,
  wantsSource: boolean,
  wantsSignatures: boolean,
  projectContext?: ProjectContext,
  pins: CoordinatePin[] = [],
): Promise<{ entry: ClassEntry; policy: 'explicit' | 'project-pinned' | 'cache-wide' } | null> {
  let artifact: Artifact | undefined = pinnedArtifact;
  // Policy: 'explicit' when the user pinned an artifact, 'project-pinned' when
  // matched against the project tree, 'cache-wide' as the fallback heuristic.
  let policy: 'explicit' | 'project-pinned' | 'cache-wide' = pinnedArtifact ? 'explicit' : 'cache-wide';

  if (!artifact) {
    // Search for the class
    const matches = indexer.searchClass(clsName);
    const exactMatch = matches.find(m => m.className === clsName);

    if (exactMatch) {
      // An exact `g:a:v` pin is authoritative. It is tried *before* the
      // candidate list because `searchClass` collapses versions per
      // groupId:artifactId — the pinned version may not even appear there.
      // If the class isn't actually inside that artifact, fall through to the
      // normal resolution instead of failing.
      const exactPin = pins.find(p => p.artifact);
      if (exactPin?.artifact) {
        const pinnedEntry = await resolveClassDetail(
          exactPin.artifact, clsName, clsName, wantsSource, wantsSignatures,
        );
        if (pinnedEntry) return { entry: pinnedEntry, policy: 'explicit' };
      }

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
          const pinnedByCoord = pickPinnedArtifact(candidateExact.artifacts, pins);
          const pinned = pinnedByCoord ?? pickProjectArtifact(candidateExact.artifacts, projectContext);
          const bestArt = pinned ?? await ArtifactResolver.resolveBestArtifact(candidateExact.artifacts);
          if (bestArt) {
            // Resolve with inner-class $ notation
            const innerPart = parts.slice(i).join('$');
            const resolvedName = `${candidate}$${innerPart}`;
            const entry = await resolveClassDetail(bestArt, resolvedName, clsName, wantsSource, wantsSignatures);
            if (entry) {
              return {
                entry,
                policy: pinnedByCoord ? 'explicit' : (pinned ? 'project-pinned' : 'cache-wide'),
              };
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
  let detail;
  try {
    detail = await SourceParser.getClassDetail(mainJarPath, resolvedName, detailType);
  } catch {
    // The class is indexed but its JAR cannot be read (deleted, corrupt, or no
    // source and no usable bytecode). Return null so the caller reports it as
    // unresolved instead of receiving an empty shell that looks successful.
    return null;
  }

  if (detail) {
    return {
      className: detail.className ?? displayName,
      artifact: artifactCoord(artifact),
      ...(wantsSignatures && detail.signatures ? { signatures: detail.signatures } : {}),
      ...(wantsSource && detail.source ? { source: detail.source, language: detail.language || 'java' } : {}),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Path computation (direct callee edges among named symbols)
// ---------------------------------------------------------------------------

/**
 * Returns the direct `from -> callee` edges whose target is another named
 * symbol. One hop, callee direction only — enough for the common "does A talk
 * to B?" question without paying for a full closure traversal.
 */
function computePath(indexer: Indexer, symbols: string[]): PathStep[] {
  const steps: PathStep[] = [];
  const symbolSet = new Set(symbols);

  for (const from of symbols) {
    const callees = indexer.searchCallees(from, undefined, 200);
    for (const edge of callees) {
      if (symbolSet.has(edge.className)) {
        steps.push({ from, to: edge.className, via: `${edge.className}.${edge.methodName}` });
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

function estimateLines(result: ExploreResult): number {
  let count = 0;
  for (const c of result.classes) count += estimateClassLines(c);
  if (result.implementations.length > 0) count += 1 + result.implementations.length;
  if (result.callers.length > 0) count += 1 + result.callers.length;
  if (result.callees.length > 0) count += 1 + result.callees.length;
  if (result.path && result.path.length > 0) count += 1 + result.path.length;
  if (result.resources) for (const r of result.resources) count += estimateResourceLines(r);
  if (result.dependencies) count += 1 + result.dependencies.length;
  if (result.dependents) count += 1 + result.dependents.length;
  return count;
}
