import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import yauzl from 'yauzl';
import chokidar from 'chokidar';
import { FSWatcher } from 'chokidar';
import { Config } from './config.js';
import { DB } from './db/index.js';
import { ClassParser } from './class_parser.js';

export interface Artifact {
  id: number;
  groupId: string;
  artifactId: string;
  version: string;
  abspath: string;
  hasSource: boolean;
}

/**
 * Singleton class responsible for indexing Maven artifacts.
 * It scans the local repository, watches for changes, and indexes Java classes.
 */
export class Indexer {
  private static instance: Indexer;
  private isIndexing: boolean = false;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): Indexer {
    if (!Indexer.instance) {
      Indexer.instance = new Indexer();
    }
    return Indexer.instance;
  }

  /**
   * Starts watching the local repository for changes.
   * Debounces changes to trigger re-indexing.
   */
  public async startWatch() {
    const config = await Config.getInstance();
    const repoPath = config.localRepository;
    
    if (!repoPath || !fsSync.existsSync(repoPath)) {
        console.error("Repository path not found, skipping watch mode.");
        return;
    }

    if (this.watcher) {
        return;
    }

    console.error(`Starting file watcher on ${repoPath}...`);
    this.watcher = chokidar.watch(repoPath, {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true,
        ignoreInitial: true,
        depth: 10 // Limit depth to avoid too much overhead? Standard maven repo depth is around 3-5
    });

    const onChange = () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            console.error("Repository change detected. Triggering re-index...");
            this.index().catch(console.error);
        }, 5000); // Debounce for 5 seconds
    };

    this.watcher
        .on('add', (path: string) => {
            if (path.endsWith('.jar') || path.endsWith('.pom')) onChange();
        })
        .on('unlink', (path: string) => {
            if (path.endsWith('.jar') || path.endsWith('.pom')) onChange();
        });
  }

  /**
   * Forces a full re-index of the repository.
   */
  public async refresh() {
      const db = DB.getInstance();
      console.error("Refreshing index...");
      db.transaction(() => {
          db.prepare('UPDATE artifacts SET is_indexed = 0').run();
          db.prepare('DELETE FROM classes_fts').run();
          db.prepare('DELETE FROM inheritance').run();
      });
      return this.index();
  }

  /**
   * Main indexing process.
   * 1. Scans the file system for Maven artifacts.
   * 2. Synchronizes the database with found artifacts.
   * 3. Indexes classes for artifacts that haven't been indexed yet.
   */
  public async index() {
    if (this.isIndexing) return;
    this.isIndexing = true;
    console.error("Starting index...");

    try {
        const config = await Config.getInstance();
        const repoPath = config.localRepository;
        const db = DB.getInstance();

        if (!repoPath) {
            console.error("No local repository path found.");
            return;
        }
        // 1. Scan for artifacts
        console.error("Scanning repository structure...");
        const artifacts = await this.scanRepository(repoPath);
        console.error(`Found ${artifacts.length} artifacts on disk.`);

        // 2. Persist artifacts and determine what needs indexing
        // We use is_indexed = 0 for new artifacts.
        const insertArtifact = db.prepare(`
            INSERT OR IGNORE INTO artifacts (group_id, artifact_id, version, abspath, has_source, is_indexed)
            VALUES (@groupId, @artifactId, @version, @abspath, @hasSource, 0)
        `);

        // Use a transaction only for the batch insert of artifacts
        db.transaction(() => {
            for (const art of artifacts) {
                insertArtifact.run({
                    ...art,
                    hasSource: art.hasSource ? 1 : 0
                });
            }
        });

        // Check if we need to backfill inheritance data (migration)
        const inheritanceCount = db.prepare('SELECT COUNT(*) as count FROM inheritance').get() as { count: number };
        const indexedArtifactsCount = db.prepare('SELECT COUNT(*) as count FROM artifacts WHERE is_indexed = 1').get() as { count: number };
        
        if (inheritanceCount.count === 0 && indexedArtifactsCount.count > 0) {
            console.error("Detected missing inheritance data. Forcing re-index of classes...");
            db.transaction(() => {
                db.prepare('UPDATE artifacts SET is_indexed = 0').run();
                db.prepare('DELETE FROM classes_fts').run();
                // inheritance is already empty
            });
        }

        // 3. Find artifacts that need indexing (is_indexed = 0)
        const artifactsToIndex = db.prepare(`
            SELECT id, group_id as groupId, artifact_id as artifactId, version, abspath, has_source as hasSource
            FROM artifacts 
            WHERE is_indexed = 0
        `).all() as Artifact[];

        console.error(`${artifactsToIndex.length} artifacts need indexing.`);

        // 4. Scan JARs for classes and update DB
        const CHUNK_SIZE = 50;
        let processedCount = 0;
        
        for (let i = 0; i < artifactsToIndex.length; i += CHUNK_SIZE) {
            const chunk = artifactsToIndex.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(artifact => this.indexArtifactClasses(artifact)));
            processedCount += chunk.length;
            if (processedCount % 100 === 0) {
                console.error(`Processed ${processedCount}/${artifactsToIndex.length} artifacts...`);
            }
        }
        
        console.error(`Indexing complete.`);
    } catch (e) {
        console.error("Indexing failed", e);
    } finally {
        this.isIndexing = false;
    }
  }

  /**
   * Recursively scans a directory for Maven artifacts (POM files).
   */
  private async scanRepository(rootDir: string): Promise<Artifact[]> {
    const results: Artifact[] = [];
    
    const scanDir = async (dir: string) => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }

        const pomFiles = entries.filter(e => e.isFile() && e.name.endsWith('.pom'));
        
        if (pomFiles.length > 0) {
             const version = path.basename(dir);
             const artifactDir = path.dirname(dir);
             const artifactId = path.basename(artifactDir);
             const groupDir = path.dirname(artifactDir);
             
             const relGroupPath = path.relative(rootDir, groupDir);
             const groupId = relGroupPath.split(path.sep).join('.');
             
             if (groupId && artifactId && version && !groupId.startsWith('..')) {
                 const sourceJarPath = path.join(dir, `${artifactId}-${version}-sources.jar`);
                 // Use sync check for speed in this context or cache it
                 const hasSource = fsSync.existsSync(sourceJarPath);

                 results.push({
                     id: 0, // Placeholder
                     groupId,
                     artifactId,
                     version,
                     abspath: dir,
                     hasSource
                 });
                 return; 
             }
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.')) continue;
                await scanDir(path.join(dir, entry.name));
            }
        }
    };

    await scanDir(rootDir);
    return results;
  }

  /**
   * Extracts classes from the artifact's JAR and indexes them.
   * Updates the 'is_indexed' flag upon completion.
   */
  private async indexArtifactClasses(artifact: Artifact): Promise<void> {
      const jarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}.jar`);
      const db = DB.getInstance();
      const config = await Config.getInstance();
      
      try {
          await fs.access(jarPath);
      } catch {
          // If jar missing, mark as indexed so we don't retry endlessly? 
          // Or maybe it's a pom-only artifact.
          db.prepare('UPDATE artifacts SET is_indexed = 1 WHERE id = ?').run(artifact.id);
          return;
      }

      return new Promise((resolve) => {
          yauzl.open(jarPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
              if (err || !zipfile) {
                  // If we can't open it, maybe it's corrupt. Skip for now.
                  resolve();
                  return;
              }

              const classes: string[] = [];
              const inheritance: { className: string, parent: string, type: 'extends' | 'implements' }[] = [];

              zipfile.readEntry();

              zipfile.on('entry', (entry) => {
                  if (entry.fileName.endsWith('.class')) {
                      zipfile.openReadStream(entry, (err, readStream) => {
                          if (err || !readStream) {
                              zipfile.readEntry();
                              return;
                          }

                          const chunks: Buffer[] = [];
                          readStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                          readStream.on('end', () => {
                              const buffer = Buffer.concat(chunks);
                              try {
                                  const info = ClassParser.parse(buffer);
                                  // Simple check to avoid module-info or invalid names
                                  if (!info.className.includes('$') && info.className.length > 0) {
                                      // Filter by includedPackages
                                      if (this.isPackageIncluded(info.className, config.includedPackages)) {
                                          classes.push(info.className);

                                          if (info.superClass && info.superClass !== 'java.lang.Object') {
                                              inheritance.push({ className: info.className, parent: info.superClass, type: 'extends' });
                                          }
                                          for (const iface of info.interfaces) {
                                              inheritance.push({ className: info.className, parent: iface, type: 'implements' });
                                          }
                                      }
                                  }
                              } catch (e) {
                                  // console.error(`Failed to parse ${entry.fileName}`, e);
                              }
                              zipfile.readEntry();
                          });
                      });
                  } else {
                      zipfile.readEntry();
                  }
              });

              zipfile.on('end', () => {
                  // Batch insert classes
                  try {
                      db.transaction(() => {
                          const insertClass = db.prepare(`
                              INSERT INTO classes_fts (artifact_id, class_name, simple_name)
                              VALUES (?, ?, ?)
                          `);
                          const insertInheritance = db.prepare(`
                              INSERT INTO inheritance (artifact_id, class_name, parent_class_name, type)
                              VALUES (?, ?, ?, ?)
                          `);

                          for (const cls of classes) {
                              const simpleName = cls.split('.').pop() || cls;
                              insertClass.run(artifact.id, cls, simpleName);
                          }

                          for (const item of inheritance) {
                              insertInheritance.run(artifact.id, item.className, item.parent, item.type);
                          }

                          // Mark as indexed
                          db.prepare('UPDATE artifacts SET is_indexed = 1 WHERE id = ?').run(artifact.id);
                      });
                  } catch (e) {
                      console.error(`Failed to insert classes for ${artifact.groupId}:${artifact.artifactId}`, e);
                  }
                  resolve();
              });

              zipfile.on('error', () => {
                  resolve();
              });
          });
      });
  }

  /**
   * Checks if a class package is included in the configuration patterns.
   */
  private isPackageIncluded(className: string, patterns: string[]): boolean {
    if (patterns.length === 0 || (patterns.length === 1 && patterns[0] === '*')) return true;
    for (const pattern of patterns) {
        if (pattern === '*') return true;
        if (pattern.endsWith('.*')) {
            const prefix = pattern.slice(0, -2); // "com.example"
            // Match exact package or subpackage
            if (className === prefix || className.startsWith(prefix + '.')) return true;
        } else {
            // Exact match
            if (className === pattern) return true;
        }
    }
    return false;
  }

  /**
   * Searches for artifacts by group ID or artifact ID.
   */
  public search(query: string): Artifact[] {
      // Artifact coordinates search
      const db = DB.getInstance();
      const rows = db.prepare(`
          SELECT id, group_id as groupId, artifact_id as artifactId, version, abspath, has_source as hasSource
          FROM artifacts
          WHERE group_id LIKE ? OR artifact_id LIKE ?
          LIMIT 50
      `).all(`%${query}%`, `%${query}%`) as Artifact[];
      return rows;
  }

  /**
   * Searches for classes matching the pattern.
   * Uses Full-Text Search (FTS) for efficient matching.
   */
  public searchClass(classNamePattern: string): { className: string, artifacts: Artifact[] }[] {
      const db = DB.getInstance();
      
      try {
          let rows: any[] = [];

          if (classNamePattern.startsWith('regex:')) {
              // Regex search
              const regex = classNamePattern.substring(6);
              rows = db.prepare(`
                  SELECT c.class_name, c.simple_name, a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source
                  FROM classes_fts c
                  JOIN artifacts a ON c.artifact_id = a.id
                  WHERE c.class_name REGEXP ? OR c.simple_name REGEXP ?
                  LIMIT 100
              `).all(regex, regex) as any[];

          } else if (classNamePattern.includes('*') || classNamePattern.includes('?')) {
              // Glob-style search (using LIKE for standard wildcards)
              // Convert glob wildcards to SQL wildcards if needed, or just rely on user knowing %/_
              // But standard glob is * and ?
              const likePattern = classNamePattern.replace(/\*/g, '%').replace(/\?/g, '_');
              
              rows = db.prepare(`
                  SELECT c.class_name, c.simple_name, a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source
                  FROM classes_fts c
                  JOIN artifacts a ON c.artifact_id = a.id
                  WHERE c.class_name LIKE ? OR c.simple_name LIKE ?
                  LIMIT 100
              `).all(likePattern, likePattern) as any[];

          } else {
              // Use FTS for smart matching
              // If pattern has no spaces, we assume it's a prefix or exact match query
              // "String" -> match "String" in simple_name or class_name
              
              const escapedPattern = classNamePattern.replace(/"/g, '""');
              const safeQuery = classNamePattern.replace(/[^a-zA-Z0-9]/g, ' ').trim();
              const query = safeQuery.length > 0 
                  ? `"${escapedPattern}"* OR ${safeQuery}`
                  : `"${escapedPattern}"*`;

              rows = db.prepare(`
                  SELECT c.class_name, c.simple_name, a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source
                  FROM classes_fts c
                  JOIN artifacts a ON c.artifact_id = a.id
                  WHERE c.classes_fts MATCH ?
                  ORDER BY rank
                  LIMIT 100
              `).all(query) as any[];
          }

          // Group by class name
          const resultMap = new Map<string, Artifact[]>();
          for (const row of rows) {
              const art: Artifact = {
                  id: row.id,
                  groupId: row.group_id,
                  artifactId: row.artifact_id,
                  version: row.version,
                  abspath: row.abspath,
                  hasSource: Boolean(row.has_source)
              };
              
              if (!resultMap.has(row.class_name)) {
                  resultMap.set(row.class_name, []);
              }
              resultMap.get(row.class_name)!.push(art);
          }

          return Array.from(resultMap.entries()).map(([className, artifacts]) => ({
              className,
              artifacts
          }));

      } catch (e) {
          console.error("Search failed", e);
          return [];
      }
  }

  /**
   * Searches for implementations/subclasses of a specific class/interface.
   */
  public searchImplementations(className: string): { className: string, artifacts: Artifact[] }[] {
      const db = DB.getInstance();
      try {
          console.error(`Searching implementations for ${className}...`);
          
          // Debug: Check if we have any inheritance data at all
          const count = db.prepare("SELECT count(*) as c FROM inheritance").get() as {c: number};
          if (count.c === 0) {
             console.error("WARNING: Inheritance table is empty!");
          }

          // Recursive search for all implementations/subclasses
          const rows = db.prepare(`
              WITH RECURSIVE hierarchy(class_name, artifact_id) AS (
                SELECT class_name, artifact_id FROM inheritance WHERE parent_class_name = ?
                UNION
                SELECT i.class_name, i.artifact_id FROM inheritance i JOIN hierarchy h ON i.parent_class_name = h.class_name
              )
              SELECT DISTINCT h.class_name, a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source
              FROM hierarchy h
              JOIN artifacts a ON h.artifact_id = a.id
              LIMIT 100
          `).all(className) as any[];

          console.error(`Searching implementations for ${className}: found ${rows.length} rows.`);

          if (rows.length === 0) {
             // Fallback: Try searching without recursion to see if direct children exist
             const direct = db.prepare('SELECT count(*) as c FROM inheritance WHERE parent_class_name = ?').get(className) as {c: number};
             console.error(`Direct implementations check for ${className}: ${direct.c}`);
          }

          const resultMap = new Map<string, Artifact[]>();
          for (const row of rows) {
              const art: Artifact = {
                  id: row.id,
                  groupId: row.group_id,
                  artifactId: row.artifact_id,
                  version: row.version,
                  abspath: row.abspath,
                  hasSource: Boolean(row.has_source)
              };
              
              if (!resultMap.has(row.class_name)) {
                  resultMap.set(row.class_name, []);
              }
              resultMap.get(row.class_name)!.push(art);
          }

          return Array.from(resultMap.entries()).map(([className, artifacts]) => ({
              className,
              artifacts
          }));

      } catch (e) {
          console.error("Search implementations failed", e);
          return [];
      }
  }

  /**
   * Retrieves an artifact by its database ID.
   */
  public getArtifactById(id: number): Artifact | undefined {
      const db = DB.getInstance();
      const row = db.prepare(`
          SELECT id, group_id as groupId, artifact_id as artifactId, version, abspath, has_source as hasSource
          FROM artifacts WHERE id = ?
      `).get(id) as any;
      
      if (row) {
          return {
              id: row.id,
              groupId: row.groupId,
              artifactId: row.artifactId,
              version: row.version,
              abspath: row.abspath,
              hasSource: Boolean(row.hasSource)
          };
      }
      return undefined;
  }

  /**
   * Retrieves an artifact by its Maven coordinate.
   */
  public getArtifactByCoordinate(groupId: string, artifactId: string, version: string): Artifact | undefined {
      const db = DB.getInstance();
      const row = db.prepare(`
          SELECT id, group_id as groupId, artifact_id as artifactId, version, abspath, has_source as hasSource
          FROM artifacts 
          WHERE group_id = ? AND artifact_id = ? AND version = ?
      `).get(groupId, artifactId, version) as any;
      
      if (row) {
          return {
              id: row.id,
              groupId: row.groupId,
              artifactId: row.artifactId,
              version: row.version,
              abspath: row.abspath,
              hasSource: Boolean(row.hasSource)
          };
      }
      return undefined;
  }
}
