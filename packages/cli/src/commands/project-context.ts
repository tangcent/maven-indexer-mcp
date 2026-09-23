import { getProjectContext, print } from '@maven-indexer/engine';
import { GlobalOpts } from './shared.js';

/**
 * `project-context` — inspect the project context (Module 8 / Req 6.3).
 *
 * Returns the detected build file, project coordinate, and declared/resolved
 * dependency tree. Useful when version resolution surprises you.
 */
export async function run(projectPath: string, opts: GlobalOpts): Promise<void> {
  const ctx = await getProjectContext(projectPath);
  print('project-context', ctx, opts);
}
