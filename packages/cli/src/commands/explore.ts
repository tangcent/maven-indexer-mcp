import { explore, renderForLlm, ExploreInput } from '@maven-indexer/engine';
import { GlobalOpts } from './shared.js';

/**
 * `explore` — the PRIMARY command (Module 4 / requirements-cli-surface.md Req 1).
 *
 * Calls the same engine `explore()` function as the MCP `explore` tool
 * (Module 2) and produces the same payload. Unlike the MCP tool (where
 * `projectPath` is required), the CLI's `--project-path` is optional and
 * defaults to `process.cwd()` (Module 8 Req 6.2).
 */
export async function run(
  identifiers: string[],
  opts: {
    coordinate?: string;
    include?: string;
    maxLines?: number;
    question?: string;
    projectPath?: string;
  } & GlobalOpts,
): Promise<void> {
  const includeArr = opts.include
    ? (opts.include.split(',').map(s => s.trim()).filter(Boolean) as ExploreInput['include'])
    : undefined;

  const result = await explore({
    identifiers,
    coordinate: opts.coordinate,
    include: includeArr,
    maxLines: opts.maxLines,
    question: opts.question,
    projectPath: opts.projectPath ?? process.cwd(),
  });

  // Render based on global opts (json/for-llm/default).
  if (opts.json) {
    // --json: full structured JSON (trimmed when combined with --for-llm).
    console.log(JSON.stringify(result, null, 2));
  } else if (opts.forLlm) {
    // --for-llm only: token-shaped text.
    console.log(renderForLlm('explore', result, { maxLines: opts.maxLines ?? 200 }));
  } else {
    // Default: human-readable text (same LLM render, readable in a terminal).
    console.log(renderForLlm('explore', result, { maxLines: opts.maxLines ?? 200 }));
  }
}
