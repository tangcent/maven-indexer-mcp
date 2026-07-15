import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { Indexer, Config, DB } from '@maven-indexer/engine';

/**
 * Builds an artifact whose class implements java.io.Serializable so that the
 * `inheritance` table has at least one row. This is important because the
 * indexer force-re-indexes when inheritance is empty but artifacts are indexed
 * (legacy backfill path); an empty inheritance table would mask incremental
 * skip behavior.
 */
function buildArtifact(
    repoRoot: string,
    groupId: string,
    artifactId: string,
    version: string,
    className: string,
): { artifactDir: string; jarPath: string } {
    const groupPath = groupId.replace(/\./g, '/');
    const artifactDir = path.join(repoRoot, groupPath, artifactId, version);
    fs.mkdirSync(artifactDir, { recursive: true });

    const pkg = className.substring(0, className.lastIndexOf('.'));
    const simpleName = className.substring(className.lastIndexOf('.') + 1);
    const pkgPath = pkg.replace(/\./g, '/');

    const srcDir = path.join(artifactDir, '.src-tmp');
    fs.mkdirSync(path.join(srcDir, pkgPath), { recursive: true });
    fs.writeFileSync(
        path.join(srcDir, pkgPath, `${simpleName}.java`),
        `package ${pkg};\nimport java.io.Serializable;\npublic class ${simpleName} implements Serializable {\n  public String echo(String s) { return s; }\n}\n`,
    );
    execSync(`javac ${path.join(srcDir, pkgPath, `${simpleName}.java`)}`);

    const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
    execSync(`jar -cf ${jarPath} -C ${srcDir} .`);

    fs.writeFileSync(
        path.join(artifactDir, `${artifactId}-${version}.pom`),
        `<project><modelVersion>4.0.0</modelVersion><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version></project>`,
    );

    fs.rmSync(srcDir, { recursive: true, force: true });
    return { artifactDir, jarPath };
}

describe('Incremental indexing (T6B.6)', () => {
    let tmpDir: string;
    let repoDir: string;
    let dbFile: string;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-'));
        repoDir = path.join(tmpDir, 'repo');
        dbFile = path.join(tmpDir, 'index.sqlite');
        fs.mkdirSync(repoDir, { recursive: true });

        savedEnv = {
            DB_FILE: process.env.DB_FILE,
            MAVEN_REPO_PATH: process.env.MAVEN_REPO_PATH,
            GRADLE_REPO_PATH: process.env.GRADLE_REPO_PATH,
            MAVEN_INDEXER_CFR_PATH: process.env.MAVEN_INDEXER_CFR_PATH,
            MAVEN_INDEXER_FULL_SCAN_INTERVAL_HOURS: process.env.MAVEN_INDEXER_FULL_SCAN_INTERVAL_HOURS,
        };
        process.env.DB_FILE = dbFile;
        process.env.MAVEN_REPO_PATH = repoDir;
        process.env.GRADLE_REPO_PATH = path.join(tmpDir, 'no-gradle');
        process.env.MAVEN_INDEXER_CFR_PATH = path.resolve(__dirname, '..', 'lib', 'cfr-0.152.jar');

        DB.reset();
        Config.reset();
        (Indexer as any).instance = undefined;

        const config = await Config.getInstance();
        config.localRepository = repoDir;
        config.gradleRepository = '';
    });

    afterEach(() => {
        vi.restoreAllMocks();
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

    it('does not re-index an unchanged artifact on the second pass', async () => {
        const { artifactDir } = buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');

        const indexer = Indexer.getInstance();
        const spy = vi.spyOn(indexer as any, 'indexArtifactClasses');

        await indexer.index();
        expect(spy.mock.calls.length).toBe(1);
        expect(indexer.searchClass('LibA').length).toBeGreaterThan(0);

        // Second pass: nothing changed, artifact should be skipped.
        await indexer.index();
        expect(spy.mock.calls.length).toBe(1);

        // is_indexed stays 1.
        const db = DB.getInstance().getDb();
        const row = db.prepare('SELECT is_indexed FROM artifacts WHERE abspath = ?').get(artifactDir) as { is_indexed: number };
        expect(row.is_indexed).toBe(1);

        spy.mockRestore();
    });

    it('re-indexes when the artifact directory mtime changes', async () => {
        const { artifactDir } = buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');

        const indexer = Indexer.getInstance();
        const spy = vi.spyOn(indexer as any, 'indexArtifactClasses');

        await indexer.index();
        expect(spy.mock.calls.length).toBe(1);

        // Touch the directory with a future mtime to force a change.
        const future = new Date(Date.now() + 1_000_000);
        fs.utimesSync(artifactDir, future, future);

        await indexer.index();
        expect(spy.mock.calls.length).toBe(2);
        expect(indexer.searchClass('LibA').length).toBeGreaterThan(0);

        spy.mockRestore();
    });

    it('forces a full scan when last_full_scan is older than the interval', async () => {
        buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');

        const indexer = Indexer.getInstance();
        const spy = vi.spyOn(indexer as any, 'indexArtifactClasses');

        await indexer.index();
        expect(spy.mock.calls.length).toBe(1);

        // Backdate last_full_scan by 25 hours to exceed the default 24h interval.
        const db = DB.getInstance().getDb();
        const stale = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_full_scan', ?)").run(stale);

        await indexer.index();
        // Full scan resets is_indexed=0 for all, so the artifact is re-indexed.
        expect(spy.mock.calls.length).toBe(2);

        spy.mockRestore();
    });

    it('prunes artifacts whose main JAR has been deleted', async () => {
        const { jarPath } = buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');

        const indexer = Indexer.getInstance();
        await indexer.index();
        expect(indexer.search('lib-a').length).toBe(1);

        // Remove the JAR so the artifact is eligible for pruning.
        fs.unlinkSync(jarPath);

        await indexer.index();

        // Artifact row should be gone.
        expect(indexer.search('lib-a').length).toBe(0);
        const db = DB.getInstance().getDb();
        const row = db.prepare('SELECT COUNT(*) as c FROM artifacts').get() as { c: number };
        expect(row.c).toBe(0);
    });
});
