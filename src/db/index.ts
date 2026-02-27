import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

export class DB {
  private static instance: DB;
  private db: Database.Database;

  private constructor() {
    // Check environment variable for DB path (useful for testing)
    if (process.env.DB_FILE) {
      this.db = new Database(process.env.DB_FILE);
    } else {
      // Use home directory for the database file
      const homeDir = os.homedir();
      const configDir = path.join(homeDir, '.maven-indexer-mcp');
      
      // Ensure the directory exists
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const dbPath = path.join(configDir, 'maven-index.sqlite');
      this.db = new Database(dbPath);
    }
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

      -- Migration from old proto_classes table
      DROP TABLE IF EXISTS proto_classes;
      
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
