import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

/**
 * Integration tests for the MCP call-graph query layer (Module 4 Req 2 & 3).
 * Mirrors the CLI call_graph.test.ts — same SQL row insertions, same queries.
 */
describe('MCP call-graph queries', () => {
    let tmpDir: string;
    let repoDir: string;
    let dbFile: string;
    let savedEnv: Record<string, string | undefined>;
    let indexer: any;
    let db: any;
    let artifactA: number;
    let artifactB: number;
    let artifactC: number;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cg-'));
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

        // Three artifacts: A -> B -> C
        buildArtifact(repoDir, 'com.example', 'svc-a', '1.0.0', 'com.example.svc.A');
        buildArtifact(repoDir, 'com.example', 'svc-b', '1.0.0', 'com.example.svc.B');
        buildArtifact(repoDir, 'com.example', 'svc-c', '1.0.0', 'com.example.svc.C');

        indexer = Indexer.getInstance();
        await indexer.index();

        db = DB.getInstance().getDb();

        // Clear any call edges the indexer may have extracted from the
        // compiled `echo` method bodies — we want deterministic test data.
        db.exec('DELETE FROM call_edges');

        artifactA = db.prepare('SELECT id FROM artifacts WHERE artifact_id = ?').get('svc-a').id;
        artifactB = db.prepare('SELECT id FROM artifacts WHERE artifact_id = ?').get('svc-b').id;
        artifactC = db.prepare('SELECT id FROM artifacts WHERE artifact_id = ?').get('svc-c').id;

        const insert = db.prepare(`
            INSERT INTO call_edges
                (caller_class, caller_method, caller_descriptor,
                 callee_class, callee_method, callee_descriptor,
                 invoke_kind, artifact_id, resolved)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const ins = (cc: string, cm: string, cd: string, ec: string, em: string, ed: string, kind: string, aid: number) =>
            insert.run(cc, cm, cd, ec, em, ed, kind, aid, 1);

        ins('com.example.svc.A', 'run', '()V', 'com.example.svc.B', 'execute', '()V', 'virtual', artifactA);
        ins('com.example.svc.A', 'run', '()V', 'com.example.svc.B', 'validate', '()V', 'virtual', artifactA);
        ins('com.example.svc.B', 'execute', '()V', 'com.example.svc.C', 'process', '()V', 'virtual', artifactB);
        ins('com.example.svc.B', 'validate', '()V', 'com.example.svc.C', 'process', '()V', 'virtual', artifactB);
        ins('com.example.svc.B', 'validate', '()V', 'com.example.svc.C', 'process', '()V', 'virtual', artifactB);
    });

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

    it('isCallGraphAvailable returns true when call_edges has rows', () => {
        expect(indexer.isCallGraphAvailable()).toBe(true);
    });

    it('searchCallers finds methods that call a specific class.method', () => {
        const results = indexer.searchCallers('com.example.svc.B', 'execute');
        expect(results).toHaveLength(1);
        const r = results[0];
        expect(r.className).toBe('com.example.svc.A');
        expect(r.methodName).toBe('run');
        expect(r.invokeKind).toBe('virtual');
        expect(r.resolved).toBe(true);
        expect(r.sites).toBe(1);
    });

    it('searchCallers with class-only target returns all callers of the class', () => {
        const results = indexer.searchCallers('com.example.svc.C', undefined);
        expect(results).toHaveLength(2);
        const callers = results.map((r: any) => `${r.className}.${r.methodName}`).sort();
        expect(callers).toEqual(['com.example.svc.B.execute', 'com.example.svc.B.validate']);
    });

    it('searchCallers dedupes edges and reports sites count', () => {
        const results = indexer.searchCallers('com.example.svc.C', 'process');
        expect(results).toHaveLength(2);
        const validateEdge = results.find((r: any) => r.methodName === 'validate');
        expect(validateEdge).toBeDefined();
        expect(validateEdge.sites).toBe(2);
    });

    it('searchCallees finds methods called by a specific class.method', () => {
        const results = indexer.searchCallees('com.example.svc.A', 'run');
        expect(results).toHaveLength(2);
        const callees = results.map((r: any) => `${r.className}.${r.methodName}`).sort();
        expect(callees).toEqual(['com.example.svc.B.execute', 'com.example.svc.B.validate']);
    });

    it('searchCallees with class-only target returns all callees of the class', () => {
        const results = indexer.searchCallees('com.example.svc.B', undefined);
        expect(results).toHaveLength(1);
        expect(results[0].className).toBe('com.example.svc.C');
        expect(results[0].methodName).toBe('process');
        expect(results[0].sites).toBe(3);
    });

    it('impact traverses callers up to the given depth (method-level)', () => {
        const result = indexer.impact('com.example.svc.C', 'process', { depth: 3 });
        expect(result.callGraphAvailable).toBe(true);
        expect(result.nodes.length).toBe(3);

        const depth1 = result.nodes.filter((n: any) => n.depth === 1);
        const depth2 = result.nodes.filter((n: any) => n.depth === 2);
        expect(depth1.length).toBe(2);
        expect(depth2.length).toBe(1);
        expect(depth2[0].className).toBe('com.example.svc.A');
        expect(depth2[0].methodName).toBe('run');
    });

    it('impact with class-only target does class-level traversal', () => {
        const result = indexer.impact('com.example.svc.C', undefined, { depth: 3 });
        expect(result.nodes.length).toBe(2);
        const d1 = result.nodes.find((n: any) => n.depth === 1);
        const d2 = result.nodes.find((n: any) => n.depth === 2);
        expect(d1.className).toBe('com.example.svc.B');
        expect(d1.methodName).toBeUndefined();
        expect(d2.className).toBe('com.example.svc.A');
    });

    it('impact respects depth cap', () => {
        const result = indexer.impact('com.example.svc.C', 'process', { depth: 1 });
        expect(result.nodes.length).toBe(2);
        expect(result.nodes.every((n: any) => n.depth === 1)).toBe(true);
    });

    it('impact respects maxNodes cap and reports truncated', () => {
        const result = indexer.impact('com.example.svc.C', 'process', { depth: 5, maxNodes: 1 });
        expect(result.nodes.length).toBe(1);
        expect(result.truncated).toBeGreaterThanOrEqual(1);
    });

    it('impact marks cycle nodes (diamond re-encounter)', () => {
        const result = indexer.impact('com.example.svc.C', 'process', { depth: 5 });
        const aRun = result.nodes.find((n: any) => n.className === 'com.example.svc.A' && n.methodName === 'run');
        expect(aRun).toBeDefined();
        expect(aRun.cycle).toBe(true);
    });
});
