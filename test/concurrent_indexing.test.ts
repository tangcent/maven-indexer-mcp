import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'node:child_process';
import { Indexer, Config, DB, acquireIndexLock, indexLockPath } from '@maven-indexer/engine';
import { buildArtifact, createTempWorkspace } from './helpers/fixture.js';

/**
 * Regression coverage for issue #20: "Indexing failed SqliteError: database is
 * locked". Several agent sessions launch their own MCP server and share one
 * SQLite file; their startup index passes used to collide on the write lock.
 */
describe('concurrent indexing against a shared DB', () => {
  let tmpDir: string;
  let repoDir: string;
  let dbFile: string;
  let savedEnv: Record<string, string | undefined>;
  let child: ChildProcess | undefined;

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  beforeEach(async () => {
    const ws = createTempWorkspace('concurrent-');
    tmpDir = ws.tmpDir;
    repoDir = ws.repoDir;
    dbFile = ws.dbFile;

    savedEnv = {
      DB_FILE: process.env.DB_FILE,
      MAVEN_REPO_PATH: process.env.MAVEN_REPO_PATH,
      GRADLE_REPO_PATH: process.env.GRADLE_REPO_PATH,
      MAVEN_INDEXER_CFR_PATH: process.env.MAVEN_INDEXER_CFR_PATH,
      MAVEN_INDEXER_INDEX_LOCK_WAIT_MS: process.env.MAVEN_INDEXER_INDEX_LOCK_WAIT_MS,
    };
    process.env.DB_FILE = dbFile;
    process.env.MAVEN_REPO_PATH = repoDir;
    process.env.GRADLE_REPO_PATH = path.join(tmpDir, 'no-gradle');
    process.env.MAVEN_INDEXER_CFR_PATH = path.resolve(__dirname, '..', 'packages', 'engine', 'lib', 'cfr-0.152.jar');
    // Tests must not spend the production 15s waiting for a lock.
    process.env.MAVEN_INDEXER_INDEX_LOCK_WAIT_MS = '0';

    DB.reset();
    Config.reset();
    (Indexer as any).instance = undefined;

    const config = await Config.getInstance();
    config.localRepository = repoDir;
    config.gradleRepository = '';

    buildArtifact(repoDir, 'com.example', 'concurrent-lib', '1.0.0', 'com.example.LockProbe');
  });

  afterEach(() => {
    if (child && !child.killed) child.kill();
    child = undefined;
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

  it('skips a pass when another process holds the index lock, then indexes after it is released', async () => {
    const foreignLock = await acquireIndexLock(dbFile, 0);
    expect(foreignLock).not.toBeNull();

    const indexer = Indexer.getInstance();
    const skipped = await indexer.index();
    expect(skipped.skipped).toBe(true);
    expect(skipped.scanned).toBe(0);
    expect((DB.getInstance().prepare('SELECT COUNT(*) as n FROM artifacts').get() as { n: number }).n).toBe(0);

    foreignLock!.release();

    const result = await indexer.index();
    expect(result.skipped).toBeFalsy();
    expect(result.scanned).toBe(1);
    expect(indexer.searchClass('LockProbe').length).toBeGreaterThan(0);
    expect(fs.existsSync(indexLockPath(dbFile))).toBe(false);
  });

  it('does not touch the existing index when refresh() cannot get the lock', async () => {
    const indexer = Indexer.getInstance();
    await indexer.index();
    expect(indexer.searchClass('LockProbe').length).toBeGreaterThan(0);

    const foreignLock = await acquireIndexLock(dbFile, 0);
    const result = await indexer.refresh();
    expect(result.skipped).toBe(true);

    // No DDL ran: the live index is intact and no shadow tables were left behind.
    expect(indexer.searchClass('LockProbe').length).toBeGreaterThan(0);
    const db = DB.getInstance().getDb();
    const shadow = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_new'").all() as { name: string }[];
    expect(shadow).toEqual([]);
    expect((db.prepare('SELECT is_indexed FROM artifacts').get() as { is_indexed: number }).is_indexed).toBe(1);

    foreignLock!.release();
  });

  it('reclaims a lock left by a dead process and one with a stale heartbeat', async () => {
    const lockPath = indexLockPath(dbFile);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, token: 'dead-owner', startedAt: Date.now() }));

    const recovered = await acquireIndexLock(dbFile, 0);
    expect(recovered).not.toBeNull();
    expect((JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { token: string }).token).not.toBe('dead-owner');

    // A live owner whose heartbeat stopped is also considered abandoned.
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockPath, old, old);
    const result = await Indexer.getInstance().index();
    expect(result.skipped).toBeFalsy();
    expect(result.scanned).toBe(1);

    // index() released its own lock; the recovered one must not delete it.
    recovered!.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('keeps a live lock fresh via heartbeat and never deletes a taken-over lock', async () => {
    const lockPath = indexLockPath(dbFile);
    const lock = await acquireIndexLock(dbFile, 0);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockPath, old, old);
    lock!.beat();
    expect(fs.statSync(lockPath).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    expect(await acquireIndexLock(dbFile, 0)).toBeNull();

    // Simulate another process taking over the lock file.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'other-owner', startedAt: Date.now() }));
    lock!.release();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect((JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { token: string }).token).toBe('other-owner');
  });

  it('opens the shared DB in WAL mode with a 30s busy timeout', () => {
    const db = DB.getInstance().getDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(30_000);
  });

  it('waits for a write lock held by another process instead of failing with SQLITE_BUSY', async () => {
    // Creates the schema (including `meta`) in WAL mode before the other
    // process opens the same file.
    const db = DB.getInstance();
    const readyFile = path.join(tmpDir, 'writer-ready');

    const holderScript = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1]);
      db.pragma('busy_timeout = 10000');
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lock_holder', '1')").run();
      require('fs').writeFileSync(process.argv[2], 'ready');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 6000);
    `;
    child = spawn(process.execPath, ['-e', holderScript, dbFile, readyFile], { cwd: path.resolve(__dirname, '..') });

    for (let i = 0; i < 100 && !fs.existsSync(readyFile); i++) await sleep(50);
    expect(fs.existsSync(readyFile)).toBe(true);

    const start = Date.now();
    // Old code used a 5s busy timeout and threw here; the new timeout outlasts
    // the 6s holder, so the write succeeds once the holder commits.
    db.transaction(() => {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('contention', 'ok')").run();
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(5_000);
    expect((db.prepare("SELECT value FROM meta WHERE key = 'contention'").get() as { value: string }).value).toBe('ok');
  });
});
