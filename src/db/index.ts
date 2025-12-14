import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version TEXT NOT NULL,
        abspath TEXT NOT NULL,
        has_source INTEGER DEFAULT 0,
        UNIQUE(group_id, artifact_id, version)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS classes_fts USING fts5(
        artifact_id UNINDEXED,
        class_name, -- Fully qualified name
        simple_name, -- Just the class name
        tokenize="trigram" 
      );
      
      -- Helper table to track indexed artifacts to avoid re-indexing unchanged ones (simplification: just track ID)
      CREATE TABLE IF NOT EXISTS indexed_artifacts (
          artifact_id INTEGER PRIMARY KEY
      );
    `);
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
