import { createRequire } from 'node:module';
import path from 'path';
import os from 'os';
import fs from 'fs';

const require = createRequire(import.meta.url);

let Database: any = null;
let dbLoadError: string | null = null;

try {
  Database = require('better-sqlite3');
} catch (e: any) {
  dbLoadError = e?.message || String(e);
}

export class DB {
  private static instance: DB;
  private db: any;

  private constructor() {
    if (!Database) {
      throw new Error(dbLoadError || 'better-sqlite3 failed to load');
    }

    if (process.env.DB_FILE) {
      this.db = new Database(process.env.DB_FILE);
    } else {
      const homeDir = os.homedir();
      const configDir = path.join(homeDir, '.maven-indexer-mcp');
      
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const dbPath = path.join(configDir, 'maven-index.sqlite');
      this.db = new Database(dbPath);
    }
    this.initSchema();
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

  public static getInstance(): DB {
    if (!DB.instance) {
      DB.instance = new DB();
    }
    return DB.instance;
  }

  private initSchema() {
    // Register REGEXP function
    this.db.function('regexp', { deterministic: true }, (regex: string, text: string) => {
        if (!regex || !text) return 0;
        try {
            return new RegExp(regex).test(text) ? 1 : 0;
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

  public getDb() {
    return this.db;
  }

  public prepare(sql: string) {
    return this.db.prepare(sql);
  }

  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  public close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  public static reset() {
    if (DB.instance) {
      DB.instance.close();
      DB.instance = undefined as any;
    }
  }
}
