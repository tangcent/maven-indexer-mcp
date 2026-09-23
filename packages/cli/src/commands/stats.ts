import { DB } from '@maven-indexer/engine';
import { Indexer } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath } from './shared.js';
import { print } from '@maven-indexer/engine';

export async function run(opts: GlobalOpts): Promise<void> {
  DB.getInstance(resolveDbPath());

  const indexer = Indexer.getInstance();
  const stats = indexer.getStats();

  print('stats', stats, opts);
}
