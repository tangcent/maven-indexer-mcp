import { DB } from '@maven-indexer/engine';
import { Indexer } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath, assertIndexNotEmpty } from './shared.js';
import { print } from '@maven-indexer/engine';

export async function run(coordinate: string, resourcePath: string, opts: GlobalOpts): Promise<void> {
  const db = DB.getInstance(resolveDbPath());
  assertIndexNotEmpty(db);

  const parts = coordinate.split(':');
  if (parts.length !== 3) {
    process.stderr.write('Invalid coordinate format. Expected groupId:artifactId:version\n');
    process.exit(1);
  }
  const [groupId, artifactId, version] = parts;

  const indexer = Indexer.getInstance();
  const result = indexer.getResource(groupId, artifactId, version, resourcePath);

  if (!result) {
    process.stderr.write(`Resource '${resourcePath}' not found in ${coordinate}.\n`);
    process.exit(1);
  }

  print('get-resource', result, opts);
}
