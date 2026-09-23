import { DB } from '@maven-indexer/engine';
import { Indexer } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath, assertIndexNotEmpty } from './shared.js';
import { print } from '@maven-indexer/engine';

export interface SearchMethodsOpts extends GlobalOpts {
  limit?: number;
  exact?: boolean;
  caseSensitive?: boolean;
}

export async function run(name: string, opts: SearchMethodsOpts): Promise<void> {
  const db = DB.getInstance(resolveDbPath());
  assertIndexNotEmpty(db);

  const indexer = Indexer.getInstance();
  const results = indexer.searchMethods(name, {
    exact: opts.exact,
    caseSensitive: opts.caseSensitive,
    limit: opts.limit,
  });

  print('search-methods', results, opts);
}
