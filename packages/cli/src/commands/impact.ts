import { DB } from '@maven-indexer/engine';
import { Indexer } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath, assertIndexNotEmpty, parseTarget } from './shared.js';
import { print } from '@maven-indexer/engine';

export interface ImpactOpts extends GlobalOpts {
  depth?: number;
  maxNodes?: number;
  format?: 'flat' | 'tree';
}

export async function run(target: string, opts: ImpactOpts): Promise<void> {
  const db = DB.getInstance(resolveDbPath());
  assertIndexNotEmpty(db);
  const indexer = Indexer.getInstance();

  const { className, methodName } = parseTarget(target);
  const result = indexer.impact(className, methodName, {
    depth: opts.depth,
    maxNodes: opts.maxNodes,
  });

  if (!result.callGraphAvailable) {
    process.stderr.write('Call-graph index is empty (INDEX_CALL_GRAPH=0 or no artifacts indexed). Results will be empty.\n');
  } else if (result.nodes.length === 0) {
    const label = methodName ? `${className}.${methodName}` : className;
    process.stderr.write(`No impact (transitive callers) found for ${label}.\n`);
  }

  print('impact', {
    target: { className, methodName },
    nodes: result.nodes,
    truncated: result.truncated,
    callGraphAvailable: result.callGraphAvailable,
    maxDepth: result.maxDepth,
    maxNodes: result.maxNodes,
    format: opts.format ?? 'flat',
  }, opts);
}
