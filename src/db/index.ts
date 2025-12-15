import Database from 'better-sqlite3';
import path from 'path';

export class DB {
  private static instance: DB;
  private db: Database.Database;

  private constructor() {
    // Check environment variable for DB path (useful for testing)
    const dbName = process.env.DB_FILE || 'maven-index.sqlite';
    const dbPath = path.join(process.cwd(), dbName);
    this.db = new Database(dbPath);
    this.initSchema();
  }

  public static getInstance(): DB {
    if (!DB.instance) {
      DB.instance = new DB();
    }
    return DB.instance;
  }

  private initSchema() {
    // Register REGEXP function
    this.db.function('regexp', { deterministic: true }, (regex, text) => {
        if (!regex || !text) return 0;
        try {
            return new RegExp(regex as string).test(text as string) ? 1 : 0;
        } catch (e) {
            return 0;
        }
    });

    this.db.exec(`
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
        class_name, -- Fully qualified name
        simple_name, -- Just the class name
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
      
      -- Cleanup old table if exists
      DROP TABLE IF EXISTS indexed_artifacts;
    `);

    try {
      this.db.exec('ALTER TABLE artifacts ADD COLUMN is_indexed INTEGER DEFAULT 0');
    } catch (e) {
      // Column likely already exists
    }
  }

  public getDb(): Database.Database {
    return this.db;
  }

  public prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
