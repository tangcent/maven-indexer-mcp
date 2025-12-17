import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import path from 'path';
import fs from 'fs';
import {execSync} from 'child_process';
import {Indexer} from '../src/indexer';
import {Config} from '../src/config';
import Database from 'better-sqlite3';

const TEST_REPO_DIR = path.resolve('test-repo-filtering');
const TEST_GRADLE_DIR = path.resolve('test-gradle-repo-filtering');
const DB_FILE = 'maven-index-filtering.sqlite';

function createMavenArtifacts() {
    // 1. Allowed Artifact
    createArtifact(TEST_REPO_DIR, 'com.test', 'allowed-lib', '1.0.0', 'com.test.Allowed');

    // 2. Ignored Artifact (should not be scanned)
    createArtifact(TEST_REPO_DIR, 'com.other', 'ignored-lib', '1.0.0', 'com.other.Ignored');
}

function createGradleArtifacts() {
    // 1. Allowed Artifact
    // Structure: group/artifact/version/hash/file
    createGradleArtifact(TEST_GRADLE_DIR, 'com.test.gradle', 'allowed-gradle', '1.0.0', 'com.test.gradle.Allowed');

    // 2. Ignored Artifact
    createGradleArtifact(TEST_GRADLE_DIR, 'org.ignored', 'ignored-gradle', '1.0.0', 'org.ignored.Ignored');
}

function createArtifact(repoRoot: string, groupId: string, artifactId: string, version: string, className: string) {
    const groupPath = groupId.replace(/\./g, '/');
    const artifactDir = path.join(repoRoot, groupPath, artifactId, version);

    fs.mkdirSync(artifactDir, {recursive: true});

    const srcDir = path.join(repoRoot, 'src_tmp', artifactId);
    const packagePath = className.substring(0, className.lastIndexOf('.')).replace(/\./g, '/');
    const simpleName = className.substring(className.lastIndexOf('.') + 1);

    fs.mkdirSync(path.join(srcDir, packagePath), {recursive: true});
    fs.writeFileSync(path.join(srcDir, packagePath, `${simpleName}.java`), `
package ${className.substring(0, className.lastIndexOf('.'))};
public class ${simpleName} {}
    `);

    execSync(`javac ${path.join(srcDir, packagePath, `${simpleName}.java`)}`);

    const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
    execSync(`jar -cf ${jarPath} -C ${srcDir} .`);

    fs.writeFileSync(path.join(artifactDir, `${artifactId}-${version}.pom`), `<project></project>`);

    fs.rmSync(srcDir, {recursive: true, force: true});
}

function createGradleArtifact(repoRoot: string, groupId: string, artifactId: string, version: string, className: string) {
    // Gradle cache: group/artifact/version/hash/file
    const hash = 'abc12345';
    const artifactDir = path.join(repoRoot, groupId, artifactId, version, hash);
    fs.mkdirSync(artifactDir, {recursive: true});

    const srcDir = path.join(repoRoot, 'src_tmp', artifactId);
    const packagePath = className.substring(0, className.lastIndexOf('.')).replace(/\./g, '/');
    const simpleName = className.substring(className.lastIndexOf('.') + 1);

    fs.mkdirSync(path.join(srcDir, packagePath), {recursive: true});
    fs.writeFileSync(path.join(srcDir, packagePath, `${simpleName}.java`), `
package ${className.substring(0, className.lastIndexOf('.'))};
public class ${simpleName} {}
    `);

    execSync(`javac ${path.join(srcDir, packagePath, `${simpleName}.java`)}`);

    const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
    execSync(`jar -cf ${jarPath} -C ${srcDir} .`);

    fs.rmSync(srcDir, {recursive: true, force: true});
}

describe('Maven Indexer Filtering', () => {
    beforeAll(async () => {
        // Setup Env
        process.env.DB_FILE = DB_FILE;
        process.env.INCLUDED_PACKAGES = "com.test.*"; // Only allow com.test

        // Reset Config to pick up new env
        Config.reset();

        // Cleanup old
        if (fs.existsSync(TEST_REPO_DIR)) fs.rmSync(TEST_REPO_DIR, {recursive: true, force: true});
        if (fs.existsSync(TEST_GRADLE_DIR)) fs.rmSync(TEST_GRADLE_DIR, {recursive: true, force: true});
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

        // Setup Repo
        createMavenArtifacts();
        createGradleArtifacts();

        // Setup Config
        const config = await Config.getInstance();
        config.localRepository = TEST_REPO_DIR;
        config.gradleRepository = TEST_GRADLE_DIR;
    });

    afterAll(() => {
        // Cleanup
        if (fs.existsSync(TEST_REPO_DIR)) fs.rmSync(TEST_REPO_DIR, {recursive: true, force: true});
        if (fs.existsSync(TEST_GRADLE_DIR)) fs.rmSync(TEST_GRADLE_DIR, {recursive: true, force: true});
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

        // Reset env
        delete process.env.INCLUDED_PACKAGES;
        Config.reset();
    });

    it('should only index artifacts matching included packages', async () => {
        const indexer = Indexer.getInstance();
        await indexer.index();

        // Check Maven Artifacts
        const allowedLib = indexer.search('allowed-lib');
        expect(allowedLib.length).toBe(1);

        const ignoredLib = indexer.search('ignored-lib');
        expect(ignoredLib.length).toBe(0); // Should not find it because folder wasn't scanned

        // Check Gradle Artifacts
        const allowedGradle = indexer.search('allowed-gradle');
        expect(allowedGradle.length).toBe(1);

        const ignoredGradle = indexer.search('ignored-gradle');
        expect(ignoredGradle.length).toBe(0); // Should not find it because group dir was skipped
    });

    it('should only index classes matching included packages', async () => {
        const indexer = Indexer.getInstance();

        const allowed = indexer.searchClass('Allowed');
        expect(allowed.length).toBeGreaterThan(0);

        const ignored = indexer.searchClass('Ignored');
        expect(ignored.length).toBe(0);
    });

    it('should normalize patterns correctly', async () => {
        // Test internal normalization via private method (using any cast to access)
        const config = await Config.getInstance();
        const normalize = (config as any).normalizeScanPatterns.bind(config);

        expect(normalize(['com.test.*', 'com.test.demo', 'com.other'])).toEqual(['com.other', 'com.test']);
        expect(normalize(['com.a', 'com.a.b'])).toEqual(['com.a']);
        expect(normalize(['*'])).toEqual([]);
        expect(normalize([])).toEqual([]);
        expect(normalize(['com.test.*', 'com.test'])).toEqual(['com.test']);
    });

    it('should ignore empty/blank patterns in normalization', async () => {
        const config = await Config.getInstance();
        const normalize = (config as any).normalizeScanPatterns.bind(config);

        expect(normalize(['com.test', ''])).toEqual(['com.test']);
        expect(normalize(['com.test', '   '])).toEqual(['com.test']);
        expect(normalize(['', '  '])).toEqual([]); // All empty -> return [] (scan all)
        expect(normalize(['com.a', 'com.b', ''])).toEqual(['com.a', 'com.b']);
    });

    it('should handle isPackageIncluded correctly with normalized patterns', () => {
        const indexer = Indexer.getInstance();
        const isIncluded = (indexer as any).isPackageIncluded.bind(indexer);

        // Normal patterns
        expect(isIncluded('com.test.Foo', ['com.test'])).toBe(true);
        expect(isIncluded('com.other.Foo', ['com.test'])).toBe(false);

        // Empty normalized patterns -> include all
        expect(isIncluded('com.any.Foo', [])).toBe(true);
    });
});
