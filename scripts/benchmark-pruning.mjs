/**
 * Reproduce missing-JAR pruning against retained class/call-edge data.
 * Run: npm run build && node scripts/benchmark-pruning.mjs [rows=50000] [missing=500]
 * Uses synthetic data and temporary databases; never opens the user's index.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DB } from '../packages/engine/dist/db/index.js';
import { pruneArtifacts } from '../packages/engine/dist/artifact_pruning.js';

const rows = Number(process.argv[2] ?? 50_000);
const missing = Number(process.argv[3] ?? 500);
assert(Number.isSafeInteger(rows) && rows > 0, 'rows must be a positive integer');
assert(Number.isSafeInteger(missing) && missing > 0, 'missing must be a positive integer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-pruning-'));
const ids = Array.from({ length: missing }, (_, i) => i + 2);

// The previous production implementation, retained here only as a baseline.
function legacyPrune(db, artifactIds) {
    db.transaction(() => {
        const statements = [
            'DELETE FROM resource_classes WHERE resource_id IN (SELECT id FROM resources WHERE artifact_id = ?)',
            'DELETE FROM resources WHERE artifact_id = ?',
            'DELETE FROM classes_fts WHERE artifact_id = ?',
            'DELETE FROM inheritance WHERE artifact_id = ?',
            'DELETE FROM call_edges WHERE artifact_id = ?',
            'DELETE FROM artifact_dir_mtimes WHERE artifact_id = ?',
            'DELETE FROM artifacts WHERE id = ?',
        ].map(sql => db.prepare(sql));
        for (const id of artifactIds) {
            for (const statement of statements) statement.run(id);
        }
    });
}

try {
    const seed = path.join(tmp, 'seed.sqlite');
    let db = DB.getInstance(seed);
    db.transaction(() => {
        const insertArtifact = db.prepare(`INSERT INTO artifacts (id, group_id, artifact_id, version, abspath)
                                          VALUES (?, 'com.example', ?, '1.0', 'synthetic')`);
        insertArtifact.run(1, 'retained');
        for (const id of ids) insertArtifact.run(id, `missing-${id}`);
        const insertClass = db.prepare(`INSERT INTO classes_fts (artifact_id, class_name, simple_name) VALUES (1, ?, ?)`);
        const insertEdge = db.prepare(`INSERT INTO call_edges (artifact_id, caller_class, caller_method, callee_class, callee_method, invoke_kind)
                                       VALUES (1, ?, 'run', 'com.example.Target', 'run', 'invokevirtual')`);
        const insertInheritance = db.prepare(`INSERT INTO inheritance (artifact_id, class_name, parent_class_name, type)
                                              VALUES (1, ?, 'java.io.Serializable', 'implements')`);
        for (let i = 0; i < rows; i++) {
            const name = `com.example.Retained${i}`;
            insertClass.run(name, `Retained${i}`);
            insertEdge.run(name);
            insertInheritance.run(name);
        }
        // Most missing artifacts are POM-only, but include some stale metadata
        // to exercise real deletion as well as empty-table lookups.
        for (const id of ids.filter((_, i) => i % 50 === 0)) {
            db.prepare('INSERT INTO classes_fts (artifact_id, class_name, simple_name) VALUES (?, ?, ?)')
                .run(id, `com.example.Stale${id}`, `Stale${id}`);
            db.prepare(`INSERT INTO call_edges (artifact_id, caller_class, caller_method, callee_class, callee_method, invoke_kind)
                        VALUES (?, 'com.example.Stale', 'run', 'com.example.Target', 'run', 'invokevirtual')`).run(id);
        }
    });
    const sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
    DB.reset();

    const results = [];
    for (const indexed of [false, true]) {
        for (const [name, prune] of [['per-artifact', legacyPrune], ['batched', pruneArtifacts]]) {
            const filename = path.join(tmp, `${name}-${indexed}.sqlite`);
            fs.copyFileSync(seed, filename);
            db = DB.getInstance(filename);
            if (!indexed) db.exec('DROP INDEX idx_call_edges_artifact');
            const start = performance.now();
            prune(db, ids);
            const duration = performance.now() - start;
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 1);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM classes_fts').get().n, rows);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM call_edges').get().n, rows);
            assert.deepEqual(db.getDb().pragma('foreign_key_check'), []);
            results.push({ pruning: name, artifactIndex: indexed, milliseconds: Math.round(duration) });
            DB.reset();
        }
    }
    console.log(JSON.stringify({ node: process.version, sqlite, rows, missing }));
    console.table(results);
} finally {
    DB.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
}
