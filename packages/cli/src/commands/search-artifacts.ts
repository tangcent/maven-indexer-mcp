import { DB } from '@maven-indexer/engine';
import { Indexer } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath, assertIndexNotEmpty } from './shared.js';
import { print } from '@maven-indexer/engine';

export async function run(query: string, opts: { limit?: number } & GlobalOpts): Promise<void> {
  const db = DB.getInstance(resolveDbPath());
  assertIndexNotEmpty(db);

  const indexer = Indexer.getInstance();
  const results = indexer.search(query, opts.limit);

  print('search-artifacts', results, opts);
}
