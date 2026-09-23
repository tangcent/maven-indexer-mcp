import { DB } from '@maven-indexer/engine';
import { Indexer, RefreshResult } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath } from './shared.js';

export interface SyncOpts extends GlobalOpts {
  quiet?: boolean;
}

/**
 * `sync` — fast incremental refresh of the artifact index.
 *
 * Calls `Indexer.index({ quickScan: true })` directly, which uses the mtime-based
 * incremental path: it stats each artifact directory and only re-indexes those
 * whose mtime changed since the last run. On an unchanged index this completes
 * in well under a second regardless of index size.
 *
 * This is distinct from `refresh-index`, which performs a full shadow-table
 * rebuild (atomically swaps all secondary tables). Use `sync` for quick
 * pre-query freshening; use `refresh-index` when you suspect index corruption
 * or want a clean rebuild.
 *
 * Output:
 *   default (text): `Synced: 142 artifacts scanned, 3 added, 1 updated, 0 pruned in 327ms`
 *   --json:         `{ "scanned": 142, "added": 3, "updated": 1, "pruned": 0, "durationMs": 327 }`
 *   --quiet:        no stdout on success; errors still go to stderr + non-zero exit
 */
export async function run(opts: SyncOpts): Promise<void> {
  DB.getInstance(resolveDbPath());
  const db = DB.getInstance();
  const indexer = Indexer.getInstance();

  // Detect empty index to hint that the first scan may take longer.
  const isEmpty = (db.prepare('SELECT COUNT(*) as n FROM artifacts').get() as { n: number }).n === 0;
  if (isEmpty && !opts.quiet && !opts.json) {
    process.stderr.write('Index is empty — initial scan may take longer than usual.\n');
  }

  let result: RefreshResult;
  try {
    result = await indexer.index({ quickScan: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Sync failed: ${message}\n`);
    process.exit(1);
  }

  if (opts.quiet) {
    process.exit(0);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write(
      `Synced: ${result.scanned} artifacts scanned, ${result.added} added, ${result.updated} updated, ${result.pruned} pruned in ${result.durationMs}ms\n`
    );
  }
  process.exit(0);
}
