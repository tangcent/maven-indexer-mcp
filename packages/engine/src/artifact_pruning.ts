import type { DB } from './db/index.js';

/** Remove missing-JAR artifacts and their metadata in one atomic batch. */
export function pruneArtifacts(db: DB, artifactIds: number[]): void {
    if (artifactIds.length === 0) return;

    db.transaction(() => {
        // artifact_id is UNINDEXED in classes_fts. Deleting once per artifact
        // scans the full class index repeatedly, even for POM-only artifacts
        // that have no classes. A temp table also avoids SQL variable limits.
        db.exec('CREATE TEMP TABLE prune_artifact_ids (id INTEGER PRIMARY KEY)');
        const insertId = db.prepare('INSERT INTO temp.prune_artifact_ids (id) VALUES (?)');
        for (const id of artifactIds) insertId.run(id);

        db.exec(`
            DELETE FROM resource_classes WHERE resource_id IN (
                SELECT id FROM resources WHERE artifact_id IN (SELECT id FROM temp.prune_artifact_ids)
            );
            DELETE FROM resources WHERE artifact_id IN (SELECT id FROM temp.prune_artifact_ids);
            DELETE FROM classes_fts WHERE artifact_id IN (SELECT id FROM temp.prune_artifact_ids);
            DELETE FROM inheritance WHERE artifact_id IN (SELECT id FROM temp.prune_artifact_ids);
            DELETE FROM call_edges WHERE artifact_id IN (SELECT id FROM temp.prune_artifact_ids);
            DELETE FROM artifact_dir_mtimes WHERE artifact_id IN (SELECT id FROM temp.prune_artifact_ids);
            DELETE FROM artifacts WHERE id IN (SELECT id FROM temp.prune_artifact_ids);
            DROP TABLE temp.prune_artifact_ids;
        `);
    });
}
