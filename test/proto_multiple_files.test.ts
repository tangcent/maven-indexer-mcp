
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer.js';
import { Config } from '../src/config.js';

const TEST_DIR = path.resolve(__dirname, '../test_temp_proto_multi');
const REPO_DIR = path.join(TEST_DIR, 'repo');
const DB_FILE = path.join(TEST_DIR, 'test.sqlite');

describe('Proto Multiple Files Integration Test', () => {
    beforeAll(async () => {
        // Cleanup
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(REPO_DIR, { recursive: true });

        // Setup Environment
        process.env.DB_FILE = DB_FILE;
        process.env.MAVEN_REPO_PATH = REPO_DIR;
        process.env.GRADLE_REPO_PATH = path.join(TEST_DIR, 'gradle_dummy'); 

        // Create Proto File with java_multiple_files = true
        const protoContent = `
syntax = "proto3";
package com.example;

option java_package = "com.example.multi";
option java_multiple_files = true;
option java_outer_classname = "MultiProto";

message MultiMessage {
  string id = 1;
}

enum MultiEnum {
  VAL1 = 0;
}
`;
        const protoFile = path.join(TEST_DIR, 'multi.proto');
        fs.writeFileSync(protoFile, protoContent);

        // Create Artifact Structure
        const artifactDir = path.join(REPO_DIR, 'com', 'example', 'multi-proto', '1.0.0');
        fs.mkdirSync(artifactDir, { recursive: true });

        // Create JAR
        const jarPath = path.join(artifactDir, 'multi-proto-1.0.0.jar');
        execSync(`zip ${jarPath} multi.proto`, { cwd: TEST_DIR });

        // Create POM
        const pomPath = path.join(artifactDir, 'multi-proto-1.0.0.pom');
        fs.writeFileSync(pomPath, '<project><groupId>com.example</groupId><artifactId>multi-proto</artifactId><version>1.0.0</version></project>');

        // Initialize Config
        Config.reset();
        await Config.getInstance();
    });

    afterAll(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    it('should index multiple generated classes from one proto file', async () => {
        const indexer = Indexer.getInstance();
        await indexer.refresh();

        // Check if MultiMessage is indexed
        const messageClasses = indexer.searchClass('MultiMessage');
        expect(messageClasses.length).toBeGreaterThan(0);
        expect(messageClasses[0].className).toBe('com.example.multi.MultiMessage');

        // Check if MultiEnum is indexed
        const enumClasses = indexer.searchClass('MultiEnum');
        expect(enumClasses.length).toBeGreaterThan(0);
        expect(enumClasses[0].className).toBe('com.example.multi.MultiEnum');

        // Check if MultiProto (outer class) is indexed
        const outerClasses = indexer.searchClass('MultiProto');
        expect(outerClasses.length).toBeGreaterThan(0);
        expect(outerClasses[0].className).toBe('com.example.multi.MultiProto');
        
        // Verify content retrieval works for all
        const resources = indexer.getResourcesForClass('com.example.multi.MultiMessage');
        expect(resources.length).toBeGreaterThan(0);
        expect(resources[0].content).toContain('message MultiMessage');
    });
});
