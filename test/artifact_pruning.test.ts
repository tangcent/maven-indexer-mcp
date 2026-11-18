import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DB } from '@maven-indexer/engine';
import { pruneArtifacts } from '../packages/engine/src/artifact_pruning.js';

const tables = [
    'artifacts', 'classes_fts', 'inheritance', 'resources',
    'resource_classes', 'call_edges', 'artifact_dir_mtimes', 'dependencies',
];

describe('batched missing-JAR artifact pruning', () => {
    let tmpDir: string;
    let dbFile: string;
    let db: DB;

    beforeEach(() => {
        DB.reset();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-pruning-'));
        dbFile = path.join(tmpDir, 'index.sqlite');
        db = DB.getInstance(dbFile);
        db.transaction(() => {
            for (const id of [1, 2, 3]) {
                db.prepare(`INSERT INTO artifacts (id, group_id, artifact_id, version, abspath)
                            VALUES (?, 'com.example', ?, '1.0', ?)`)
                    .run(id, `lib-${id}`, path.join(tmpDir, `lib-${id}`));
                db.prepare('INSERT INTO classes_fts (artifact_id, class_name, simple_name) VALUES (?, ?, ?)')
                    .run(id, `com.example.Class${id}`, `Class${id}`);
                db.prepare(`INSERT INTO inheritance (artifact_id, class_name, parent_class_name, type)
                            VALUES (?, ?, 'java.io.Serializable', 'implements')`).run(id, `com.example.Class${id}`);
                db.prepare(`INSERT INTO resources (id, artifact_id, path, content, type)
                            VALUES (?, ?, 'config.properties', 'key=value', 'properties')`).run(100 + id, id);
                db.prepare('INSERT INTO resource_classes (resource_id, class_name) VALUES (?, ?)')
                    .run(100 + id, `com.example.Class${id}`);
                db.prepare(`INSERT INTO call_edges (artifact_id, caller_class, caller_method, callee_class, callee_method, invoke_kind)
                            VALUES (?, ?, 'run', 'com.example.Target', 'run', 'invokevirtual')`)
                    .run(id, `com.example.Class${id}`);
                db.prepare('INSERT INTO artifact_dir_mtimes (artifact_id, dir_path, mtime) VALUES (?, ?, 123)')
                    .run(id, path.join(tmpDir, `lib-${id}`));
                db.prepare(`INSERT INTO dependencies (artifact_id, dep_group_id, dep_artifact_id)
                            VALUES (?, 'com.example', 'dependency')`).run(id);
            }
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        DB.reset();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function snapshot() {
        return Object.fromEntries(tables.map(table => [
            table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]));
    }

    it('removes only the selected artifacts and their associated metadata', () => {
        const before = snapshot();
        pruneArtifacts(db, [1, 3]);

        for (const table of tables) {
            const column = table === 'artifacts' ? 'id'
                : table === 'resource_classes' ? 'resource_id' : 'artifact_id';
            const keep = table === 'resource_classes' ? 102 : 2;
            expect(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
                .toEqual(before[table].filter((row: any) => row[column] === keep));
        }
        expect(db.getDb().pragma('foreign_key_check')).toEqual([]);
        expect(db.prepare("SELECT name FROM sqlite_temp_master WHERE name = 'prune_artifact_ids'").all()).toEqual([]);
    });

    it('rolls back every table and the temporary IDs on failure, and permits a retry', () => {
        const before = snapshot();
        db.exec(`CREATE TRIGGER fail_prune BEFORE DELETE ON artifacts WHEN OLD.id = 3
                 BEGIN SELECT RAISE(ABORT, 'simulated prune failure'); END;`);

        expect(() => pruneArtifacts(db, [1, 3])).toThrow('simulated prune failure');
        expect(snapshot()).toEqual(before);
        expect(db.prepare("SELECT name FROM sqlite_temp_master WHERE name = 'prune_artifact_ids'").all()).toEqual([]);

        db.exec('DROP TRIGGER fail_prune');
        pruneArtifacts(db, [1, 3]);
        expect(db.prepare('SELECT id FROM artifacts').all()).toEqual([{ id: 2 }]);
    });

    it('does no work for an empty batch', () => {
        const before = snapshot();
        const transaction = vi.spyOn(db, 'transaction');
        pruneArtifacts(db, []);
        expect(transaction).not.toHaveBeenCalled();
        expect(snapshot()).toEqual(before);
    });

    it('prunes all artifacts in one batch', () => {
        pruneArtifacts(db, [1, 2, 3]);
        for (const table of tables) {
            expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
    });

    it('handles POM-only batches larger than SQLite\'s usual variable limit', () => {
        const ids = Array.from({ length: 33_000 }, (_, i) => i + 4);
        db.transaction(() => {
            const insert = db.prepare(`INSERT INTO artifacts (id, group_id, artifact_id, version, abspath)
                                       VALUES (?, 'com.example', ?, '1.0', 'missing')`);
            for (const id of ids) insert.run(id, `pom-${id}`);
        });
        const before = snapshot();
        pruneArtifacts(db, ids);
        expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toEqual({ n: 3 });
        for (const table of tables.filter(t => t !== 'artifacts')) {
            expect(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before[table]);
        }
    });

    it('uses an artifact index for call-edge deletes and FK cascade checks', () => {
        const plan = db.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM call_edges WHERE artifact_id = ?').all(1);
        expect(plan.map((row: any) => row.detail).join('\n')).toContain('USING COVERING INDEX idx_call_edges_artifact');
    });

    it('adds the artifact index to an existing v9 database without losing its data', () => {
        const before = snapshot();
        db.exec('DROP INDEX idx_call_edges_artifact');
        db.getDb().pragma('user_version = 9');
        DB.reset();

        db = DB.getInstance(dbFile);
        expect(db.getDb().pragma('user_version', { simple: true })).toBe(10);
        expect(snapshot()).toEqual(before);
        const indexes = db.prepare('PRAGMA index_list(call_edges)').all() as { name: string }[];
        expect(indexes.map(index => index.name)).toContain('idx_call_edges_artifact');
    });
});
