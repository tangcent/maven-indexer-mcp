import { createRequire } from 'node:module';
import path from 'path';
import fs from 'fs';
import { resolveDbPath } from '../constants.js';

const require = createRequire(import.meta.url);

// Load the value through createRequire (with a try/catch so a missing native
// binary doesn't crash startup — checkHealth() reports the failure). Import the
// *type* separately so the field below is properly typed under strict mode.
import type DatabaseType from 'better-sqlite3';
import type { Database as DBType } from 'better-sqlite3';

let Database: typeof DatabaseType | null = null;
let dbLoadError: string | null = null;

try {
  Database = require('better-sqlite3');
} catch (e: any) {
  dbLoadError = e?.message || String(e);
}

interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Optional post-migration step running inside the same transaction. */
  after?: (db: DBType) => void;
}

/**
 * Versioned migrations. Each step runs once, tracked via `PRAGMA user_version`.
 * The baseline (v1) creates the original schema (minus the dead ALTER block).
 * Subsequent steps add columns/tables and backfill data.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline',
    sql: `
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version TEXT NOT NULL,
        abspath TEXT NOT NULL,
        has_source INTEGER DEFAULT 0,
        is_indexed INTEGER DEFAULT 0,
        UNIQUE(group_id, artifact_id, version)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS classes_fts USING fts5(
        artifact_id UNINDEXED,
        class_name,
        simple_name,
        tokenize="trigram"
      );

      CREATE TABLE IF NOT EXISTS inheritance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id INTEGER NOT NULL,
        class_name TEXT NOT NULL,
        parent_class_name TEXT NOT NULL,
        type TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inheritance_parent ON inheritance(parent_class_name);

      CREATE TABLE IF NOT EXISTS resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        content TEXT,
        type TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_resources_artifact ON resources(artifact_id);

      CREATE TABLE IF NOT EXISTS resource_classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_id INTEGER NOT NULL,
        class_name TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_resource_classes_class ON resource_classes(class_name);
    `,
  },
  {
    version: 2,
    name: 'drop_legacy_proto_classes',
    sql: `DROP TABLE IF EXISTS proto_classes;`,
  },
  {
    version: 3,
    name: 'drop_legacy_indexed_artifacts',
    sql: `DROP TABLE IF EXISTS indexed_artifacts;`,
  },
  {
    version: 4,
    name: 'add_layout_column',
    sql: `ALTER TABLE artifacts ADD COLUMN layout TEXT;`,
    after: (db) => {
      // Backfill layout from the legacy heuristic (one-time).
      db.exec(`UPDATE artifacts SET layout = 'gradle' WHERE layout IS NULL AND abspath LIKE '%.jar';`);
      db.exec(`UPDATE artifacts SET layout = 'maven' WHERE layout IS NULL;`);
    },
  },
  {
    version: 5,
    name: 'add_meta_table',
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `,
  },
  {
    version: 6,
    name: 'add_methods_table',
    sql: `
      CREATE TABLE IF NOT EXISTS methods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id INTEGER NOT NULL,
        class_name TEXT NOT NULL,
        method_name TEXT NOT NULL,
        descriptor TEXT,
        UNIQUE(artifact_id, class_name, method_name, descriptor)
      );
      CREATE INDEX IF NOT EXISTS idx_methods_name ON methods(method_name);
      CREATE INDEX IF NOT EXISTS idx_methods_class ON methods(class_name);
    `,
  },
  {
    version: 7,
    name: 'add_artifact_dir_mtimes',
    sql: `CREATE TABLE IF NOT EXISTS artifact_dir_mtimes (
      artifact_id INTEGER PRIMARY KEY,
      dir_path TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );`,
  },
  {
    version: 8,
    name: 'add_dependencies_table',
    sql: `CREATE TABLE IF NOT EXISTS dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id INTEGER NOT NULL,
    dep_group_id TEXT NOT NULL,
    dep_artifact_id TEXT NOT NULL,
    dep_version TEXT,
    scope TEXT,
    optional INTEGER DEFAULT 0,
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_dependencies_artifact ON dependencies(artifact_id);
  CREATE INDEX IF NOT EXISTS idx_dependencies_dep ON dependencies(dep_group_id, dep_artifact_id);`,
  },
  {
    version: 9,
    name: 'add_call_edges_table',
    sql: `CREATE TABLE IF NOT EXISTS call_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_class TEXT NOT NULL,
    caller_method TEXT NOT NULL,
    caller_descriptor TEXT,
    callee_class TEXT NOT NULL,
    callee_method TEXT NOT NULL,
    callee_descriptor TEXT,
    invoke_kind TEXT NOT NULL,
    artifact_id INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_call_edges_caller ON call_edges(caller_class, caller_method);
  CREATE INDEX IF NOT EXISTS idx_call_edges_callee ON call_edges(callee_class, callee_method);`,
  },
];

export class DB {
  private static instance: DB;
  private db: DBType;
  readonly currentPath: string;

  private constructor(dbPath?: string) {
    if (!Database) {
      throw new Error(dbLoadError || 'better-sqlite3 failed to load');
    }

    this.currentPath = dbPath ?? resolveDbPath();
    const dir = path.dirname(this.currentPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.currentPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initSchema();
    this.runMigrations();
  }

  public static isAvailable(): boolean {
    return Database !== null;
  }

  public static getLoadError(): string | null {
    return dbLoadError;
  }

  public static checkHealth(): string | null {
    if (!Database) {
      return dbLoadError || 'better-sqlite3 failed to load';
    }
    try {
      const testDb = new Database(':memory:');
      testDb.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _health_fts USING fts5(x, tokenize="trigram")');
      testDb.close();
    } catch (e: any) {
      return e?.message || String(e);
    }
    return null;
  }

  /**
   * Returns the singleton DB instance. If `dbPath` is provided and differs
   * from the current instance's path, the instance is closed and reopened
   * with the new path (so the argument is never silently ignored).
   */
  public static getInstance(dbPath?: string): DB {
    if (DB.instance && dbPath && dbPath !== DB.instance.currentPath) {
      DB.instance.close();
      DB.instance = new DB(dbPath);
    }
    if (!DB.instance) {
      DB.instance = new DB(dbPath);
    }
    return DB.instance;
  }

  private initSchema() {
    // Register REGEXP function. Errors propagate to the caller (no silent
    // swallowing) so invalid regexes surface; callers pre-validate + cap length.
    this.db.function('regexp', { deterministic: true }, (regex: unknown, text: unknown) => {
      if (typeof regex !== 'string' || typeof text !== 'string' || !regex || !text) return 0;
      // Compile here so an invalid regex throws to the SQL caller.
      return new RegExp(regex).test(text) ? 1 : 0;
    });
  }

  private runMigrations() {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.sql);
        if (m.after) m.after(this.db);
        this.db.pragma(`user_version = ${m.version}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw new Error(`Migration v${m.version} (${m.name}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  public getDb(): DBType {
    return this.db;
  }

  public prepare(sql: string): any {
    return this.db.prepare(sql);
  }

  public exec(sql: string): void {
    this.db.exec(sql);
  }

  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  public close() {
    if (this.db) {
      this.db.close();
      // @ts-expect-error - intentionally null after close
      this.db = null;
    }
  }

  public static reset() {
    if (DB.instance) {
      DB.instance.close();
      DB.instance = undefined as unknown as DB;
    }
  }
}
