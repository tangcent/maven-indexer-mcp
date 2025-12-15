import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer';
import { Config } from '../src/config';
import Database from 'better-sqlite3';

const TEST_REPO_DIR = path.resolve('test-repo-filtering');
const DB_FILE = 'maven-index-filtering.sqlite';

function createTestArtifact() {
    const groupId = 'com.test';
    const artifactId = 'demo';
    const version = '1.0.0';
    const groupPath = groupId.replace(/\./g, '/');
    const artifactDir = path.join(TEST_REPO_DIR, groupPath, artifactId, version);

    fs.mkdirSync(artifactDir, { recursive: true });

    const srcDir = path.join(TEST_REPO_DIR, 'src_tmp');
    
    // Class 1: com.test.demo.Allowed
    fs.mkdirSync(path.join(srcDir, 'com/test/demo'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'com/test/demo/Allowed.java'), `
package com.test.demo;
public class Allowed {}
    `);

    // Class 2: com.other.Ignored
    fs.mkdirSync(path.join(srcDir, 'com/other'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'com/other/Ignored.java'), `
package com.other;
public class Ignored {}
    `);

    // Compile
    execSync(`javac ${path.join(srcDir, 'com/test/demo/Allowed.java')} ${path.join(srcDir, 'com/other/Ignored.java')}`);

    // Jar
    const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
    execSync(`jar -cf ${jarPath} -C ${srcDir} .`);

    // POM
    fs.writeFileSync(path.join(artifactDir, `${artifactId}-${version}.pom`), `<project></project>`);

    // Cleanup src
    fs.rmSync(srcDir, { recursive: true, force: true });
}

describe('Maven Indexer Filtering', () => {
    beforeAll(async () => {
        // Setup Env
        process.env.DB_FILE = DB_FILE;
        process.env.INCLUDED_PACKAGES = "com.test.*"; // Only allow com.test
        
        // Reset Config to pick up new env
        Config.reset();

        // Cleanup old
        if (fs.existsSync(TEST_REPO_DIR)) fs.rmSync(TEST_REPO_DIR, { recursive: true, force: true });
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

        // Setup Repo
        createTestArtifact();

        // Setup Config
        const config = await Config.getInstance();
        config.localRepository = TEST_REPO_DIR;
        config.gradleRepository = "";
    });

    afterAll(() => {
        // Cleanup
        if (fs.existsSync(TEST_REPO_DIR)) fs.rmSync(TEST_REPO_DIR, { recursive: true, force: true });
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
        
        // Reset env
        delete process.env.INCLUDED_PACKAGES;
        Config.reset();
    });

    it('should only index allowed classes', async () => {
        const indexer = Indexer.getInstance();
        await indexer.index();

        const allowed = indexer.searchClass('Allowed');
        expect(allowed.length).toBeGreaterThan(0);
        expect(allowed[0].className).toBe('com.test.demo.Allowed');

        const ignored = indexer.searchClass('Ignored');
        expect(ignored.length).toBe(0);
    });
});
