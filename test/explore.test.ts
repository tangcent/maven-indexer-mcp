import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { Indexer, Config, DB, explore } from '@maven-indexer/engine';
import { buildArtifact, createTempWorkspace } from './helpers/fixture.js';

/**
 * Behaviour tests for the composed `explore` query: identifier classification
 * (class / `Class.method` / `g:a[:v]` / resource path), coordinate pinning, the
 * line budget, and the search-candidates fallback.
 */
describe('explore', () => {
  let tmpDir: string;
  let repoDir: string;
  let dbFile: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    const ws = createTempWorkspace('explore-');
    tmpDir = ws.tmpDir;
    repoDir = ws.repoDir;
    dbFile = ws.dbFile;

    savedEnv = {
      DB_FILE: process.env.DB_FILE,
      MAVEN_REPO_PATH: process.env.MAVEN_REPO_PATH,
      GRADLE_REPO_PATH: process.env.GRADLE_REPO_PATH,
      MAVEN_INDEXER_CFR_PATH: process.env.MAVEN_INDEXER_CFR_PATH,
    };
    applyTestEnv();

    DB.reset();
    Config.reset();
    (Indexer as any).instance = undefined;

    const config = await Config.getInstance();
    config.localRepository = repoDir;
    config.gradleRepository = '';

    // Two versions of the same artifact plus a resource-bearing one.
    // NOTE: the indexer only stores text resources matching its allowlist
    // (`.properties/.xml/.json/.yaml/.yml` and `META-INF/services/*`).
    buildArtifact(repoDir, 'com.example', 'greeter', '1.0.0', 'com.example.Greeter', [
      { path: 'META-INF/services/com.example.Greeter', content: 'com.example.Greeter\n' },
    ], 60);
    buildArtifact(repoDir, 'com.example', 'greeter', '2.0.0', 'com.example.Greeter', [], 60);

    await Indexer.getInstance().index();

    const db = DB.getInstance().getDb();
    // Deterministic call graph for the method-filtering assertions.
    db.exec('DELETE FROM call_edges');
    const rows = [
      ['com.example.Caller', 'alpha', '()V', 'com.example.Greeter', 'echo', '()V', 'virtual'],
      ['com.example.Caller', 'beta', '()V', 'com.example.Greeter', 'm1', '()I', 'virtual'],
    ];
    const insert = db.prepare(`
      INSERT INTO call_edges
        (caller_class, caller_method, caller_descriptor,
         callee_class, callee_method, callee_descriptor,
         invoke_kind, artifact_id, resolved)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
    `);
    for (const r of rows) insert.run(...r);
  });

  function applyTestEnv() {
    process.env.DB_FILE = dbFile;
    process.env.MAVEN_REPO_PATH = repoDir;
    process.env.GRADLE_REPO_PATH = path.join(tmpDir, 'no-gradle');
    process.env.MAVEN_INDEXER_CFR_PATH = path.resolve(__dirname, '..', 'packages', 'engine', 'lib', 'cfr-0.152.jar');
  }

  afterEach(() => {
    DB.reset();
    Config.reset();
    (Indexer as any).instance = undefined;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('resolves a class and reports the artifact it came from', async () => {
    const result = await explore({ identifiers: ['com.example.Greeter'] });

    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].className).toBe('com.example.Greeter');
    expect(result._meta.resolved['com.example.Greeter'].artifact).toMatch(/^com\.example:greeter:/);
    expect(result._meta.unresolved).toEqual([]);
    expect(result._meta.mode).toBe('explore');
  });

  it('pins the artifact when a g:a:v coordinate identifier is supplied', async () => {
    const result = await explore({
      identifiers: ['com.example:greeter:1.0.0', 'com.example.Greeter'],
    });

    expect(result._meta.resolved['com.example.Greeter'].artifact).toBe('com.example:greeter:1.0.0');
    expect(result._meta.resolved['com.example.Greeter'].policy).toBe('explicit');
  });

  it('falls back to the cache-wide heuristic when no coordinate is given', async () => {
    const result = await explore({ identifiers: ['com.example.Greeter'] });
    // Which version wins is resolver policy (covered by version_strategy.test.ts);
    // here we only assert it is NOT attributed to an explicit pin or project.
    expect(result._meta.resolved['com.example.Greeter'].policy).toBe('cache-wide');
    expect(result._meta.resolved['com.example.Greeter'].artifact).toMatch(/^com\.example:greeter:/);
  });

  it('reports unknown coordinates instead of silently returning nothing', async () => {
    const result = await explore({ identifiers: ['com.example:greeter:9.9.9'] });
    expect(result._meta.unresolved).toContain('com.example:greeter:9.9.9');
  });

  it('treats a resource path as a resource, not as a package.method', async () => {
    const result = await explore({
      identifiers: ['META-INF/services/com.example.Greeter'],
      include: ['resources'],
    });

    // Before the fix the path was mis-split into class "META-INF/services/com".
    expect(result._meta.unresolved).not.toContain('META-INF/services/com');
    expect(result.resources).toBeDefined();
    const paths = (result.resources ?? []).map(r => r.path);
    expect(paths.some(p => p.includes('META-INF/services/'))).toBe(true);
  });

  it('returns unresolved for a resource that does not exist', async () => {
    const result = await explore({
      identifiers: ['META-INF/does-not-exist.properties'],
      include: ['resources'],
    });
    expect(result._meta.unresolved).toContain('META-INF/does-not-exist.properties');
  });

  it('filters callers by the method named in Class.method input', async () => {
    const all = await explore({ identifiers: ['com.example.Greeter'], include: ['callers'] });
    const scoped = await explore({ identifiers: ['com.example.Greeter.m1'], include: ['callers'] });

    expect(all.callers.map(c => c.methodName)).toContain('alpha');
    expect(scoped.callers.map(c => c.methodName)).toContain('beta');
    expect(scoped.callers.map(c => c.methodName)).not.toContain('alpha');
  });

  it('honours the line budget in the structured payload', async () => {
    const budget = 25;
    const result = await explore({ identifiers: ['com.example.Greeter'], maxLines: budget });

    expect(result._meta.budget).toBe(budget);
    expect(result._meta.totalLines).toBeLessThanOrEqual(budget);
    expect(result._meta.sections.classes).toBe('truncated');
    const signatures = result.classes[0]?.signatures ?? [];
    expect(signatures.length).toBeLessThan(62); // 62 = echo + 60 generated methods
  });

  it('falls back to candidate search when nothing resolves and a question is asked', async () => {
    const result = await explore({
      identifiers: ['com.nope.Missing'],
      question: 'how does the Greeter work',
    });

    expect(result._meta.mode).toBe('search');
    expect(result._meta.unresolved).toContain('com.nope.Missing');
    expect(result.classes.length).toBeGreaterThan(0);
  });

  it('degrades to unknown when no project build file exists', async () => {
    const result = await explore({
      identifiers: ['com.example.Greeter'],
      projectPath: tmpDir,
    });
    expect(result._meta.project.kind).toBe('none');
    expect(result._meta.project.resolution).toBe('cache-wide');
  });
});
