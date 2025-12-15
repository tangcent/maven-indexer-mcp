import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer';
import { Config } from '../src/config';

const TEST_GRADLE_REPO = path.resolve('test-repo-gradle');
const DB_FILE = 'maven-index-gradle.sqlite';

function createGradleArtifact() {
    const groupId = 'com.gradle.test';
    const artifactId = 'demo-lib';
    const version = '2.0.0';
    // Gradle structure: group.id/artifactId/version/hash/file
    // Note: group id is NOT converted to path with slashes in gradle cache modules-2/files-2.1
    const artifactBaseDir = path.join(TEST_GRADLE_REPO, groupId, artifactId, version);
    
    // Create random hash dirs
    const jarHash = 'a1b2c3d4';
    const pomHash = 'e5f6g7h8';
    
    const jarDir = path.join(artifactBaseDir, jarHash);
    const pomDir = path.join(artifactBaseDir, pomHash);
    
    fs.mkdirSync(jarDir, { recursive: true });
    fs.mkdirSync(pomDir, { recursive: true });

    // Create Source
    const srcDir = path.join(TEST_GRADLE_REPO, 'src_tmp');
    fs.mkdirSync(path.join(srcDir, 'com/gradle/test'), { recursive: true });
    
    const javaContent = `
package com.gradle.test;
public class GradleUtils {
    public void hello() {}
}
    `;
    fs.writeFileSync(path.join(srcDir, 'com/gradle/test/GradleUtils.java'), javaContent);

    // Compile
    try {
        execSync(`javac ${path.join(srcDir, 'com/gradle/test/GradleUtils.java')}`);
    } catch (e) {
        console.error("Javac failed. Ensure JDK is installed.");
        throw e;
    }

    // Jar
    const jarPath = path.join(jarDir, `${artifactId}-${version}.jar`);
    execSync(`jar -cf ${jarPath} -C ${srcDir} .`);

    // POM
    const pomContent = `<project><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version></project>`;
    fs.writeFileSync(path.join(pomDir, `${artifactId}-${version}.pom`), pomContent);

    // Cleanup src
    fs.rmSync(srcDir, { recursive: true, force: true });
}

describe('Gradle Indexer Integration', () => {
    beforeAll(async () => {
        if (fs.existsSync(TEST_GRADLE_REPO)) fs.rmSync(TEST_GRADLE_REPO, { recursive: true, force: true });
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

        process.env.DB_FILE = DB_FILE;
        createGradleArtifact();

        Config.reset();
        const config = await Config.getInstance();
        config.localRepository = ""; // Disable maven repo
        config.gradleRepository = TEST_GRADLE_REPO;
    });

    afterAll(() => {
        if (fs.existsSync(TEST_GRADLE_REPO)) fs.rmSync(TEST_GRADLE_REPO, { recursive: true, force: true });
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
        delete process.env.DB_FILE;
    });

    it('should index the gradle repository', async () => {
        const indexer = Indexer.getInstance();
        await indexer.index();

        const results = indexer.search('demo-lib');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].groupId).toBe('com.gradle.test');
        expect(results[0].artifactId).toBe('demo-lib');
        
        // Check if class is indexed
        const classes = indexer.searchClass('GradleUtils');
        expect(classes.length).toBeGreaterThan(0);
        expect(classes[0].className).toContain('GradleUtils');
    });
});
