import path from 'path';
import os from 'os';

/**
 * Default SQLite database path shared by the MCP server and the CLI.
 * Both projects read this constant so they cannot drift to different defaults.
 */
export const DEFAULT_DB_PATH = path.join(os.homedir(), '.maven-indexer-mcp', 'maven-index.sqlite');

/**
 * Resolves the DB path to use, honoring the `DB_FILE` environment variable.
 */
export function resolveDbPath(): string {
    return process.env.DB_FILE ?? DEFAULT_DB_PATH;
}
