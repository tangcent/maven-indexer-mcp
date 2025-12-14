import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer';
import { Config } from '../src/config';
import Database from 'better-sqlite3';

const TEST_REPO_DIR = path.resolve('test-repo-integration');
const DB_FILE = 'maven-index.sqlite';

function createTestArtifact() {
    const groupId = 'com.test';
    const artifactId = 'demo';
    const version = '1.0.0';
    const groupPath = groupId.replace(/\./g, '/');
    const artifactDir = path.join(TEST_REPO_DIR, groupPath, artifactId, version);

    fs.mkdirSync(artifactDir, { recursive: true });

    // Create Source
    const srcDir = path.join(TEST_REPO_DIR, 'src_tmp');
    fs.mkdirSync(path.join(srcDir, 'com/test/demo'), { recursive: true });
    
    const javaContent = `
package com.test.demo;
/**
 * Test class.
 */
public class TestUtils {
    /**
     * Echoes the string.
     */
    public String echo(String input) {
        return input;
    }
}
    `;
    fs.writeFileSync(path.join(srcDir, 'com/test/demo/TestUtils.java'), javaContent);

    // Compile
    try {
        execSync(`javac ${path.join(srcDir, 'com/test/demo/TestUtils.java')}`);
    } catch (e) {
        console.error("Javac failed. Ensure JDK is installed.");
        throw e;
    }

    // Jar Main
    // We use zip because 'jar' command might vary, but zip is usually available. 
    // Actually, let's use 'jar' if available or 'zip'.
    // Assuming 'jar' is available since we have javac.
    const classFiles = path.join(srcDir, 'com/test/demo/TestUtils.class');
    const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
    // -c create, -f file, -C change dir
    execSync(`jar -cf ${jarPath} -C ${srcDir} .`);

    // Jar Sources
    const sourceJarPath = path.join(artifactDir, `${artifactId}-${version}-sources.jar`);
    const javaFiles = path.join(srcDir, 'com/test/demo/TestUtils.java');
    execSync(`jar -cf ${sourceJarPath} -C ${srcDir} .`);

    // POM
    const pomContent = `
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>${groupId}</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>${version}</version>
</project>
    `;
    fs.writeFileSync(path.join(artifactDir, `${artifactId}-${version}.pom`), pomContent);

    // Cleanup src
    fs.rmSync(srcDir, { recursive: true, force: true });
}

describe('Maven Indexer Integration', () => {
    beforeAll(async () => {
        // Cleanup old
        if (fs.existsSync(TEST_REPO_DIR)) fs.rmSync(TEST_REPO_DIR, { recursive: true, force: true });
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

        // Setup Repo
        createTestArtifact();

        // Setup Config
        const config = await Config.getInstance();
        config.localRepository = TEST_REPO_DIR;
        // config.javaBinary should be detected or default
    });

    afterAll(() => {
        // Cleanup
        if (fs.existsSync(TEST_REPO_DIR)) fs.rmSync(TEST_REPO_DIR, { recursive: true, force: true });
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    });

    it('should index the repository', async () => {
        const indexer = Indexer.getInstance();
        await indexer.index();

        // Check DB
        const db = new Database(DB_FILE);
        const count = db.prepare('SELECT count(*) as c FROM artifacts').get() as {c: number};
        expect(count.c).toBe(1);
        db.close();
    });

    it('should find the class by name', async () => {
        const indexer = Indexer.getInstance();
        const results = indexer.searchClass('TestUtils');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].className).toContain('TestUtils');
    });

    it('should find the class by fully qualified name', async () => {
        const indexer = Indexer.getInstance();
        const results = indexer.searchClass('com.test.demo.TestUtils');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].className).toBe('com.test.demo.TestUtils');
    });

    it('should find the class by purpose (semantic-ish)', async () => {
        const indexer = Indexer.getInstance();
        // Since we index class names, searching "Test" or "Utils" should work
        const results = indexer.searchClass('Utils');
        expect(results.length).toBeGreaterThan(0);
    });

    // Note: get_class_details is logic inside index.ts (the MCP server handler), 
    // but the underlying logic uses SourceParser. Let's test SourceParser directly.
    it('should parse source details', async () => {
        const { SourceParser } = await import('../src/source_parser');
        
        // We need the absolute path to the jar
        const artifactDir = path.join(TEST_REPO_DIR, 'com/test/demo/1.0.0');
        const sourceJar = path.join(artifactDir, 'demo-1.0.0-sources.jar');
        const mainJar = path.join(artifactDir, 'demo-1.0.0.jar');

        // Test Signatures (using javap on main jar)
        const sigs = await SourceParser.getClassDetail(mainJar, 'com.test.demo.TestUtils', 'signatures');
        expect(sigs).not.toBeNull();
        expect(sigs?.signatures?.some(s => s.includes('echo'))).toBe(true);

        // Test Docs (using source jar)
        const docs = await SourceParser.getClassDetail(sourceJar, 'com.test.demo.TestUtils', 'docs');
        expect(docs).not.toBeNull();
        expect(docs?.doc).toContain('Echoes the string');
    });
});
