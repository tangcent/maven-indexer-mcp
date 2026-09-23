import { DB } from '@maven-indexer/engine';
import { Indexer } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath } from './shared.js';

export async function run(opts: { quick?: boolean; full?: boolean; watch?: boolean } & GlobalOpts): Promise<void> {
  DB.getInstance(resolveDbPath());

  const indexer = Indexer.getInstance();

  try {
    if (opts.full) {
      await indexer.refresh({ quickScan: false });
    } else {
      await indexer.refresh({ quickScan: true });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Index refresh failed: ${message}\n`);
    if (!opts.watch) process.exit(1);
  }

  if (opts.watch) {
    process.stdout.write('Watching for changes. Press Ctrl+C to stop.\n');
    await indexer.startWatch();

    // Handle SIGINT/SIGTERM for clean exit
    const shutdown = async () => {
      try {
        await indexer.stopWatch();
        DB.getInstance().close();
      } catch (e) {
        process.stderr.write(`Error during shutdown: ${e instanceof Error ? e.message : e}\n`);
      }
      process.exit(0);
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
    // Keep the process alive
    setInterval(() => {}, 1 << 30);
  } else {
    process.stdout.write('Index refresh complete.\n');
    process.exit(0);
  }
}
