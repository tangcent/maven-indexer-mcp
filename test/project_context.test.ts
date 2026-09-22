import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { Indexer, Config, DB, getProjectContext, explore } from '@maven-indexer/engine';
import { buildArtifact, createTempWorkspace } from './helpers/fixture.js';

const SIDECAR_DIR = path.join(os.homedir(), '.maven-indexer-mcp', 'projects');

function sidecarPathFor(buildFile: string): string {
  const hash = crypto.createHash('sha256').update(buildFile).digest('hex');
  return path.join(SIDECAR_DIR, `${hash}.json`);
}

/**
 * Covers the declared dependency view, graceful degradation, sidecar caching,
 * and — through `explore` — the project-pinning policy.
 */
describe('project context', () => {
  let tmpDir: string;
  let repoDir: string;
  let projectDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    const ws = createTempWorkspace('pctx-');
    tmpDir = ws.tmpDir;
    repoDir = ws.repoDir;
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    savedEnv = {
      DB_FILE: process.env.DB_FILE,
      MAVEN_REPO_PATH: process.env.MAVEN_REPO_PATH,
      GRADLE_REPO_PATH: process.env.GRADLE_REPO_PATH,
    };
    process.env.DB_FILE = ws.dbFile;
    process.env.MAVEN_REPO_PATH = repoDir;
    process.env.GRADLE_REPO_PATH = path.join(tmpDir, 'no-gradle');

    DB.reset();
    Config.reset();
    (Indexer as any).instance = undefined;

    const config = await Config.getInstance();
    config.localRepository = repoDir;
    config.gradleRepository = '';

    buildArtifact(repoDir, 'com.example', 'target-lib', '1.0.0', 'com.example.Target');
    buildArtifact(repoDir, 'com.example', 'target-lib', '2.0.0', 'com.example.Target');

    await Indexer.getInstance().index();
  });

  afterEach(() => {
    DB.reset();
    Config.reset();
    (Indexer as any).instance = undefined;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const name of ['pom.xml', 'build.gradle']) {
      const p = sidecarPathFor(path.join(projectDir, name));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('parses the Maven declared view and the project coordinate', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'pom.xml'),
      `<project><modelVersion>4.0.0</modelVersion>
       <groupId>com.example</groupId><artifactId>demo</artifactId><version>3.1.4</version>
       <dependencies><dependency>
         <groupId>com.example</groupId><artifactId>target-lib</artifactId><version>1.0.0</version>
       </dependency></dependencies></project>`,
    );

    const ctx = await getProjectContext(projectDir);

    expect(ctx.kind).toBe('maven');
    expect(ctx.buildFile).toBe(path.join(projectDir, 'pom.xml'));
    expect(ctx.projectCoordinate).toEqual({ groupId: 'com.example', artifactId: 'demo', version: '3.1.4' });
    expect(ctx.declared).toEqual([{ groupId: 'com.example', artifactId: 'target-lib', version: '1.0.0' }]);
    expect(ctx.tree).toBe('declared');
  });

  it('parses the Gradle declared view, mapping configurations to scopes', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'build.gradle'),
      `plugins { id 'java' }\n` +
      `dependencies {\n` +
      `  implementation "com.example:target-lib:1.0.0"\n` +
      `  testImplementation 'com.example:other:2.0.0'\n` +
      `}\n`,
    );

    const ctx = await getProjectContext(projectDir);

    expect(ctx.kind).toBe('gradle');
    expect(ctx.declared).toEqual([
      { groupId: 'com.example', artifactId: 'target-lib', version: '1.0.0', scope: 'compile' },
      { groupId: 'com.example', artifactId: 'other', version: '2.0.0', scope: 'test' },
    ]);
  });

  it('returns kind none when no build file exists (no throw)', async () => {
    const ctx = await getProjectContext(projectDir);
    expect(ctx.kind).toBe('none');
    expect(ctx.tree).toBe('none');
    expect(ctx.declared).toEqual([]);
  });

  it('degrades instead of throwing when the declared view cannot be parsed', async () => {
    fs.writeFileSync(path.join(projectDir, 'pom.xml'), 'this is not xml <<<');
    const ctx = await getProjectContext(projectDir);
    expect(ctx.kind).toBe('maven');
    expect(ctx.declared).toEqual([]);
    expect(ctx.resolveError).toBeDefined();
  });

  it('writes a sidecar cache and invalidates it when the build file changes', async () => {
    const pomPath = path.join(projectDir, 'pom.xml');
    const writePom = (version: string) => fs.writeFileSync(
      pomPath,
      `<project><groupId>com.example</groupId><artifactId>demo</artifactId>
       <version>${version}</version></project>`,
    );

    writePom('1.0.0');
    const first = await getProjectContext(projectDir);
    expect(first.projectCoordinate?.version).toBe('1.0.0');

    const sidecar = sidecarPathFor(pomPath);
    expect(fs.existsSync(sidecar)).toBe(true);

    // Same mtime would be a cache hit; changing the file must invalidate it.
    writePom('2.0.0');
    const second = await getProjectContext(projectDir);
    expect(second.projectCoordinate?.version).toBe('2.0.0');
  });

  it('pins class resolution to the version declared by the project', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'pom.xml'),
      `<project><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version>
       <dependencies><dependency>
         <groupId>com.example</groupId><artifactId>target-lib</artifactId><version>1.0.0</version>
       </dependency></dependencies></project>`,
    );

    const pinned = await explore({
      identifiers: ['com.example.Target'],
      projectPath: projectDir,
    });
    expect(pinned._meta.project.resolution).toBe('project-pinned');
    expect(pinned._meta.resolved['com.example.Target'].artifact).toBe('com.example:target-lib:1.0.0');
    expect(pinned._meta.resolved['com.example.Target'].policy).toBe('project-pinned');

    // Without the project lens the engine falls back to the cache-wide
    // heuristic (which version it lands on is resolver policy, not this test's
    // concern — what matters is that it is NOT attributed to the project).
    const unpinned = await explore({ identifiers: ['com.example.Target'] });
    expect(unpinned._meta.project.resolution).toBe('cache-wide');
    expect(unpinned._meta.resolved['com.example.Target'].policy).toBe('cache-wide');
  });
});
