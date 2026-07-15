import fsSync from 'fs';
import { DB } from '@maven-indexer/engine';
import { Layout, resolveMainJar } from '@maven-indexer/engine';
import { Config } from '@maven-indexer/engine';
import { Indexer } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath } from './shared.js';
import { print } from '@maven-indexer/engine';

export interface MissingArtifact {
  id: number;
  groupId: string;
  artifactId: string;
  version: string;
  abspath: string;
  layout: string | null;
}

interface ArtifactRow {
  id: number;
  group_id: string;
  artifact_id: string;
  version: string;
  abspath: string;
  has_source: number;
  layout: string | null;
}

export async function run(opts: { prune?: boolean; checkFilters?: boolean } & GlobalOpts): Promise<void> {
  const db = DB.getInstance(resolveDbPath());

  // --check-filters: preview indexed classes that the current EXCLUDED_PACKAGES
  // would filter out. Does not mutate the index.
  if (opts.checkFilters) {
    const config = await Config.getInstance();
    const indexer = Indexer.getInstance();
    const matches = indexer.listClassesMatchingExcludes(config.normalizedExcludedPackages);
    if (matches.length === 0) {
      if (config.normalizedExcludedPackages.length === 0) {
        process.stdout.write('No EXCLUDED_PACKAGES configured.\n');
      } else {
        process.stdout.write('No indexed classes match the current EXCLUDED_PACKAGES.\n');
      }
    } else {
      process.stdout.write(`Indexed classes matching current EXCLUDED_PACKAGES (${matches.length}):\n`);
      for (const c of matches) {
        process.stdout.write(`  ${c}\n`);
      }
      process.stdout.write('Run `refresh-index` to prune these from the index.\n');
    }
    return;
  }

  const rows = db.prepare(`
    SELECT id, group_id, artifact_id, version, abspath, has_source, layout
    FROM artifacts
  `).all() as ArtifactRow[];

  const missing: MissingArtifact[] = [];

  for (const row of rows) {
    const artifact = {
      abspath: row.abspath,
      artifactId: row.artifact_id,
      version: row.version,
      layout: (row.layout as Layout | null) ?? null,
    };
    const mainJar = resolveMainJar(artifact);
    if (!fsSync.existsSync(mainJar)) {
      const entry: MissingArtifact = {
        id: row.id,
        groupId: row.group_id,
        artifactId: row.artifact_id,
        version: row.version,
        abspath: row.abspath,
        layout: row.layout,
      };
      missing.push(entry);
      process.stderr.write(
        `Missing: ${entry.groupId}:${entry.artifactId}:${entry.version} (${entry.abspath})\n`
      );
    }
  }

  if (opts.prune && missing.length > 0) {
    const deleteArtifact = db.prepare('DELETE FROM artifacts WHERE id = ?');
    const deleteClasses = db.prepare('DELETE FROM classes_fts WHERE artifact_id = ?');
    const deleteInheritance = db.prepare('DELETE FROM inheritance WHERE artifact_id = ?');
    const deleteResourceClasses = db.prepare(
      `DELETE FROM resource_classes WHERE resource_id IN (SELECT id FROM resources WHERE artifact_id = ?)`
    );
    const deleteResources = db.prepare('DELETE FROM resources WHERE artifact_id = ?');

    db.transaction(() => {
      for (const m of missing) {
        // Order matters: resource_classes references resources, so delete it first.
        deleteResourceClasses.run(m.id);
        deleteResources.run(m.id);
        deleteInheritance.run(m.id);
        deleteClasses.run(m.id);
        deleteArtifact.run(m.id);
      }
    });

    process.stderr.write(`Pruned ${missing.length} stale artifact row(s).\n`);
  }

  print('doctor', missing, opts);
}
