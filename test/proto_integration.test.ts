
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer.js';
import { Config } from '../src/config.js';
import { DB } from '../src/db/index.js';

const TEST_DIR = path.resolve(__dirname, '../test_temp_proto');
const REPO_DIR = path.join(TEST_DIR, 'repo');
const DB_FILE = path.join(TEST_DIR, 'test.sqlite');

describe('Proto Integration Test', () => {
    beforeAll(async () => {
        // Cleanup
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(REPO_DIR, { recursive: true });

        // Setup Environment
        process.env.DB_FILE = DB_FILE;
        process.env.MAVEN_REPO_PATH = REPO_DIR;
        process.env.GRADLE_REPO_PATH = path.join(TEST_DIR, 'gradle_dummy'); // Disable gradle scan

        // Create Proto File
        const protoContent = `
syntax = "proto3";
package com.example;

option java_package = "com.example.gen";
option java_outer_classname = "TestProto";

message TestMessage {
  string id = 1;
}
`;
        const protoFile = path.join(TEST_DIR, 'test.proto');
        fs.writeFileSync(protoFile, protoContent);

        // Create Artifact Structure
        const artifactDir = path.join(REPO_DIR, 'com', 'example', 'my-proto', '1.0.0');
        fs.mkdirSync(artifactDir, { recursive: true });

        // Create JAR with proto file
        const jarPath = path.join(artifactDir, 'my-proto-1.0.0.jar');
        // cd to TEST_DIR to zip relative path 'test.proto'
        execSync(`zip ${jarPath} test.proto`, { cwd: TEST_DIR });

        // Create POM
        const pomPath = path.join(artifactDir, 'my-proto-1.0.0.pom');
        fs.writeFileSync(pomPath, '<project><groupId>com.example</groupId><artifactId>my-proto</artifactId><version>1.0.0</version></project>');

        // Initialize Config (reset first just in case)
        Config.reset();
        await Config.getInstance();
    });

    afterAll(() => {
        // Cleanup
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    it('should index proto files and allow searching resources', async () => {
        const indexer = Indexer.getInstance();
        
        // Force refresh to ensure we use the new DB
        await indexer.refresh();

        // Search for the resource
        const resources = indexer.searchResources('test.proto');
        expect(resources.length).toBeGreaterThan(0);
        expect(resources[0].path).toBe('test.proto');
        expect(resources[0].artifact.artifactId).toBe('my-proto');

        // Get resources via generated class name
        const classResources = indexer.getResourcesForClass('com.example.gen.TestProto');
        expect(classResources.length).toBeGreaterThan(0);
        expect(classResources[0].content).toContain('message TestMessage');
        expect(classResources[0].type).toBe('proto');
        
        // Verify class search also finds it (optional, but good)
        const classes = indexer.searchClass('TestProto');
        expect(classes.length).toBeGreaterThan(0);
        expect(classes[0].className).toBe('com.example.gen.TestProto');
    });
});
