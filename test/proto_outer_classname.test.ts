import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer.js';
import { Config } from '../src/config.js';
import { ProtoParser } from '../src/proto_parser.js';

const TEST_DIR = path.resolve(__dirname, '../test_temp_proto_outer');
const REPO_DIR = path.join(TEST_DIR, 'repo');
const DB_FILE = path.join(TEST_DIR, 'test.sqlite');

const PROTO_CONTENT = `
syntax = "proto3";
package com.tangcent;

option java_package = "com.tangcent.xxx";
option java_outer_classname = "BaseProto";

message BaseEventData {
  string event_id = 1;
  string event_type = 2;
  int64 timestamp = 3;

  message NestedDetail {
    string detail_id = 1;
  }
}

enum EventStatus {
  UNKNOWN = 0;
  ACTIVE = 1;
  INACTIVE = 2;
}

service EventService {
  rpc GetEvent(BaseEventData) returns (BaseEventData);
}
`;

describe('Proto java_outer_classname (no multiple_files) Integration Test', () => {
    beforeAll(async () => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(REPO_DIR, { recursive: true });

        process.env.DB_FILE = DB_FILE;
        process.env.MAVEN_REPO_PATH = REPO_DIR;
        process.env.GRADLE_REPO_PATH = path.join(TEST_DIR, 'gradle_dummy');

        const protoFile = path.join(TEST_DIR, 'base_event.proto');
        fs.writeFileSync(protoFile, PROTO_CONTENT);

        // Artifact 1: event-sdk 1.0.0 — has the proto
        const artifactDir = path.join(REPO_DIR, 'com', 'tangcent', 'event-sdk', '1.0.0');
        fs.mkdirSync(artifactDir, { recursive: true });
        const jarPath = path.join(artifactDir, 'event-sdk-1.0.0.jar');
        execSync(`zip ${jarPath} base_event.proto`, { cwd: TEST_DIR });
        fs.writeFileSync(
            path.join(artifactDir, 'event-sdk-1.0.0.pom'),
            '<project><groupId>com.tangcent</groupId><artifactId>event-sdk</artifactId><version>1.0.0</version></project>'
        );

        // Artifact 2: event-sdk 2.0.0 — same proto content (duplicate version)
        const artifactDir2 = path.join(REPO_DIR, 'com', 'tangcent', 'event-sdk', '2.0.0');
        fs.mkdirSync(artifactDir2, { recursive: true });
        const jarPath2 = path.join(artifactDir2, 'event-sdk-2.0.0.jar');
        execSync(`zip ${jarPath2} base_event.proto`, { cwd: TEST_DIR });
        fs.writeFileSync(
            path.join(artifactDir2, 'event-sdk-2.0.0.pom'),
            '<project><groupId>com.tangcent</groupId><artifactId>event-sdk</artifactId><version>2.0.0</version></project>'
        );

        // Artifact 3: event-consumer — has compiled .class files but NO proto
        // (simulates the cross-artifact scenario: class in one jar, proto in another)
        const consumerDir = path.join(REPO_DIR, 'com', 'tangcent', 'event-consumer', '1.0.0');
        fs.mkdirSync(consumerDir, { recursive: true });
        // Empty jar (no proto, no classes — just simulates a jar without proto)
        execSync(`zip ${path.join(consumerDir, 'event-consumer-1.0.0.jar')} base_event.proto`, { cwd: TEST_DIR });
        fs.writeFileSync(
            path.join(consumerDir, 'event-consumer-1.0.0.pom'),
            '<project><groupId>com.tangcent</groupId><artifactId>event-consumer</artifactId><version>1.0.0</version></project>'
        );

        Config.reset();
        await Config.getInstance();
    });

    afterAll(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });

    it('should parse proto with java_outer_classname correctly', () => {
        const info = ProtoParser.parse(PROTO_CONTENT);

        expect(info.package).toBe('com.tangcent');
        expect(info.javaPackage).toBe('com.tangcent.xxx');
        expect(info.javaOuterClassname).toBe('BaseProto');
        expect(info.javaMultipleFiles).toBeUndefined();

        // Should only have top-level definitions (not NestedDetail)
        expect(info.definitions).toContain('BaseEventData');
        expect(info.definitions).toContain('EventStatus');
        expect(info.definitions).toContain('EventService');
        expect(info.definitions).not.toContain('NestedDetail');
        expect(info.definitions.length).toBe(3);
    });

    it('should index outer class and nested definitions when java_multiple_files is not set', async () => {
        const indexer = Indexer.getInstance();
        await indexer.refresh();

        // The outer class itself should be indexed
        const outerClasses = indexer.searchClass('BaseProto');
        expect(outerClasses.length).toBeGreaterThan(0);
        expect(outerClasses[0].className).toBe('com.tangcent.xxx.BaseProto');

        // Without java_multiple_files, definitions are nested under outer class
        const nestedMessage = indexer.searchClass('BaseEventData');
        expect(nestedMessage.length).toBeGreaterThan(0);
        expect(nestedMessage[0].className).toBe('com.tangcent.xxx.BaseProto.BaseEventData');

        const nestedEnum = indexer.searchClass('EventStatus');
        expect(nestedEnum.length).toBeGreaterThan(0);
        expect(nestedEnum[0].className).toBe('com.tangcent.xxx.BaseProto.EventStatus');

        const nestedService = indexer.searchClass('EventService');
        expect(nestedService.length).toBeGreaterThan(0);
        expect(nestedService[0].className).toBe('com.tangcent.xxx.BaseProto.EventService');
    });

    it('should retrieve proto content via nested class name', async () => {
        const indexer = Indexer.getInstance();

        const resources = indexer.getResourcesForClass('com.tangcent.xxx.BaseProto.BaseEventData');
        expect(resources.length).toBeGreaterThan(0);
        expect(resources[0].content).toContain('message BaseEventData');
        expect(resources[0].type).toBe('proto');

        // Also should work via the outer class
        const outerResources = indexer.getResourcesForClass('com.tangcent.xxx.BaseProto');
        expect(outerResources.length).toBeGreaterThan(0);
        expect(outerResources[0].content).toContain('option java_outer_classname');
    });

    it('should deduplicate resources with identical content across artifact versions', async () => {
        const indexer = Indexer.getInstance();

        // Both event-sdk 1.0.0 and 2.0.0 have the same proto — should be deduplicated
        const resources = indexer.getResourcesForClass('com.tangcent.xxx.BaseProto');
        expect(resources.length).toBe(1);
        expect(resources[0].content).toContain('option java_outer_classname = "BaseProto"');
    });

    it('should retrieve proto via getResourcesForClassInArtifact scoped to artifact', async () => {
        const indexer = Indexer.getInstance();

        // Find the artifact id for event-sdk 1.0.0
        const artifact = indexer.getArtifactByCoordinate('com.tangcent', 'event-sdk', '1.0.0');
        expect(artifact).toBeDefined();

        // Should find resources scoped to that artifact
        const resources = indexer.getResourcesForClassInArtifact('com.tangcent.xxx.BaseProto', artifact!.id);
        expect(resources.length).toBeGreaterThan(0);
        expect(resources[0].content).toContain('message BaseEventData');

        // Should NOT find resources for a class not in this artifact
        const noResources = indexer.getResourcesForClassInArtifact('com.other.SomeClass', artifact!.id);
        expect(noResources.length).toBe(0);
    });

    it('should return empty for getResourcesForClassInArtifact with wrong artifact id', async () => {
        const indexer = Indexer.getInstance();

        // Use a non-existent artifact id
        const resources = indexer.getResourcesForClassInArtifact('com.tangcent.xxx.BaseProto', -1);
        expect(resources.length).toBe(0);
    });
});
