import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const TEST_REPO_DIR = path.resolve('test-repo-batch');
const DB_FILE = 'maven-index-batch.sqlite';

function createTestArtifact(artifactId: string, className: string) {
    const groupId = 'com.example';
    const version = '1.0.0';
    const groupPath = groupId.replace(/\./g, '/');
    const artifactDir = path.join(TEST_REPO_DIR, groupPath, artifactId, version);

    fs.mkdirSync(artifactDir, { recursive: true });

    // Create Source
    const srcDir = path.join(TEST_REPO_DIR, 'src_tmp_' + artifactId);
    fs.mkdirSync(path.join(srcDir, 'com/example/demo'), { recursive: true });
    
    const javaContent = `
package com.example.demo;
public class ${className} {
    public String hello() { return "Hello"; }
}
    `;
    fs.writeFileSync(path.join(srcDir, `com/example/demo/${className}.java`), javaContent);

    // Compile
    try {
        execSync(`javac ${path.join(srcDir, `com/example/demo/${className}.java`)}`);
    } catch (e) {
        console.error("Javac failed. Ensure JDK is installed.");
        throw e;
    }

    // Jar Main
    const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
    execSync(`jar -cf ${jarPath} -C ${srcDir} .`);

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

describe('MCP Server Batch Queries', () => {
    let server: ChildProcess;
    let requestId = 1;

    beforeAll(() => {
        if (fs.existsSync(TEST_REPO_DIR)) fs.rmSync(TEST_REPO_DIR, { recursive: true, force: true });
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

        createTestArtifact('batch-lib-1', 'BatchClass1');
        createTestArtifact('batch-lib-2', 'BatchClass2');
    });

    afterAll(() => {
        if (server) server.kill();
        if (fs.existsSync(TEST_REPO_DIR)) fs.rmSync(TEST_REPO_DIR, { recursive: true, force: true });
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    });

    function sendRequest(method: string, params: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = requestId++;
            const request = {
                jsonrpc: "2.0",
                id: id,
                method: method,
                params: params
            };

            const onData = (data: Buffer) => {
                const str = data.toString();
                const lines = str.split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const response = JSON.parse(line);
                        if (response.id === id) {
                            server.stdout?.off('data', onData);
                            if (response.error) {
                                reject(response.error);
                            } else {
                                resolve(response.result);
                            }
                        }
                    } catch (e) {
                    }
                }
            };

            server.stdout?.on('data', onData);
            server.stdin?.write(JSON.stringify(request) + '\n');
        });
    }

    it('should support batch queries', async () => {
        execSync('npm run build');

        server = spawn('node', ['build/index.js'], {
            stdio: ['pipe', 'pipe', 'inherit'],
            env: { 
                ...process.env, 
                MAVEN_REPO_PATH: TEST_REPO_DIR,
                GRADLE_REPO_PATH: "/non-existent",
                DB_FILE: DB_FILE
            }
        });

        // Wait for server to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Batch search_artifacts
        const searchRes = await sendRequest("tools/call", {
            name: "search_artifacts",
            arguments: { queries: ["batch-lib-1", "batch-lib-2"] }
        });
        expect(searchRes.content[0].text).toContain("Results for \"batch-lib-1\"");
        expect(searchRes.content[0].text).toContain("Results for \"batch-lib-2\"");

        // Batch search_classes
        const classesRes = await sendRequest("tools/call", {
            name: "search_classes",
            arguments: { classNames: ["BatchClass1", "BatchClass2"] }
        });
        expect(classesRes.content[0].text).toContain("Results for \"BatchClass1\"");
        expect(classesRes.content[0].text).toContain("Results for \"BatchClass2\"");
        
        // Batch get_class_details
        const detailsRes = await sendRequest("tools/call", {
            name: "get_class_details",
            arguments: { 
                classNames: ["com.example.demo.BatchClass1", "com.example.demo.BatchClass2"],
                type: "signatures"
            }
        });
        expect(detailsRes.content[0].text).toContain("Class: com.example.demo.BatchClass1");
        expect(detailsRes.content[0].text).toContain("Class: com.example.demo.BatchClass2");
    }, 30000);
});
