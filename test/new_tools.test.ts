import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer';
import { Config } from '../src/config';
import { DB } from '../src/db/index';

/**
 * Builds an artifact whose JAR contains a compiled .class file plus a
 * META-INF/services text resource, and whose POM optionally declares deps.
 */
function buildArtifact(
    repoRoot: string,
    groupId: string,
    artifactId: string,
    version: string,
    className: string,
    methodDecls: string[],
    resourcePath: string | null,
    resourceContent: string | null,
    dependencies: { groupId: string; artifactId: string; version: string; scope?: string }[],
): string {
    const groupPath = groupId.replace(/\./g, '/');
    const artifactDir = path.join(repoRoot, groupPath, artifactId, version);
    fs.mkdirSync(artifactDir, { recursive: true });

    const pkg = className.substring(0, className.lastIndexOf('.'));
    const simpleName = className.substring(className.lastIndexOf('.') + 1);
    const pkgPath = pkg.replace(/\./g, '/');

    const stageDir = path.join(artifactDir, '.stage');
    fs.mkdirSync(path.join(stageDir, pkgPath), { recursive: true });
    fs.writeFileSync(
        path.join(stageDir, pkgPath, `${simpleName}.java`),
        `package ${pkg};\npublic class ${simpleName} {\n${methodDecls.map(m => `  ${m}`).join('\n')}\n}\n`,
    );
    execSync(`javac ${path.join(stageDir, pkgPath, `${simpleName}.java`)}`);

    if (resourcePath && resourceContent !== null) {
        const resDir = path.join(stageDir, path.dirname(resourcePath));
        fs.mkdirSync(resDir, { recursive: true });
        fs.writeFileSync(path.join(stageDir, resourcePath), resourceContent);
    }

    const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
    execSync(`jar -cf ${jarPath} -C ${stageDir} .`);

    const depsXml = dependencies.length > 0
        ? `<dependencies>${dependencies.map(d => `<dependency><groupId>${d.groupId}</groupId><artifactId>${d.artifactId}</artifactId><version>${d.version}</version>${d.scope ? `<scope>${d.scope}</scope>` : ''}</dependency>`).join('')}</dependencies>`
        : '';
    fs.writeFileSync(
        path.join(artifactDir, `${artifactId}-${version}.pom`),
        `<project><modelVersion>4.0.0</modelVersion><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version>${depsXml}</project>`,
    );

    fs.rmSync(stageDir, { recursive: true, force: true });
    return artifactDir;
}

describe('New Indexer tools (T6A.1-T6A.5, T6B.4, T6B.10)', () => {
    let tmpDir: string;
    let repoDir: string;
    let dbFile: string;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-tools-'));
        repoDir = path.join(tmpDir, 'repo');
        dbFile = path.join(tmpDir, 'index.sqlite');
        fs.mkdirSync(repoDir, { recursive: true });

        savedEnv = {
            DB_FILE: process.env.DB_FILE,
            MAVEN_REPO_PATH: process.env.MAVEN_REPO_PATH,
            GRADLE_REPO_PATH: process.env.GRADLE_REPO_PATH,
            MAVEN_INDEXER_CFR_PATH: process.env.MAVEN_INDEXER_CFR_PATH,
            INDEX_METHODS: process.env.INDEX_METHODS,
        };
        process.env.DB_FILE = dbFile;
        process.env.MAVEN_REPO_PATH = repoDir;
        process.env.GRADLE_REPO_PATH = path.join(tmpDir, 'no-gradle');
        process.env.MAVEN_INDEXER_CFR_PATH = path.resolve(__dirname, '..', 'lib', 'cfr-0.152.jar');
        // Enable method indexing for searchMethods tests.
        process.env.INDEX_METHODS = '1';

        DB.reset();
        Config.reset();
        (Indexer as any).instance = undefined;

        const config = await Config.getInstance();
        config.localRepository = repoDir;
        config.gradleRepository = '';
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

    async function setupTwoArtifacts() {
        // lib-core: has a class with a method + a properties resource.
        // A root-level .properties file is used (rather than META-INF/services/*)
        // because the indexer also indexes the `META-INF/services/` directory
        // entry itself, which would inflate the resource count.
        buildArtifact(
            repoDir,
            'com.example',
            'lib-core',
            '1.0.0',
            'com.example.CoreService',
            ['public String doWork(String input) { return input; }'],
            'app.properties',
            'impl=com.example.impl.CoreServiceImpl',
            [],
        );
        // lib-app: depends on lib-core.
        buildArtifact(
            repoDir,
            'com.example',
            'lib-app',
            '1.0.0',
            'com.example.App',
            ['public void run() {}'],
            null,
            null,
            [{ groupId: 'com.example', artifactId: 'lib-core', version: '1.0.0', scope: 'compile' }],
        );

        const indexer = Indexer.getInstance();
        await indexer.index();
        return indexer;
    }

    it('getArtifactInfo returns class/resource counts and jar existence (T6A.1)', async () => {
        const indexer = await setupTwoArtifacts();
        const info = indexer.getArtifactInfo('com.example', 'lib-core', '1.0.0');
        expect(info.length).toBe(1);
        const item = info[0];
        expect(item.artifact.groupId).toBe('com.example');
        expect(item.artifact.artifactId).toBe('lib-core');
        expect(item.artifact.version).toBe('1.0.0');
        expect(item.classCount).toBe(1);
        expect(item.resourceCount).toBe(1);
        expect(item.mainJarExists).toBe(true);
    });

    it('getArtifactInfo without version returns every known version (T6A.1)', async () => {
        const indexer = await setupTwoArtifacts();
        const info = indexer.getArtifactInfo('com.example', 'lib-core');
        expect(info.length).toBe(1);
        expect(info[0].artifact.version).toBe('1.0.0');
    });

    it('getArtifactInfo returns empty for a non-existent coordinate (T6A.1)', async () => {
        const indexer = await setupTwoArtifacts();
        const info = indexer.getArtifactInfo('com.nope', 'missing', '9.9.9');
        expect(info).toEqual([]);
    });

    it('getStats returns aggregate counts and db metadata (T6A.2)', async () => {
        const indexer = await setupTwoArtifacts();
        const stats = indexer.getStats();
        expect(stats.artifactCount).toBe(2);
        expect(stats.classCount).toBeGreaterThanOrEqual(2);
        expect(stats.resourceCount).toBe(1);
        expect(stats.lastIndexedAt).not.toBeNull();
        expect(stats.dbPath).toBe(dbFile);
        expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });

    it('listClasses returns distinct class names for a coordinate (T6A.3)', async () => {
        const indexer = await setupTwoArtifacts();
        const classes = indexer.listClasses('com.example', 'lib-core', '1.0.0');
        expect(classes).toContain('com.example.CoreService');
    });

    it('listClasses returns empty for a non-existent coordinate (T6A.3)', async () => {
        const indexer = await setupTwoArtifacts();
        const classes = indexer.listClasses('com.nope', 'missing', '9.9.9');
        expect(classes).toEqual([]);
    });

    it('getResource returns content for an indexed resource (T6A.4)', async () => {
        const indexer = await setupTwoArtifacts();
        const res = indexer.getResource(
            'com.example',
            'lib-core',
            '1.0.0',
            'app.properties',
        );
        expect(res).not.toBeNull();
        expect(res!.path).toBe('app.properties');
        expect(res!.content).toBe('impl=com.example.impl.CoreServiceImpl');
        expect(res!.type).toBe('properties');
    });

    it('getResource returns null for a missing resource (T6A.4)', async () => {
        const indexer = await setupTwoArtifacts();
        const res = indexer.getResource('com.example', 'lib-core', '1.0.0', 'META-INF/missing.txt');
        expect(res).toBeNull();
    });

    it('searchMethods returns methods by name with declaring class (T6B.4)', async () => {
        const indexer = await setupTwoArtifacts();
        const results = indexer.searchMethods('doWork', { exact: true });
        expect(results.length).toBe(1);
        expect(results[0].methodName).toBe('doWork');
        expect(results[0].className).toBe('com.example.CoreService');
        const coords = results[0].artifacts.map(a => `${a.groupId}:${a.artifactId}:${a.version}`);
        expect(coords).toContain('com.example:lib-core:1.0.0');
    });

    it('searchMethods substring match finds doWork (T6B.4)', async () => {
        const indexer = await setupTwoArtifacts();
        const results = indexer.searchMethods('Work');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results.some(r => r.methodName === 'doWork')).toBe(true);
    });

    it('searchMethods returns empty for a non-existent method (T6B.4)', async () => {
        const indexer = await setupTwoArtifacts();
        const results = indexer.searchMethods('noSuchMethodXYZ');
        expect(results).toEqual([]);
    });

    it('getDependencies returns parsed POM dependencies (T6B.10)', async () => {
        const indexer = await setupTwoArtifacts();
        const deps = indexer.getDependencies('com.example', 'lib-app', '1.0.0');
        expect(deps.length).toBe(1);
        expect(deps[0].groupId).toBe('com.example');
        expect(deps[0].artifactId).toBe('lib-core');
        expect(deps[0].version).toBe('1.0.0');
        expect(deps[0].scope).toBe('compile');
        expect(deps[0].optional).toBe(false);
    });

    it('getDependencies returns empty for a non-existent coordinate (T6B.10)', async () => {
        const indexer = await setupTwoArtifacts();
        const deps = indexer.getDependencies('com.nope', 'missing', '9.9.9');
        expect(deps).toEqual([]);
    });

    it('findDependents returns artifacts that declare a dependency (T6B.10)', async () => {
        const indexer = await setupTwoArtifacts();
        const dependents = indexer.findDependents('com.example', 'lib-core');
        expect(dependents.length).toBe(1);
        expect(dependents[0].groupId).toBe('com.example');
        expect(dependents[0].artifactId).toBe('lib-app');
        expect(dependents[0].version).toBe('1.0.0');
        expect(dependents[0].scope).toBe('compile');
    });

    it('findDependents returns empty when nothing depends on the coordinate (T6B.10)', async () => {
        const indexer = await setupTwoArtifacts();
        const dependents = indexer.findDependents('com.example', 'lib-app');
        expect(dependents).toEqual([]);
    });
});
