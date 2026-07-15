import { DB } from '@maven-indexer/engine';
import { resolveDbPath } from '@maven-indexer/engine';

export interface GlobalOpts {
  json: boolean;
  forLlm?: boolean;
  maxLines?: number;
}

export { resolveDbPath };

export function assertIndexNotEmpty(db: DB): void {
  const row = db.prepare('SELECT COUNT(*) as n FROM artifacts WHERE is_indexed = 1').get() as { n: number };
  if (row.n === 0) {
    process.stderr.write('Index is empty. Run `maven-indexer-cli refresh-index` to build the index.\n');
    process.exit(1);
  }
}

/**
 * Parses a `className[.methodName]` target string for the call-graph commands.
 *
 * Heuristic: Java method names start with a lowercase letter, class names
 * with an uppercase letter. If the last dot-separated segment starts with
 * lowercase, it's treated as a method name; otherwise the whole string is
 * treated as a class name.
 */
export function parseTarget(target: string): { className: string; methodName: string | undefined } {
  const lastDotIndex = target.lastIndexOf('.');
  if (lastDotIndex > 0 && lastDotIndex < target.length - 1) {
    const lastSegment = target.substring(lastDotIndex + 1);
    if (lastSegment.length > 0 && lastSegment[0] >= 'a' && lastSegment[0] <= 'z') {
      return {
        className: target.substring(0, lastDotIndex),
        methodName: lastSegment,
      };
    }
  }
  return { className: target, methodName: undefined };
}
