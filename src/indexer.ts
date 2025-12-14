import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import yauzl from 'yauzl';
import chokidar from 'chokidar';
import { FSWatcher } from 'chokidar';
import { Config } from './config.js';
import { DB } from './db/index.js';

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
   * Main indexing process.
   * 1. Scans the file system for Maven artifacts.
   * 2. Synchronizes the database with found artifacts.
   * 3. Indexes classes for artifacts that haven't been indexed yet.
   */
  public async index() {
    if (this.isIndexing) return;
    this.isIndexing = true;
    console.error("Starting index...");
    const config = await Config.getInstance();
    const repoPath = config.localRepository;
    const db = DB.getInstance();

    if (!repoPath) {
        console.error("No local repository path found.");
        this.isIndexing = false;
        return;
    }

    try {
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

              zipfile.readEntry();

              zipfile.on('entry', (entry) => {
                  if (entry.fileName.endsWith('.class')) {
                      // Convert path/to/MyClass.class -> path.to.MyClass
                      const className = entry.fileName.slice(0, -6).replace(/\//g, '.');
                      // Simple check to avoid module-info or invalid names
                      if (!className.includes('$') && className.length > 0) {
                          // Filter by includedPackages
                          if (this.isPackageIncluded(className, config.includedPackages)) {
                              classes.push(className);
                          }
                      }
                  }
                  zipfile.readEntry();
              });

              zipfile.on('end', () => {
                  // Batch insert classes
                  try {
                      db.transaction(() => {
                          const insertClass = db.prepare(`
                              INSERT INTO classes_fts (artifact_id, class_name, simple_name)
                              VALUES (?, ?, ?)
                          `);
                          for (const cls of classes) {
                              const simpleName = cls.split('.').pop() || cls;
                              insertClass.run(artifact.id, cls, simpleName);
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
      
      // Use FTS for smart matching
      // If pattern has no spaces, we assume it's a prefix or exact match query
      // "String" -> match "String" in simple_name or class_name
      
      const escapedPattern = classNamePattern.replace(/"/g, '""');
      const safeQuery = classNamePattern.replace(/[^a-zA-Z0-9]/g, ' ').trim();
      const query = safeQuery.length > 0 
          ? `"${escapedPattern}"* OR ${safeQuery}`
          : `"${escapedPattern}"*`;

      try {
          const rows = db.prepare(`
              SELECT c.class_name, c.simple_name, a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source
              FROM classes_fts c
              JOIN artifacts a ON c.artifact_id = a.id
              WHERE c.classes_fts MATCH ?
              ORDER BY rank
              LIMIT 100
          `).all(query) as any[];

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
}
