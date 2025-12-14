import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import path from 'path';

const server = spawn('node', ['build/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, MAVEN_REPO_PATH: path.resolve('test-repo') }
});

let outputBuffer = "";

server.stdout.on('data', (data) => {
  const str = data.toString();
  outputBuffer += str;
  console.log(`STDOUT: ${str}`);
});

function sendRequest(method, params, id) {
    const request = {
      jsonrpc: "2.0",
      id: id,
      method: method,
      params: params
    };
    server.stdin.write(JSON.stringify(request) + '\n');
}

// 1. Wait for indexing (partially)
setTimeout(() => {
    console.log("--- Test 1: Search by partial name (String) ---");
    sendRequest("tools/call", {
        name: "search_classes",
        arguments: { className: "String" }
    }, 1);
}, 5000);

// 2. Search by purpose/keyword
setTimeout(() => {
    console.log("--- Test 2: Search by purpose (JsonToXml) ---");
    // Assuming some json library exists
    sendRequest("tools/call", {
        name: "search_classes",
        arguments: { className: "Json" }
    }, 2);
}, 7000);

// 3. Get details
setTimeout(() => {
    console.log("--- Test 3: Get Details (Signatures) ---");
    // We need an ID from previous result, but for this test we'll try to find one manually via DB first to be deterministic
    const db = new Database('maven-index.sqlite');
    try {
        const row = db.prepare(`
            SELECT a.id, c.class_name 
            FROM classes_fts c 
            JOIN artifacts a ON c.artifact_id = a.id 
            WHERE a.has_source = 1 
            LIMIT 1
        `).get();
        
        if (row) {
            console.log(`Testing details for ${row.class_name} in artifact ${row.id}`);
            sendRequest("tools/call", {
                name: "get_class_details",
                arguments: { 
                    className: row.class_name,
                    artifactId: row.id,
                    type: "docs"
                }
            }, 3);
        } else {
            console.log("No artifact with source found for testing details.");
        }
    } catch (e) {
        console.log("DB not ready yet or error:", e);
    }
}, 9000);

// Kill after 15s
setTimeout(() => {
    server.kill();
}, 15000);
