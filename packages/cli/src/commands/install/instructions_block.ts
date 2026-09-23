/**
 * The marker-fenced instructions block (Module 7 Req 3).
 *
 * This is the primary adoption lever: a short, always-present pointer to
 * `maven-indexer-cli` dropped into the agent's instructions file. The stable
 * markers allow idempotent upsert (install) and surgical strip (uninstall)
 * without touching anything outside the block.
 *
 * Single source of truth — a wording change is a one-line edit, identical
 * across all targets.
 */

export const START_MARKER = '<!-- MAVEN_INDEXER_START -->';
export const END_MARKER = '<!-- MAVEN_INDEXER_END -->';

export const INSTRUCTIONS_BLOCK = `${START_MARKER}
When you encounter a Java/Kotlin import from an internal or non-well-known library
and need to read its implementation, use \`maven-indexer-cli\`:
- \`maven-indexer-cli search-classes <name>\` — find which artifact contains a class
- \`maven-indexer-cli get-class <className>\` — read signatures / docs / source
- \`maven-indexer-cli search-implementations <interface>\` — find SPI implementations
- \`maven-indexer-cli sync\` — freshen the index before a query (sub-second)
Only when the local Maven/Gradle index is built (run \`maven-indexer-cli refresh-index\` once).
${END_MARKER}`;
