import { DB } from '@maven-indexer/engine';
import { Indexer } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath, assertIndexNotEmpty } from './shared.js';
import { print } from '@maven-indexer/engine';
import { resolve as smartResolve } from '@maven-indexer/engine';

export async function run(className: string, opts: { limit?: number } & GlobalOpts): Promise<void> {
  const db = DB.getInstance(resolveDbPath());
  assertIndexNotEmpty(db);
  const indexer = Indexer.getInstance();

  let resolvedName = className;
  if (!className.includes('.')) {
    const fqn = await smartResolve(className, process.cwd());
    if (fqn) {
      resolvedName = fqn;
    } else if (!className.includes('.')) {
      // AC5: no source file found, fall through to simple-name search
      process.stderr.write(`No source file found for '${className}' in project, falling back to simple-name search.\n`);
    }
  }

  const results = indexer.searchImplementations(resolvedName, opts.limit);

  if (results.length === 0 && resolvedName === className) {
    // AC6: targeted scan didn't find it and no FQN was resolved
    process.stderr.write(`Could not resolve '${className}' to any known class or interface.\n`);
    print('search-implementations', [], opts);
    return;
  }

  print('search-implementations', results, opts);
}
