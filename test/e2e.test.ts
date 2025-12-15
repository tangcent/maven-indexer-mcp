import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const TEST_REPO_DIR = path.resolve('test-repo-e2e');
const DB_FILE = 'maven-index-e2e.sqlite';

function createTestArtifact() {
    const groupId = 'com.example';
    const artifactId = 'e2e-demo';
    const version = '1.0.0';
    const groupPath = groupId.replace(/\./g, '/');
    const artifactDir = path.join(TEST_REPO_DIR, groupPath, artifactId, version);

    fs.mkdirSync(artifactDir, { recursive: true });

    // Create Source
    const srcDir = path.join(TEST_REPO_DIR, 'src_tmp');
    fs.mkdirSync(path.join(srcDir, 'com/example/demo'), { recursive: true });
    
    const javaContent = `
package com.example.demo;
/**
 * E2E Test class.
 */
public class E2EUtils {
    /**
     * Says hello.
     */
    public String hello(String name) {
        return "Hello " + name;
    }
}
    `;
    fs.writeFileSync(path.join(srcDir, 'com/example/demo/E2EUtils.java'), javaContent);

    // Compile
    try {
        execSync(`javac ${path.join(srcDir, 'com/example/demo/E2EUtils.java')}`);
    } catch (e) {
        console.error("Javac failed. Ensure JDK is installed.");
        throw e;
    }

    // Jar Main
    const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
    execSync(`jar -cf ${jarPath} -C ${srcDir} .`);

    // Jar Sources
    const sourceJarPath = path.join(artifactDir, `${artifactId}-${version}-sources.jar`);
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

describe('MCP Server E2E', () => {
    let server: ChildProcess;
    let requestId = 1;

    beforeAll(() => {
        // Cleanup old
        if (fs.existsSync(TEST_REPO_DIR)) fs.rmSync(TEST_REPO_DIR, { recursive: true, force: true });
        if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

        // Setup Repo
        createTestArtifact();
    });

    afterAll(() => {
        if (server) server.kill();
        // Cleanup
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
                        // Ignore non-JSON lines
                    }
                }
            };

            server.stdout?.on('data', onData);
            server.stdin?.write(JSON.stringify(request) + '\n');
        });
    }

    it('should start and respond to requests', async () => {
        // Build first to ensure we test the built artifact
        execSync('npm run build');

        server = spawn('node', ['build/index.js'], {
            stdio: ['pipe', 'pipe', 'inherit'],
            env: { 
                ...process.env, 
                MAVEN_REPO_PATH: TEST_REPO_DIR,
                GRADLE_REPO_PATH: "/non-existent/path/to/disable/gradle",
                DB_FILE: DB_FILE
            }
        });

        // Wait for server to be ready (naive wait)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Test 1: Search Classes
        const searchResult = await sendRequest("tools/call", {
            name: "search_classes",
            arguments: { className: "E2EUtils" }
        });

        expect(searchResult.content[0].text).toContain("com.example.demo.E2EUtils");
        
        // Extract Coordinate
        // Output: Class: com.example.demo.E2EUtils\n    com.example:e2e-demo:1.0.0 (Has Source)
        const match = searchResult.content[0].text.match(/([a-zA-Z0-9.-]+:[a-zA-Z0-9.-]+:[a-zA-Z0-9.-]+)/);
        expect(match).not.toBeNull();
        const coordinate = match[1];

        // Test 2: Get Class Details
        const detailsResult = await sendRequest("tools/call", {
            name: "get_class_details",
            arguments: { 
                className: "com.example.demo.E2EUtils",
                coordinate: coordinate,
                type: "source"
            }
        });

        expect(detailsResult.content[0].text).toContain("public String hello(String name)");
    }, 30000); // 30s timeout
});
