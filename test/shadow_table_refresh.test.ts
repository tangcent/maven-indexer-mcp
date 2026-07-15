import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { Indexer, Config, DB } from '@maven-indexer/engine';

/**
 * Builds a real Maven artifact (compiled .class file inside a JAR + POM) under
 * the given repo root. Returns the artifact directory.
 */
function buildArtifact(
    repoRoot: string,
    groupId: string,
    artifactId: string,
    version: string,
    className: string,
): string {
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
        `package ${pkg};\npublic class ${simpleName} {\n  public String echo(String s) { return s; }\n}\n`,
    );
    execSync(`javac ${path.join(srcDir, pkgPath, `${simpleName}.java`)}`);

    const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
    execSync(`jar -cf ${jarPath} -C ${srcDir} .`);

    fs.writeFileSync(
        path.join(artifactDir, `${artifactId}-${version}.pom`),
        `<project><modelVersion>4.0.0</modelVersion><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version></project>`,
    );

    fs.rmSync(srcDir, { recursive: true, force: true });
    return artifactDir;
}

describe('Shadow-table refresh (T4.1, T4.2, T4.5, T4.16)', () => {
    let tmpDir: string;
    let repoDir: string;
    let dbFile: string;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-refresh-'));
        repoDir = path.join(tmpDir, 'repo');
        dbFile = path.join(tmpDir, 'index.sqlite');
        fs.mkdirSync(repoDir, { recursive: true });

        savedEnv = {
            DB_FILE: process.env.DB_FILE,
            MAVEN_REPO_PATH: process.env.MAVEN_REPO_PATH,
            GRADLE_REPO_PATH: process.env.GRADLE_REPO_PATH,
            MAVEN_INDEXER_CFR_PATH: process.env.MAVEN_INDEXER_CFR_PATH,
        };
        process.env.DB_FILE = dbFile;
        process.env.MAVEN_REPO_PATH = repoDir;
        process.env.GRADLE_REPO_PATH = path.join(tmpDir, 'no-gradle');
        // Point CFR at the bundled jar to avoid any network download.
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

    it('preserves the old index when refresh() fails (T4.1, T4.2)', async () => {
        buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');
        buildArtifact(repoDir, 'com.test', 'lib-b', '1.0.0', 'com.test.LibB');

        const indexer = Indexer.getInstance();
        await indexer.index();

        // Sanity: classes are searchable before refresh.
        expect(indexer.searchClass('LibA').length).toBeGreaterThan(0);
        expect(indexer.searchClass('LibB').length).toBeGreaterThan(0);

        // Force refresh() to fail by making index() throw only in shadow mode.
        const originalIndex = indexer.index.bind(indexer);
        const indexSpy = vi.spyOn(indexer, 'index').mockImplementation(async (opts: any = {}) => {
            if (opts && opts.shadow === true) {
                throw new Error('forced shadow failure');
            }
            return originalIndex(opts);
        });

        await expect(indexer.refresh()).rejects.toThrow('forced shadow failure');

        // T4.2: old index must still be searchable.
        const libAResults = indexer.searchClass('LibA');
        const libBResults = indexer.searchClass('LibB');
        expect(libAResults.length).toBeGreaterThan(0);
        expect(libAResults[0].className).toBe('com.test.LibA');
        expect(libBResults.length).toBeGreaterThan(0);
        expect(libBResults[0].className).toBe('com.test.LibB');

        indexSpy.mockRestore();
    });

    it('leaves no _new shadow tables behind after a failed refresh (T4.5, T4.16)', async () => {
        buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');

        const indexer = Indexer.getInstance();
        await indexer.index();

        const originalIndex = indexer.index.bind(indexer);
        const indexSpy = vi.spyOn(indexer, 'index').mockImplementation(async (opts: any = {}) => {
            if (opts && opts.shadow === true) {
                throw new Error('forced shadow failure');
            }
            return originalIndex(opts);
        });

        await expect(indexer.refresh()).rejects.toThrow('forced shadow failure');

        const db = DB.getInstance().getDb();
        const newTables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_new'",
        ).all() as { name: string }[];
        expect(newTables).toEqual([]);

        indexSpy.mockRestore();
    });

    it('atomically swaps tables on a successful refresh (T4.1)', async () => {
        buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');

        const indexer = Indexer.getInstance();
        await indexer.index();

        const beforeCount = (DB.getInstance().getDb().prepare('SELECT COUNT(*) as c FROM classes_fts').get() as { c: number }).c;
        expect(beforeCount).toBeGreaterThan(0);

        await indexer.refresh();

        // After a successful refresh, classes are still searchable (swap worked).
        const results = indexer.searchClass('LibA');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].className).toBe('com.test.LibA');

        // No _new tables linger after a successful swap.
        const db = DB.getInstance().getDb();
        const newTables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_new'",
        ).all() as { name: string }[];
        expect(newTables).toEqual([]);
    });
});
