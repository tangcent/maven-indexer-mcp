import { DB } from '@maven-indexer/engine';
import { Indexer } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath, assertIndexNotEmpty, parseTarget } from './shared.js';
import { print } from '@maven-indexer/engine';

export async function run(target: string, opts: { limit?: number } & GlobalOpts): Promise<void> {
  const db = DB.getInstance(resolveDbPath());
  assertIndexNotEmpty(db);
  const indexer = Indexer.getInstance();

  const { className, methodName } = parseTarget(target);
  const edges = indexer.searchCallers(className, methodName, opts.limit);
  const callGraphAvailable = indexer.isCallGraphAvailable();

  if (!callGraphAvailable) {
    process.stderr.write('Call-graph index is empty (INDEX_CALL_GRAPH=0 or no artifacts indexed). Results will be empty.\n');
  } else if (edges.length === 0) {
    const label = methodName ? `${className}.${methodName}` : className;
    process.stderr.write(`No callers found for ${label}.\n`);
  }

  print('callers', { target: { className, methodName }, edges, callGraphAvailable }, opts);
}
