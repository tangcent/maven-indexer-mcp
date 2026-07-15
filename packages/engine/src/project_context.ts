/**
 * Module 8 — Project Context: a project-aware dependency-tree lens over the
 * cache-wide index.
 *
 * `getProjectContext(rootPath)` detects the build file (pom.xml / build.gradle),
 * parses the declared dependency view synchronously, and kicks off the resolved
 * view (`mvn dependency:tree` / `gradle dependencies`) in the background. The
 * first call returns the declared view; subsequent calls return the resolved
 * view once ready. Results are cached in-memory and in a sidecar JSON file,
 * keyed by build-file mtime.
 *
 * Design: see `.spec/maven-indexer-redesign/design.md` §D8.
 * Requirements: see `.spec/maven-indexer-redesign/requirements-project-context.md`.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { PomParser } from './pom_parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectCoordinate {
  groupId: string;
  artifactId: string;
  version: string;
}

export interface ProjectDep {
  groupId: string;
  artifactId: string;
  version?: string; // may be omitted in declared view (e.g. Gradle version catalog ref)
  scope?: string; // compile/provided/runtime/test/etc
}

export interface ResolvedTree {
  coordinates: ProjectDep[]; // flat list of all resolved coords (transitives included)
  rawText: string; // the full dependency:tree output (for debugging)
}

export interface ProjectContext {
  kind: 'maven' | 'gradle' | 'none';
  buildFile?: string; // absolute path
  buildFileMtime?: number; // ms epoch
  projectCoordinate?: ProjectCoordinate;
  declared: ProjectDep[];
  resolved?: ResolvedTree;
  tree: 'declared' | 'resolved' | 'none'; // 'none' when kind === 'none'
  resolveError?: string;
  lastResolveAttempt?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIDECAR_DIR = path.join(os.homedir(), '.maven-indexer-mcp', 'projects');
const RESOLVE_TIMEOUT_MS = 60_000;
const BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

const BUILD_FILES: ReadonlyArray<{ name: string; kind: 'maven' | 'gradle' }> = [
  { name: 'pom.xml', kind: 'maven' },
  { name: 'build.gradle', kind: 'gradle' },
  { name: 'build.gradle.kts', kind: 'gradle' },
  { name: 'settings.gradle', kind: 'gradle' },
  { name: 'settings.gradle.kts', kind: 'gradle' },
];

const GRADLE_CONFIG_SCOPES: Record<string, string> = {
  implementation: 'compile',
  api: 'compile',
  compileOnly: 'provided',
  runtimeOnly: 'runtime',
  testImplementation: 'test',
  compile: 'compile',
  runtime: 'runtime',
  testCompile: 'test',
  testRuntime: 'test',
  testImplementationOnly: 'test',
};

const KNOWN_PACKAGING_TYPES = new Set([
  'jar', 'pom', 'war', 'ear', 'bundle', 'aar', 'rar', 'tar', 'zip',
  'maven-plugin', 'ejb', 'par', 'dll', 'so', 'exe',
]);

// ---------------------------------------------------------------------------
// In-memory cache + in-flight tracking
// ---------------------------------------------------------------------------

/** Hot-path cache keyed by absolute build-file path. */
const memoryCache = new Map<string, ProjectContext>();

/** Tracks ongoing background resolution attempts to avoid duplicates. */
const resolutionInFlight = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the project context for the given root path.
 *
 * Walks up from `rootPath` to find the nearest build file (pom.xml /
 * build.gradle / build.gradle.kts / settings.gradle / settings.gradle.kts),
 * parses the declared dependency view synchronously, and kicks off the resolved
 * view in the background. First call returns `{ tree: "declared" }`; later
 * calls return `{ tree: "resolved" }` once the background resolution completes.
 *
 * Graceful degradation: if no build file is found, returns
 * `{ kind: "none", declared: [], tree: "none" }` without error (Req 1.4).
 */
export async function getProjectContext(rootPath: string): Promise<ProjectContext> {
  // 1. Walk up to find build file
  const found = findBuildFile(rootPath);
  if (!found) {
    return { kind: 'none', declared: [], tree: 'none' };
  }

  const { kind, buildFile } = found;

  // 2. stat build file → mtime key
  let mtime: number;
  try {
    mtime = fs.statSync(buildFile).mtimeMs;
  } catch {
    return { kind: 'none', declared: [], tree: 'none' };
  }

  // 3. In-memory cache check (hot path — avoids re-reading sidecar JSON)
  const memCached = memoryCache.get(buildFile);
  if (memCached && memCached.buildFileMtime === mtime) {
    maybeKickOffResolution(buildFile, memCached, kind);
    return memCached;
  }

  // 4. Sidecar cache check (cold start / cross-process)
  const sidecarCached = await readSidecar(buildFile, mtime);
  if (sidecarCached) {
    memoryCache.set(buildFile, sidecarCached);
    maybeKickOffResolution(buildFile, sidecarCached, kind);
    return sidecarCached;
  }

  // 5. Parse declared view synchronously (<50ms per NFR-8)
  const ctx = await parseDeclaredView(buildFile, kind, mtime);
  memoryCache.set(buildFile, ctx);
  await writeSidecar(buildFile, ctx);

  // 6. Kick off resolved view in background (non-blocking)
  maybeKickOffResolution(buildFile, ctx, kind);

  return ctx;
}

// ---------------------------------------------------------------------------
// Build file detection (walk up)
// ---------------------------------------------------------------------------

/**
 * Walks upward from `rootPath` looking for a build file. At each directory
 * level, files are checked in priority order: pom.xml first (Maven preferred
 * per Req 1.3), then build.gradle, build.gradle.kts, settings.gradle,
 * settings.gradle.kts. The first match (closest to root) wins.
 */
function findBuildFile(rootPath: string): { kind: 'maven' | 'gradle'; buildFile: string } | null {
  let dir = path.resolve(rootPath);
  const root = path.parse(dir).root;

  while (true) {
    for (const { name, kind } of BUILD_FILES) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) {
          return { kind, buildFile: candidate };
        }
      } catch {
        // ignore stat errors (permission, etc.)
      }
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Declared view parsing
// ---------------------------------------------------------------------------

async function parseDeclaredView(
  buildFile: string,
  kind: 'maven' | 'gradle',
  mtime: number,
): Promise<ProjectContext> {
  try {
    if (kind === 'maven') {
      const info = await PomParser.parseProjectInfo(buildFile);
      return {
        kind: 'maven',
        buildFile,
        buildFileMtime: mtime,
        projectCoordinate: info.projectCoordinate,
        declared: info.dependencies,
        tree: 'declared',
      };
    } else {
      const info = parseGradleBuildFile(buildFile);
      return {
        kind: 'gradle',
        buildFile,
        buildFileMtime: mtime,
        projectCoordinate: info.projectCoordinate,
        declared: info.dependencies,
        tree: 'declared',
      };
    }
  } catch (err) {
    // Declared parse failure — degrade gracefully (NFR-9)
    return {
      kind,
      buildFile,
      buildFileMtime: mtime,
      declared: [],
      tree: 'declared',
      resolveError: `Failed to parse declared view: ${(err as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Gradle declared view parser (minimal, regex-based — <50ms per NFR-8)
// ---------------------------------------------------------------------------

interface GradleParseResult {
  projectCoordinate?: ProjectCoordinate;
  dependencies: ProjectDep[];
}

function parseGradleBuildFile(buildFile: string): GradleParseResult {
  let content: string;
  try {
    content = fs.readFileSync(buildFile, 'utf-8');
  } catch {
    return { dependencies: [] };
  }

  // --- Project coordinate extraction ---
  let groupId: string | undefined;
  let artifactId: string | undefined;
  let version: string | undefined;

  const groupMatch = content.match(/^\s*group\s*=\s*["']([^"']+)["']/m);
  if (groupMatch) groupId = groupMatch[1];

  const versionMatch = content.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
  if (versionMatch) version = versionMatch[1];

  const archivesMatch = content.match(/^\s*archivesBaseName\s*=\s*["']([^"']+)["']/m);
  if (archivesMatch) {
    artifactId = archivesMatch[1];
  } else {
    const artifactIdMatch = content.match(/^\s*artifactId\s*=\s*["']([^"']+)["']/m);
    if (artifactIdMatch) artifactId = artifactIdMatch[1];
  }

  // Also try rootProject.name from settings.gradle
  if (!artifactId) {
    const rootNameMatch = content.match(/rootProject\.name\s*=\s*["']([^"']+)["']/);
    if (rootNameMatch) artifactId = rootNameMatch[1];
  }

  const projectCoordinate: ProjectCoordinate | undefined =
    groupId && artifactId && version
      ? { groupId, artifactId, version }
      : undefined;

  // --- Dependency extraction ---
  // Matches both `implementation "g:a:v"` and `implementation("g:a:v")` forms.
  const deps: ProjectDep[] = [];
  const depRegex =
    /(implementation|api|compileOnly|runtimeOnly|testImplementation|compile|runtime|testCompile|testRuntime|testImplementationOnly)\s*(?:\(\s*)?["']([^"':]+):([^"':]+):([^"':]+)["']\s*\)?/g;
  let match: RegExpExecArray | null;
  while ((match = depRegex.exec(content)) !== null) {
    const configName = match[1];
    const scope = GRADLE_CONFIG_SCOPES[configName] ?? 'compile';
    deps.push({
      groupId: match[2],
      artifactId: match[3],
      version: match[4],
      scope,
    });
  }

  return { projectCoordinate, dependencies: deps };
}

// ---------------------------------------------------------------------------
// Dependency tree output parsing (resolved view)
// ---------------------------------------------------------------------------

/**
 * Parses the output of `mvn dependency:tree` / `gradle dependencies` into a
 * flat list of resolved coordinates. Deduplicates by `g:a`, keeping the first
 * occurrence (resolved version).
 */
function parseDependencyTreeOutput(output: string, kind: 'maven' | 'gradle'): ProjectDep[] {
  const coords = new Map<string, ProjectDep>();

  for (const rawLine of output.split('\n')) {
    // Strip [INFO]/[WARNING]/[ERROR] prefixes (Maven)
    let line = rawLine.replace(/^\s*\[[A-Z]+\]\s*/, '');
    // Strip tree-drawing characters (+- | \- etc.)
    line = line.replace(/^[+\-| \\t]+/, '').trim();
    if (!line) continue;

    // Handle Gradle version mediation: "g:a:v -> v2" (resolved version is v2)
    if (kind === 'gradle') {
      const arrowIdx = line.indexOf(' -> ');
      if (arrowIdx >= 0) {
        const before = line.substring(0, arrowIdx).trim();
        const after = line.substring(arrowIdx + 4).trim();
        const coordPart = before.split(/\s+/)[0].replace(/\s*\(.*\)$/, '');
        const parts = coordPart.split(':');
        if (parts.length >= 3) {
          const g = parts[0];
          const a = parts[1];
          const v = after.split(/[\s()]/)[0];
          if (g && a && v && /\d/.test(v)) {
            const key = `${g}:${a}`;
            if (!coords.has(key)) {
              coords.set(key, { groupId: g, artifactId: a, version: v });
            }
          }
        }
        continue;
      }
    }

    // Extract the coordinate part (first whitespace-delimited token, stripped of markers)
    let coordPart = line.split(/\s+/)[0];
    // Remove Gradle markers: (*), (n), (c), etc.
    coordPart = coordPart.replace(/[()]/g, '').trim();
    if (!coordPart || coordPart.includes('->')) continue;

    const parts = coordPart.split(':');
    if (parts.length < 3 || parts.length > 6) continue;

    const g = parts[0];
    const a = parts[1];
    if (!g || !a) continue;

    let version: string | undefined;
    let scope: string | undefined;

    if (parts.length >= 5) {
      // g:a:type:v:scope (Maven) or g:a:type:v:scope:other
      if (KNOWN_PACKAGING_TYPES.has(parts[2].toLowerCase())) {
        version = parts[3];
        if (parts.length >= 5) scope = parts[4];
      } else {
        // Unusual format: g:a:v:scope:other
        version = parts[2];
        scope = parts[3];
      }
    } else if (parts.length === 4) {
      // g:a:type:v (Maven root) or g:a:v:scope
      if (KNOWN_PACKAGING_TYPES.has(parts[2].toLowerCase())) {
        version = parts[3];
      } else {
        version = parts[2];
        scope = parts[3];
      }
    } else {
      // parts.length === 3: g:a:v (Gradle)
      version = parts[2];
    }

    if (!version || !/\d/.test(version)) continue;

    const key = `${g}:${a}`;
    if (!coords.has(key)) {
      coords.set(key, { groupId: g, artifactId: a, version, scope });
    }
  }

  return Array.from(coords.values());
}

// ---------------------------------------------------------------------------
// Background resolution (resolved view)
// ---------------------------------------------------------------------------

/** Returns true if the context is within the 10-minute backoff window after a failure. */
function isWithinBackoff(ctx: ProjectContext): boolean {
  if (!ctx.resolveError || !ctx.lastResolveAttempt) return false;
  return Date.now() - ctx.lastResolveAttempt < BACKOFF_MS;
}

/**
 * Kicks off the background resolution (`mvn dependency:tree` / `gradle dependencies`)
 * if needed. Does NOT block — the caller receives the current (declared) context
 * immediately; the resolved view is populated asynchronously and visible on the
 * next call (Req 2.3 / NFR-8).
 *
 * Backoff: if the last attempt failed within 10 minutes, does not retry (Req 2.4).
 */
function maybeKickOffResolution(
  buildFile: string,
  ctx: ProjectContext,
  kind: 'maven' | 'gradle',
): void {
  // Already resolved — nothing to do
  if (ctx.resolved) return;

  // Within backoff window after a failure — don't retry (Req 2.4)
  if (isWithinBackoff(ctx)) return;

  // Already in flight — don't duplicate
  if (resolutionInFlight.has(buildFile)) return;

  const promise = runDependencyTree(buildFile, kind)
    .then((result) => {
      if (result.success) {
        ctx.resolved = { coordinates: result.coordinates, rawText: result.rawText };
        ctx.tree = 'resolved';
        ctx.resolveError = undefined;
      } else {
        ctx.resolveError = result.error;
        ctx.tree = 'declared';
      }
      ctx.lastResolveAttempt = Date.now();
      memoryCache.set(buildFile, ctx);
      void writeSidecar(buildFile, ctx);
    })
    .catch((err) => {
      ctx.resolveError = err instanceof Error ? err.message : String(err);
      ctx.tree = 'declared';
      ctx.lastResolveAttempt = Date.now();
      memoryCache.set(buildFile, ctx);
      void writeSidecar(buildFile, ctx);
    })
    .finally(() => {
      resolutionInFlight.delete(buildFile);
    });

  resolutionInFlight.set(buildFile, promise);
}

/**
 * Runs the build-system dependency tree command and returns parsed coordinates.
 * Maven: `mvn dependency:tree -DoutputType=text`. Gradle: `./gradlew dependencies`
 * or `gradle dependencies`. 60-second timeout (NFR-9).
 */
async function runDependencyTree(
  buildFile: string,
  kind: 'maven' | 'gradle',
): Promise<
  | { success: true; coordinates: ProjectDep[]; rawText: string }
  | { success: false; error: string; rawText: string }
> {
  const cwd = path.dirname(buildFile);

  let cmd: string;
  let args: string[];

  if (kind === 'maven') {
    cmd = 'mvn';
    args = ['dependency:tree', '-DoutputType=text'];
  } else {
    const gradlewPath = path.join(cwd, 'gradlew');
    try {
      if (fs.existsSync(gradlewPath)) {
        cmd = gradlewPath;
        // Ensure executable (Windows may need .bat, but on macOS/Linux chmod)
        try { fs.chmodSync(cmd, 0o755); } catch { /* ignore */ }
      } else {
        cmd = 'gradle';
      }
    } catch {
      cmd = 'gradle';
    }
    args = ['dependencies'];
  }

  try {
    const result = await spawnWithTimeout(cmd, args, cwd, RESOLVE_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      return {
        success: false,
        error: `${cmd} exited with code ${result.exitCode}${
          result.stderr ? ': ' + result.stderr.slice(0, 500) : ''
        }`,
        rawText: result.stdout + '\n' + result.stderr,
      };
    }
    const coordinates = parseDependencyTreeOutput(result.stdout, kind);
    return {
      success: true,
      coordinates,
      rawText: result.stdout,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to run ${cmd}: ${msg}`,
      rawText: '',
    };
  }
}

/** Spawns a child process with a hard timeout. Resolves stdout/stderr/exitCode. */
function spawnWithTimeout(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
      } else {
        resolve({ stdout, stderr, exitCode: code });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Sidecar JSON cache (Layer 2 persistence)
// ---------------------------------------------------------------------------

/** Returns the sidecar JSON path: ~/.maven-indexer-mcp/projects/<sha256(abspath)>.json */
function getSidecarPath(buildFile: string): string {
  const hash = crypto.createHash('sha256').update(buildFile).digest('hex');
  return path.join(SIDECAR_DIR, `${hash}.json`);
}

/** Reads the sidecar cache. Returns null if missing, invalid, or mtime mismatch. */
async function readSidecar(buildFile: string, expectedMtime: number): Promise<ProjectContext | null> {
  try {
    const sidecarPath = getSidecarPath(buildFile);
    const content = await fsp.readFile(sidecarPath, 'utf-8');
    const parsed = JSON.parse(content) as ProjectContext;
    // Cache hit only if the build-file mtime matches (Layer 2 invalidation law)
    if (parsed.buildFileMtime === expectedMtime) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Atomically writes the sidecar cache (write to temp file then rename). */
async function writeSidecar(buildFile: string, ctx: ProjectContext): Promise<void> {
  try {
    const sidecarPath = getSidecarPath(buildFile);
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    const tmpPath = `${sidecarPath}.tmp.${process.pid}`;
    const data = JSON.stringify(ctx, null, 2);
    await fsp.writeFile(tmpPath, data, 'utf-8');
    await fsp.rename(tmpPath, sidecarPath);
  } catch {
    // Best effort — don't fail the query over cache write errors (NFR-9)
  }
}
