import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer';
import { Config } from '../src/config';
import { DB } from '../src/db/index';

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
        `package ${pkg};\npublic class ${simpleName} {}\n`,
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

describe('pendingReindex coalescing (T3.1, T3.8)', () => {
    let tmpDir: string;
    let repoDir: string;
    let dbFile: string;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-reindex-'));
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

    it('coalesces concurrent index() calls into a single pending flag (T3.1)', async () => {
        buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');

        const indexer = Indexer.getInstance();

        // Simulate an in-progress index pass.
        (indexer as any).isIndexing = true;

        // Multiple concurrent calls should each set pendingReindex and return early.
        await indexer.index();
        await indexer.index();
        await indexer.index();

        expect((indexer as any).pendingReindex).toBe(true);

        // Reset: a normal call (isIndexing=false) clears the flag via the drain in finally.
        (indexer as any).isIndexing = false;
        // Clear pendingReindex so the real index() below does not trigger a follow-up.
        (indexer as any).pendingReindex = false;

        await indexer.index();
        // After a clean pass, no pending reindex remains.
        expect((indexer as any).pendingReindex).toBe(false);
        expect((indexer as any).isIndexing).toBe(false);

        // The artifact was actually indexed by the clean pass.
        expect(indexer.searchClass('LibA').length).toBeGreaterThan(0);
    });

    it('drains exactly one follow-up index() after a pass that saw a concurrent call (T3.8)', async () => {
        buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');

        const indexer = Indexer.getInstance();

        // Wrap index() so we can count every invocation (including the
        // fire-and-forget drain triggered by the finally block).
        const originalIndex = indexer.index.bind(indexer);
        let indexCallCount = 0;
        const indexSpy = vi.spyOn(indexer, 'index').mockImplementation(async (opts: any = {}) => {
            indexCallCount++;
            return originalIndex(opts);
        });

        // Inject a concurrent index() call while the first pass is running by
        // intercepting indexArtifactClasses (called once per artifact).
        const realIndexArtifactClasses = (indexer as any).indexArtifactClasses.bind(indexer);
        let triggered = false;
        vi.spyOn(indexer as any, 'indexArtifactClasses').mockImplementation(async (artifact: any) => {
            if (!triggered) {
                triggered = true;
                // isIndexing is true here; this should set pendingReindex and return early.
                await indexer.index();
            }
            return realIndexArtifactClasses(artifact);
        });

        // First pass: runs the body, sees the concurrent call, finally drains pendingReindex.
        // The drain's `this.index()` call in the finally block fires synchronously,
        // so the spy's mockImplementation increments indexCallCount before the
        // first pass's promise resolves. Therefore by the time `await indexer.index()`
        // returns we already have: 1 (first pass) + 1 (concurrent early-return)
        // + 1 (drain started by finally) = 3.
        await indexer.index();
        expect(indexCallCount).toBe(3);

        // The drain is fire-and-forget; allow it to complete.
        await new Promise((resolve) => setTimeout(resolve, 500));

        // No further calls happen after the drain settles.
        expect(indexCallCount).toBe(3);

        // The drain should have consumed the flag.
        expect((indexer as any).pendingReindex).toBe(false);
        expect((indexer as any).isIndexing).toBe(false);

        // The follow-up pass actually re-indexed the artifact (search still works).
        expect(indexer.searchClass('LibA').length).toBeGreaterThan(0);

        indexSpy.mockRestore();
    });

    it('does not trigger a follow-up pass when no concurrent call arrived (T3.1)', async () => {
        buildArtifact(repoDir, 'com.test', 'lib-a', '1.0.0', 'com.test.LibA');

        const indexer = Indexer.getInstance();

        const originalIndex = indexer.index.bind(indexer);
        let indexCallCount = 0;
        const indexSpy = vi.spyOn(indexer, 'index').mockImplementation(async (opts: any = {}) => {
            indexCallCount++;
            return originalIndex(opts);
        });

        await indexer.index();
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Exactly one call: no concurrent trigger means no drain.
        expect(indexCallCount).toBe(1);
        expect((indexer as any).pendingReindex).toBe(false);

        indexSpy.mockRestore();
    });
});
