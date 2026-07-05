import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import yauzl from 'yauzl';
import chokidar from 'chokidar';
import { FSWatcher } from 'chokidar';
import { Config } from './config.js';
import { DB } from './db/index.js';
import { ClassParser } from './class_parser.js';
import { ProtoParser } from './proto_parser.js';
import { PomParser } from './pom_parser.js';
import {
    Layout,
    resolveMainJar,
    selectMainJar,
} from './path_helpers.js';
import { escapeLike, likeContains, buildFtsQuery, compileUserRegex } from './sql_helpers.js';

export interface Artifact {
    id: number;
    groupId: string;
    artifactId: string;
    version: string;
    abspath: string;
    hasSource: boolean;
    layout?: Layout | null;
}

/** Raw snake_case row shape returned by artifact-selecting queries. */
interface ArtifactRow {
    id: number;
    group_id: string;
    artifact_id: string;
    version: string;
    abspath: string;
    has_source: number;
    layout?: string | null;
}

interface ClassRow {
    class_name: string;
    simple_name: string;
    id: number;
    group_id: string;
    artifact_id: string;
    version: string;
    abspath: string;
    has_source: number;
    layout?: string | null;
}

interface ResourceRow {
    path: string;
    id: number;
    group_id: string;
    artifact_id: string;
    version: string;
    abspath: string;
    has_source: number;
    layout?: string | null;
}

interface MethodRow {
    method_name: string;
    class_name: string;
    id: number;
    group_id: string;
    artifact_id: string;
    version: string;
    abspath: string;
    has_source: number;
    layout?: string | null;
}

/**
 * Singleton class responsible for indexing Maven artifacts.
 * It scans the local repository, watches for changes, and indexes Java classes.
 */
export class Indexer {
    private static instance: Indexer;
    private isIndexing: boolean = false;
    /** Coalesces watcher/scheduler events that arrive while a pass is running. */
    private pendingReindex: boolean = false;
    private watcher: FSWatcher | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private scheduleTimer: NodeJS.Timeout | null = null;
    /** When true, indexArtifactClasses writes into `_new` shadow tables. */
    private shadowMode: boolean = false;

    private constructor() {
    }

    public static getInstance(): Indexer {
        if (!Indexer.instance) {
            Indexer.instance = new Indexer();
        }
        return Indexer.instance;
    }

    /** Returns the active table name (with `_new` suffix when in shadow mode). */
    private tableName(base: string): string {
        return this.shadowMode ? `${base}_new` : base;
    }

    /** Single row-to-Artifact mapper used by every artifact-returning query. */
    private mapArtifact(row: ArtifactRow | ClassRow | ResourceRow): Artifact {
        return {
            id: row.id,
            groupId: row.group_id,
            artifactId: row.artifact_id,
            version: row.version,
            abspath: row.abspath,
            hasSource: Boolean(row.has_source),
            layout: (row.layout as Layout | null | undefined) ?? null,
        };
    }

    /** Groups class rows by class_name, dedup by groupId:artifactId (keep first seen). */
    private groupByArtifact(rows: ClassRow[]): { className: string; artifacts: Artifact[] }[] {
        const resultMap = new Map<string, Artifact[]>();
        for (const row of rows) {
            const art = this.mapArtifact(row);
            if (!resultMap.has(row.class_name)) {
                resultMap.set(row.class_name, []);
            }
            const artifacts = resultMap.get(row.class_name)!;
            const key = `${art.groupId}:${art.artifactId}`;
            if (!artifacts.some(a => `${a.groupId}:${a.artifactId}` === key)) {
                artifacts.push(art);
            }
        }
        return Array.from(resultMap.entries()).map(([className, artifacts]) => ({
            className,
            artifacts,
        }));
    }

    /** Groups method rows by method_name + class_name, dedup by groupId:artifactId. */
    private groupByMethod(rows: MethodRow[]): { methodName: string; className: string; artifacts: Artifact[] }[] {
        const resultMap = new Map<string, { methodName: string; className: string; artifacts: Artifact[] }>();
        for (const row of rows) {
            const key = `${row.method_name}\u0000${row.class_name}`;
            if (!resultMap.has(key)) {
                resultMap.set(key, { methodName: row.method_name, className: row.class_name, artifacts: [] });
            }
            const entry = resultMap.get(key)!;
            const art = this.mapArtifact(row);
            const artKey = `${art.groupId}:${art.artifactId}`;
            if (!entry.artifacts.some(a => `${a.groupId}:${a.artifactId}` === artKey)) {
                entry.artifacts.push(art);
            }
        }
        return Array.from(resultMap.values());
    }

    /**
     * Starts watching the local repository for changes.
     */
    public async startWatch() {
        const config = await Config.getInstance();
        const watchPaths = [];

        // Simple: Just add the main repository paths
        if (config.localRepository && fsSync.existsSync(config.localRepository)) {
            watchPaths.push(config.localRepository);
        }

        if (config.gradleRepository && fsSync.existsSync(config.gradleRepository)) {
            watchPaths.push(config.gradleRepository);
        }

        if (watchPaths.length === 0) {
            console.error("No repository paths found, skipping watch mode.");
            return;
        }

        if (this.watcher) {
            return;
        }

        console.error(`🔍 Starting file watcher on: ${watchPaths.join(', ')}`);

        try {
            // Use glob patterns to watch specific files
            const toGlobPath = (p: string) => p.split(path.sep).join('/');
            const watchPatterns = watchPaths.flatMap(p => [
                `${toGlobPath(p)}/**/*.jar`,
                `${toGlobPath(p)}/**/*.pom`
            ]);

            this.watcher = chokidar.watch(watchPatterns, {
                // Ignore dotfiles and specific directories
                ignored: /(^|[\/\\])\.|node_modules|target|build/,
                persistent: true,
                ignoreInitial: true,
                awaitWriteFinish: {
                    stabilityThreshold: 2000,
                    pollInterval: 100
                },
                ignorePermissionErrors: true
            });

            // Watch for file additions and changes.
            // Directory events are logged but do not trigger a reindex (T3.2):
            // directory creation/removal is always accompanied by file events,
            // and acting on dir events alone causes spurious reindexes.
            this.watcher
                .on('add', (filePath) => {
                    if (filePath.endsWith('.jar') || filePath.endsWith('.pom')) {
                        console.error(`📄 New file detected: ${path.basename(filePath)}`);
                        this.triggerReindex();
                    }
                })
                .on('addDir', (dirPath) => {
                    console.error(`📁 New directory detected: ${path.basename(dirPath)}`);
                })
                .on('unlink', (filePath) => {
                    if (filePath.endsWith('.jar') || filePath.endsWith('.pom')) {
                        console.error(`🗑️ File removed: ${path.basename(filePath)}`);
                        this.triggerReindex();
                    }
                })
                .on('unlinkDir', (dirPath) => {
                    console.error(`🗑️ Directory removed: ${path.basename(dirPath)}`);
                })
                .on('error', (error: unknown) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    console.error(`❌ Watcher error: ${errorMessage}`);
                });

            console.error('✅ File watcher started successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`❌ Failed to start watcher: ${errorMessage}`);
        }
    }

    /**
     * Starts a scheduled job to reindex every 1 hour.
     */
    public startSchedule() {
        if (this.scheduleTimer) {
            return;
        }

        console.error('⏰ Starting scheduled reindex job (every 1 hour)...');

        this.scheduleTimer = setInterval(() => {
            console.error('⏰ Scheduled reindex triggered...');
            this.index().catch(console.error);
        }, 3600000); // 1 hour
    }

    /**
     * Trigger reindexing with debouncing (wait a bit for multiple changes)
     * @param debounceSeconds - debounce delay in seconds (default: 3)
     */
    public triggerReindex(debounceSeconds: number = 3) {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            console.error('🔄 Changes detected - triggering reindex...');
            this.index().catch(console.error);
        }, debounceSeconds * 1000);
    }

    /**
     * Stops the file watcher and clears any pending debounce timer (T3.5).
     * Safe to call when no watcher is active.
     */
    public async stopWatch() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            console.error('⏹️ Stopping file watcher...');
            await this.watcher.close();
            this.watcher = null;
            console.error('✅ File watcher stopped.');
        }
    }

    /**
     * Stops the scheduled reindex job (T3.5).
     * Safe to call when no schedule is active.
     */
    public stopSchedule() {
        if (this.scheduleTimer) {
            console.error('⏹️ Stopping scheduled reindex job...');
            clearInterval(this.scheduleTimer);
            this.scheduleTimer = null;
            console.error('✅ Scheduled reindex job stopped.');
        }
    }

    /**
     * Forces a full re-index of the repository using shadow tables.
     * Builds into `_new` tables, then atomically swaps on success.
     * On failure, old index is left untouched.
     */
    public async refresh() {
        const db = DB.getInstance();
        console.error("Refreshing index (shadow-table mode)...");

        // 1. Create shadow tables
        db.exec(`
            DROP TABLE IF EXISTS classes_fts_new;
            CREATE VIRTUAL TABLE classes_fts_new USING fts5(artifact_id UNINDEXED, class_name, simple_name, tokenize="trigram");
            DROP TABLE IF EXISTS inheritance_new;
            CREATE TABLE inheritance_new (id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id INTEGER NOT NULL, class_name TEXT NOT NULL, parent_class_name TEXT NOT NULL, type TEXT NOT NULL);
            DROP TABLE IF EXISTS resources_new;
            CREATE TABLE resources_new (id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id INTEGER NOT NULL, path TEXT NOT NULL, content TEXT, type TEXT);
            DROP TABLE IF EXISTS resource_classes_new;
            CREATE TABLE resource_classes_new (id INTEGER PRIMARY KEY AUTOINCREMENT, resource_id INTEGER NOT NULL, class_name TEXT NOT NULL);
            DROP TABLE IF EXISTS methods_new;
            CREATE TABLE methods_new (id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id INTEGER NOT NULL, class_name TEXT NOT NULL, method_name TEXT NOT NULL, descriptor TEXT, UNIQUE(artifact_id, class_name, method_name, descriptor));
            DROP TABLE IF EXISTS dependencies_new;
            CREATE TABLE dependencies_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                artifact_id INTEGER NOT NULL,
                dep_group_id TEXT NOT NULL,
                dep_artifact_id TEXT NOT NULL,
                dep_version TEXT,
                scope TEXT,
                optional INTEGER DEFAULT 0,
                FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
            );
        `);
        db.prepare('UPDATE artifacts SET is_indexed = 0').run();

        try {
            await this.index({ shadow: true });

            // 2. Atomic swap
            db.transaction(() => {
                db.exec('DROP TABLE classes_fts');
                db.exec('ALTER TABLE classes_fts_new RENAME TO classes_fts');
                db.exec('DROP TABLE inheritance');
                db.exec('ALTER TABLE inheritance_new RENAME TO inheritance');
                db.exec('DROP TABLE resources');
                db.exec('ALTER TABLE resources_new RENAME TO resources');
                db.exec('DROP TABLE resource_classes');
                db.exec('ALTER TABLE resource_classes_new RENAME TO resource_classes');
                db.exec('DROP TABLE IF EXISTS methods');
                db.exec('ALTER TABLE methods_new RENAME TO methods');
                db.exec('DROP TABLE IF EXISTS dependencies');
                db.exec('ALTER TABLE dependencies_new RENAME TO dependencies');
                db.exec('CREATE INDEX IF NOT EXISTS idx_inheritance_parent ON inheritance(parent_class_name)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_resources_artifact ON resources(artifact_id)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_resource_classes_class ON resource_classes(class_name)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_methods_name ON methods(method_name)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_methods_class ON methods(class_name)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_dependencies_artifact ON dependencies(artifact_id)');
                db.exec('CREATE INDEX IF NOT EXISTS idx_dependencies_dep ON dependencies(dep_group_id, dep_artifact_id)');
                db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_at', ?)").run(new Date().toISOString());
            });
            console.error("Shadow-table swap complete.");
        } catch (e) {
            // 3. Cleanup shadow tables; old index untouched
            console.error("Refresh failed, cleaning up shadow tables...", e);
            db.exec(`
                DROP TABLE IF EXISTS classes_fts_new;
                DROP TABLE IF EXISTS inheritance_new;
                DROP TABLE IF EXISTS resources_new;
                DROP TABLE IF EXISTS resource_classes_new;
                DROP TABLE IF EXISTS methods_new;
                DROP TABLE IF EXISTS dependencies_new;
            `);
            throw e;
        }
    }

    /**
     * Main indexing process.
     * 1. Scans the file system for Maven artifacts.
     * 2. Synchronizes the database with found artifacts.
     * 3. Indexes classes for artifacts that haven't been indexed yet.
     */
    public async index(opts: { shadow?: boolean } = {}) {
        if (this.isIndexing) {
            // Coalesce: queue at most one follow-up pass (T3.1).
            this.pendingReindex = true;
            return;
        }
        this.isIndexing = true;
        this.shadowMode = opts.shadow ?? false;
        console.error("Starting index...");

        try {
            const config = await Config.getInstance();
            const repoPath = config.localRepository;
            const gradleRepoPath = config.gradleRepository;
            const db = DB.getInstance();

            if (!repoPath && !gradleRepoPath) {
                console.error("No repository path found.");
                return;
            }

            // 1. Scan for artifacts
            console.error("Scanning repository structure...");
            let artifacts: Artifact[] = [];

            if (repoPath && fsSync.existsSync(repoPath)) {
                console.error(`Scanning Maven repo: ${repoPath}`);
                const mavenArtifacts = await this.scanRepository(repoPath, config.normalizedIncludedPackages);
                console.error(`Found ${mavenArtifacts.length} Maven artifacts.`);
                artifacts = artifacts.concat(mavenArtifacts);
            }

            if (gradleRepoPath && fsSync.existsSync(gradleRepoPath)) {
                console.error(`Scanning Gradle repo: ${gradleRepoPath}`);
                const gradleArtifacts = await this.scanGradleRepository(gradleRepoPath, config.normalizedIncludedPackages);
                console.error(`Found ${gradleArtifacts.length} Gradle artifacts.`);
                artifacts = artifacts.concat(gradleArtifacts);
            }

            console.error(`Found ${artifacts.length} total artifacts on disk.`);

            // 2. Persist artifacts and determine what needs indexing
            // We use is_indexed = 0 for new artifacts.
            const insertArtifact = db.prepare(`
                INSERT
                OR IGNORE INTO artifacts (group_id, artifact_id, version, abspath, has_source, is_indexed, layout)
                VALUES (@groupId, @artifactId, @version, @abspath, @hasSource, 0, @layout)
            `);

            // Use a transaction only for the batch insert of artifacts
            db.transaction(() => {
                for (const art of artifacts) {
                    insertArtifact.run({
                        groupId: art.groupId,
                        artifactId: art.artifactId,
                        version: art.version,
                        abspath: art.abspath,
                        hasSource: art.hasSource ? 1 : 0,
                        layout: art.layout ?? null
                    });
                }
            });

            // Check if we need to backfill inheritance data (legacy migration path).
            // In shadow mode this check is naturally skipped (indexedArtifactsCount is 0).
            const inheritanceTable = this.tableName('inheritance');
            const inheritanceCount = db.prepare(`SELECT COUNT(*) as count FROM ${inheritanceTable}`).get() as { count: number };
            const indexedArtifactsCount = db.prepare('SELECT COUNT(*) as count FROM artifacts WHERE is_indexed = 1').get() as {
                count: number
            };

            if (inheritanceCount.count === 0 && indexedArtifactsCount.count > 0) {
                console.error("Detected missing inheritance data. Forcing re-index of classes...");
                db.transaction(() => {
                    db.prepare('UPDATE artifacts SET is_indexed = 0').run();
                    db.prepare(`DELETE FROM ${this.tableName('classes_fts')}`).run();
                    // inheritance is already empty
                });
            }

            // Incremental indexing logic (non-shadow path only).
            // In shadow mode, refresh() has already reset is_indexed=0 for all
            // artifacts and we're rebuilding into _new tables, so mtime-based
            // skipping and pruning don't apply.
            if (!this.shadowMode) {
                // Determine if a full scan is needed based on last_full_scan timestamp.
                const fullScanIntervalHours = parseInt(process.env.MAVEN_INDEXER_FULL_SCAN_INTERVAL_HOURS || '24', 10);
                const lastFullScanRow = db.prepare("SELECT value FROM meta WHERE key = 'last_full_scan'").get() as { value: string } | undefined;
                const needsFullScan = !lastFullScanRow || (Date.now() - new Date(lastFullScanRow.value).getTime()) > fullScanIntervalHours * 3600 * 1000;

                if (needsFullScan) {
                    console.error("Performing full scan (mtime-based incremental skipped)...");
                    db.transaction(() => {
                        db.prepare('UPDATE artifacts SET is_indexed = 0').run();
                        db.exec('DELETE FROM artifact_dir_mtimes');
                    });
                } else {
                    // Incremental: stat each artifact dir, compare mtime, mark changed for re-index.
                    console.error("Performing incremental scan (mtime-based)...");
                    const allArtifacts = db.prepare('SELECT id, abspath, layout, is_indexed FROM artifacts').all() as { id: number; abspath: string; layout: string | null; is_indexed: number }[];
                    const getMtimeStmt = db.prepare('SELECT mtime FROM artifact_dir_mtimes WHERE artifact_id = ?');
                    const setMtimeStmt = db.prepare('INSERT OR REPLACE INTO artifact_dir_mtimes (artifact_id, dir_path, mtime) VALUES (?, ?, ?)');
                    const markForIndexStmt = db.prepare('UPDATE artifacts SET is_indexed = 0 WHERE id = ?');

                    for (const art of allArtifacts) {
                        const dirPath = art.layout === 'gradle' ? path.dirname(art.abspath) : art.abspath;
                        try {
                            const stat = fsSync.statSync(dirPath);
                            const existing = getMtimeStmt.get(art.id) as { mtime: number } | undefined;
                            if (art.is_indexed === 1 && existing && existing.mtime === stat.mtimeMs) {
                                // Unchanged, skip.
                            } else {
                                // Changed or new, mark for indexing.
                                if (art.is_indexed === 1) {
                                    markForIndexStmt.run(art.id);
                                }
                                setMtimeStmt.run(art.id, dirPath, stat.mtimeMs);
                            }
                        } catch {
                            // Directory doesn't exist — will be pruned below.
                        }
                    }
                }

                // Prune artifacts whose main JAR no longer exists on disk.
                const allArtifactsForPrune = db.prepare('SELECT id, artifact_id, version, abspath, layout FROM artifacts').all() as { id: number; artifact_id: string; version: string; abspath: string; layout: string | null }[];
                const artifactsToDelete: number[] = [];
                for (const art of allArtifactsForPrune) {
                    const artifactLike = { abspath: art.abspath, artifactId: art.artifact_id, version: art.version, layout: art.layout as Layout | null };
                    const mainJar = resolveMainJar(artifactLike);
                    if (!fsSync.existsSync(mainJar)) {
                        artifactsToDelete.push(art.id);
                    }
                }
                if (artifactsToDelete.length > 0) {
                    console.error(`Pruning ${artifactsToDelete.length} artifacts with missing JARs...`);
                    db.transaction(() => {
                        const deleteArtifactsStmt = db.prepare('DELETE FROM artifacts WHERE id = ?');
                        const deleteClassesStmt = db.prepare('DELETE FROM classes_fts WHERE artifact_id = ?');
                        const deleteInheritanceStmt = db.prepare('DELETE FROM inheritance WHERE artifact_id = ?');
                        const deleteResourcesStmt = db.prepare('DELETE FROM resources WHERE artifact_id = ?');
                        const deleteResourceClassesStmt = db.prepare('DELETE FROM resource_classes WHERE resource_id IN (SELECT id FROM resources WHERE artifact_id = ?)');
                        const deleteMtimesStmt = db.prepare('DELETE FROM artifact_dir_mtimes WHERE artifact_id = ?');
                        for (const id of artifactsToDelete) {
                            deleteResourceClassesStmt.run(id);
                            deleteResourcesStmt.run(id);
                            deleteClassesStmt.run(id);
                            deleteInheritanceStmt.run(id);
                            deleteMtimesStmt.run(id);
                            deleteArtifactsStmt.run(id);
                        }
                    });
                }
            }

            // 3. Find artifacts that need indexing (is_indexed = 0)
            const artifactsToIndex = db.prepare(`
                SELECT id, group_id as groupId, artifact_id as artifactId, version, abspath, has_source as hasSource, layout
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

                // Record directory mtimes for indexed artifacts (non-shadow path only).
                if (!this.shadowMode) {
                    db.transaction(() => {
                        const setMtimeStmt = db.prepare('INSERT OR REPLACE INTO artifact_dir_mtimes (artifact_id, dir_path, mtime) VALUES (?, ?, ?)');
                        for (const artifact of chunk) {
                            const dirPath = artifact.layout === 'gradle' ? path.dirname(artifact.abspath) : artifact.abspath;
                            try {
                                const stat = fsSync.statSync(dirPath);
                                setMtimeStmt.run(artifact.id, dirPath, stat.mtimeMs);
                            } catch {
                                // Directory doesn't exist — skip (will be pruned on next pass).
                            }
                        }
                    });
                }

                if (processedCount % 100 === 0) {
                    console.error(`Processed ${processedCount}/${artifactsToIndex.length} artifacts...`);
                }
            }

            // Record last_indexed_at and last_full_scan on success (non-shadow path only;
            // shadow path records them inside the refresh() swap transaction).
            if (!this.shadowMode) {
                const now = new Date().toISOString();
                db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_at', ?)").run(now);
                db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_full_scan', ?)").run(now);
            }

            console.error(`Indexing complete.`);
        } catch (e) {
            console.error("Indexing failed", e);
            throw e; // propagate to caller
        } finally {
            this.isIndexing = false;
            this.shadowMode = false;
            // Drain a coalesced reindex request (T3.1). Only one follow-up
            // pass runs regardless of how many events arrived during indexing.
            if (this.pendingReindex) {
                this.pendingReindex = false;
                // Fire-and-forget; errors are logged inside index().
                this.index().catch(e => console.error("Pending reindex failed", e));
            }
        }
    }

    /**
     * Recursively scans a directory for Maven artifacts (POM files).
     *
     * @param repoRoot The root directory of the Maven repository.
     * @param normalizedPatterns List of normalized package patterns to include.
     */
    private async scanRepository(repoRoot: string, normalizedPatterns: string[] = []): Promise<Artifact[]> {
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

                const relGroupPath = path.relative(repoRoot, groupDir);
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
                        hasSource,
                        layout: 'maven'
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

        const startDirs = this.getMavenStartDirs(repoRoot, normalizedPatterns);
        console.error(`Scanning Maven directories: ${startDirs.join(', ')}`);

        for (const startDir of startDirs) {
            await scanDir(startDir);
        }
        return results;
    }

    /**
     * Calculates the starting directories for Maven scanning based on included packages.
     *
     * @param repoRoot The root of the Maven repository.
     * @param normalizedPatterns The list of normalized included packages.
     */
    private getMavenStartDirs(repoRoot: string, normalizedPatterns: string[]): string[] {
        if (normalizedPatterns.length === 0) {
            return [repoRoot];
        }

        return normalizedPatterns.map(p => path.join(repoRoot, p.split('.').join(path.sep)));
    }

    /**
     * Checks if a group ID is included in the normalized patterns.
     *
     * @param groupId The group ID (e.g., "com.google.guava").
     * @param normalizedPatterns The list of normalized patterns.
     */
    private isGroupIncluded(groupId: string, normalizedPatterns: string[]): boolean {
        if (!normalizedPatterns || normalizedPatterns.length === 0) return true;

        for (const pattern of normalizedPatterns) {
            if (groupId === pattern || groupId.startsWith(pattern + '.')) {
                return true;
            }
        }
        return false;
    }

    /**
     * Scans a Gradle cache directory for artifacts.
     * Structure: group/artifact/version/hash/file
     *
     * @param rootDir The root directory of the Gradle cache (e.g., ~/.gradle/caches/modules-2/files-2.1).
     * @param normalizedPatterns List of normalized package patterns to include.
     */
    private async scanGradleRepository(rootDir: string, normalizedPatterns: string[] = []): Promise<Artifact[]> {
        const results: Artifact[] = [];

        // Helper to read directory safely
        const readDirSafe = async (p: string) => {
            try {
                return await fs.readdir(p, { withFileTypes: true });
            } catch (e) {
                return [];
            }
        };

        const groupDirs = await readDirSafe(rootDir);
        for (const groupEntry of groupDirs) {
            if (!groupEntry.isDirectory()) continue;
            const groupId = groupEntry.name;

            if (!this.isGroupIncluded(groupId, normalizedPatterns)) {
                continue;
            }

            const groupPath = path.join(rootDir, groupId);

            const artifactDirs = await readDirSafe(groupPath);
            for (const artifactEntry of artifactDirs) {
                if (!artifactEntry.isDirectory()) continue;
                const artifactId = artifactEntry.name;
                const artifactPath = path.join(groupPath, artifactId);

                const versionDirs = await readDirSafe(artifactPath);
                for (const versionEntry of versionDirs) {
                    if (!versionEntry.isDirectory()) continue;
                    const version = versionEntry.name;
                    const versionPath = path.join(artifactPath, version);

                    const hashDirs = await readDirSafe(versionPath);
                    let jarPath: string | null = null;
                    let hasSource = false;

                    // Collect all JAR filenames across hash dirs; pick the main JAR
                    // deterministically via selectMainJar (skips -sources/-javadoc/-tests).
                    const allJarNames: string[] = [];
                    const hashPathByName = new Map<string, string>();

                    for (const hashEntry of hashDirs) {
                        if (!hashEntry.isDirectory()) continue;
                        const hashPath = path.join(versionPath, hashEntry.name);
                        const files = await readDirSafe(hashPath);

                        for (const file of files) {
                            if (file.isFile() && file.name.endsWith('.jar')) {
                                if (file.name.endsWith('-sources.jar')) {
                                    hasSource = true;
                                }
                                allJarNames.push(file.name);
                                hashPathByName.set(file.name, hashPath);
                            }
                        }
                    }

                    const mainJarName = selectMainJar(allJarNames, artifactId, version);
                    if (mainJarName) {
                        jarPath = path.join(hashPathByName.get(mainJarName)!, mainJarName);
                    }

                    if (jarPath) {
                        results.push({
                            id: 0, // Placeholder
                            groupId,
                            artifactId,
                            version,
                            abspath: jarPath, // Full path to JAR
                            hasSource,
                            layout: 'gradle'
                        });
                    }
                }
            }
        }
        return results;
    }

    /**
     * Extracts classes from the artifact's JAR and indexes them.
     * Updates the 'is_indexed' flag upon completion.
     */
    private async indexArtifactClasses(artifact: Artifact): Promise<void> {
        const jarPath = resolveMainJar(artifact);
        const db = DB.getInstance();
        const config = await Config.getInstance();
        const warnedTags = new Set<number>();

        try {
            await fs.access(jarPath);
        } catch {
            // If jar missing, mark as indexed so we don't retry endlessly?
            // Or maybe it's a pom-only artifact.
            db.prepare('UPDATE artifacts SET is_indexed = 1 WHERE id = ?').run(artifact.id);
            return;
        }

        await new Promise<void>((resolve) => {
            yauzl.open(jarPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
                if (err || !zipfile) {
                    // Mark as indexed so a corrupt/unreadable JAR is not retried every scan.
                    db.prepare('UPDATE artifacts SET is_indexed = 1 WHERE id = ?').run(artifact.id);
                    console.error(`⚠️ Marking artifact ${artifact.groupId}:${artifact.artifactId}:${artifact.version} as indexed (corrupt/unreadable JAR: ${err ? err.message : 'no zipfile'})`);
                    resolve();
                    return;
                }

                const classes: string[] = [];
                const inheritance: { className: string, parent: string, type: 'extends' | 'implements' }[] = [];
                const resources: { path: string, content: string, type: string, protoInfo?: any }[] = [];
                const methodData: { className: string, methods: string[] }[] = [];

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
                                    if (!info.className.includes('$') && info.className.length > 0) {
                                        if (this.isPackageIncluded(info.className, config.normalizedIncludedPackages)) {
                                            classes.push(info.className);
                                            methodData.push({ className: info.className, methods: info.methods ?? [] });
                                            if (info.superClass && info.superClass !== 'java.lang.Object') {
                                                inheritance.push({ className: info.className, parent: info.superClass, type: 'extends' });
                                            }
                                            for (const iface of info.interfaces) {
                                                inheritance.push({ className: info.className, parent: iface, type: 'implements' });
                                            }
                                        }
                                    }
                                } catch (e) {
                                    const match = e instanceof Error ? /Unknown constant pool tag (\d+)/.exec(e.message) : null;
                                    const tag = match ? match[1] : undefined;
                                    const tagKey = tag ? Number(tag) : -1;
                                    if (tagKey >= 0 && warnedTags.has(tagKey)) {
                                        // already warned for this tag in this artifact
                                    } else {
                                        if (tagKey >= 0) warnedTags.add(tagKey);
                                        console.error(`Failed to parse class entry ${entry.fileName} in ${artifact.groupId}:${artifact.artifactId}:${artifact.version}: ${e instanceof Error ? e.message : e}`);
                                    }
                                }
                                zipfile.readEntry();
                            });
                        });
                    } else if (entry.fileName.endsWith('.proto')) {
                         zipfile.openReadStream(entry, (err, readStream) => {
                            if (err || !readStream) {
                                zipfile.readEntry();
                                return;
                            }
                            const chunks: Buffer[] = [];
                            readStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                            readStream.on('end', () => {
                                const content = Buffer.concat(chunks).toString('utf-8');
                                try {
                                    const protoInfo = ProtoParser.parse(content);
                                    resources.push({
                                        path: entry.fileName,
                                        content: content,
                                        type: 'proto',
                                        protoInfo: protoInfo
                                    });
                                } catch (e) {
                                    console.error(`Failed to parse proto ${entry.fileName}`, e);
                                }
                                zipfile.readEntry();
                            });
                         });
                    } else if (Indexer.isTextResource(entry.fileName, entry.uncompressedSize)) {
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err || !readStream) {
                                zipfile.readEntry();
                                return;
                            }
                            const chunks: Buffer[] = [];
                            readStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                            readStream.on('end', () => {
                                const content = Buffer.concat(chunks).toString('utf-8');
                                const type = Indexer.resourceTypeFor(entry.fileName);
                                // Dedup identical resource paths within an artifact.
                                if (!resources.some(r => r.path === entry.fileName)) {
                                    resources.push({ path: entry.fileName, content, type });
                                }
                                zipfile.readEntry();
                            });
                        });
                    } else {
                        zipfile.readEntry();
                    }
                });

                zipfile.on('end', () => {
                    try {
                        db.transaction(() => {
                            const classesTable = this.tableName('classes_fts');
                            const inheritanceTable = this.tableName('inheritance');
                            const resourcesTable = this.tableName('resources');
                            const resourceClassesTable = this.tableName('resource_classes');

                            const insertClass = db.prepare(`
                                INSERT INTO ${classesTable} (artifact_id, class_name, simple_name)
                                VALUES (?, ?, ?)
                            `);
                            const insertInheritance = db.prepare(`
                                INSERT INTO ${inheritanceTable} (artifact_id, class_name, parent_class_name, type)
                                VALUES (?, ?, ?, ?)
                            `);
                            const insertResource = db.prepare(`
                                INSERT INTO ${resourcesTable} (artifact_id, path, content, type)
                                VALUES (?, ?, ?, ?)
                            `);
                            const insertResourceClass = db.prepare(`
                                INSERT INTO ${resourceClassesTable} (resource_id, class_name)
                                VALUES (?, ?)
                            `);
                            const checkClassExists = db.prepare(`SELECT 1 FROM ${classesTable} WHERE artifact_id = ? AND class_name = ?`);

                            for (const cls of classes) {
                                const simpleName = cls.split('.').pop() || cls;
                                insertClass.run(artifact.id, cls, simpleName);
                            }

                            for (const item of inheritance) {
                                insertInheritance.run(artifact.id, item.className, item.parent, item.type);
                            }

                            for (const res of resources) {
                                const result = insertResource.run(artifact.id, res.path, res.content, res.type);
                                const resourceId = result.lastInsertRowid;

                                if (res.type === 'proto' && res.protoInfo) {
                                    let packageName = res.protoInfo.javaPackage || res.protoInfo.package || '';
                                    let outerClassName = res.protoInfo.javaOuterClassname;
                                    
                                    if (!outerClassName) {
                                        const baseName = res.path.split('/').pop()?.replace('.proto', '') || '';
                                        outerClassName = baseName.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
                                    }

                                    const classesToIndex: string[] = [];
                                    const fullOuterClassName = packageName ? `${packageName}.${outerClassName}` : outerClassName;
                                    classesToIndex.push(fullOuterClassName);

                                    if (res.protoInfo.javaMultipleFiles) {
                                        if (res.protoInfo.definitions) {
                                            res.protoInfo.definitions.forEach((def: string) => {
                                                const fullDefName = packageName ? `${packageName}.${def}` : def;
                                                classesToIndex.push(fullDefName);
                                            });
                                        }
                                    } else {
                                        if (res.protoInfo.definitions) {
                                            res.protoInfo.definitions.forEach((def: string) => {
                                                const fullDefName = `${fullOuterClassName}.${def}`;
                                                classesToIndex.push(fullDefName);
                                            });
                                        }
                                    }
                                    
                                    for (const fullClassName of classesToIndex) {
                                        insertResourceClass.run(resourceId, fullClassName);
                                        const simpleName = fullClassName.split('.').pop() || fullClassName;
                                        if (!checkClassExists.get(artifact.id, fullClassName)) {
                                            insertClass.run(artifact.id, fullClassName, simpleName);
                                        }
                                    }
                                }
                            }

                            // Index methods (opt-in via INDEX_METHODS env flag)
                            if (process.env.INDEX_METHODS === '1') {
                                const methodsTable = this.tableName('methods');
                                const insertMethod = db.prepare(`
                                    INSERT OR IGNORE INTO ${methodsTable} (artifact_id, class_name, method_name, descriptor)
                                    VALUES (?, ?, ?, ?)
                                `);
                                for (const cls of methodData) {
                                    for (const methodName of cls.methods) {
                                        insertMethod.run(artifact.id, cls.className, methodName, null);
                                    }
                                }
                            }

                            db.prepare('UPDATE artifacts SET is_indexed = 1 WHERE id = ?').run(artifact.id);
                        });
                    } catch (e) {
                        console.error(`Failed to insert classes for ${artifact.groupId}:${artifact.artifactId}`, e);
                    }
                    resolve();
                });

                zipfile.on('error', (err) => {
                    // Mark as indexed so a corrupt JAR is not retried every scan.
                    db.prepare('UPDATE artifacts SET is_indexed = 1 WHERE id = ?').run(artifact.id);
                    console.error(`⚠️ Marking artifact ${artifact.groupId}:${artifact.artifactId}:${artifact.version} as indexed (zip error: ${err instanceof Error ? err.message : String(err)})`);
                    resolve();
                });
                zipfile.readEntry();
            });
        });

        // Parse POM for dependencies (best-effort, errors logged not thrown).
        try {
            await this.indexArtifactPomDependencies(artifact, db);
        } catch (e) {
            console.error(`Failed to parse POM for ${artifact.groupId}:${artifact.artifactId}:${artifact.version}: ${e instanceof Error ? e.message : e}`);
        }
    }

    /**
     * Parses the on-disk POM (if present) for the given artifact and stores its
     * `<dependencies>` entries in the `dependencies` table. Best-effort: any
     * error is logged and swallowed so indexing of the artifact's JAR is not
     * affected.
     */
    private async indexArtifactPomDependencies(artifact: Artifact, db: DB): Promise<void> {
        const pomPath = artifact.layout === 'gradle'
            ? path.join(path.dirname(artifact.abspath), `${artifact.artifactId}-${artifact.version}.pom`)
            : path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}.pom`);
        if (!fsSync.existsSync(pomPath)) {
            return;
        }
        const pomInfo = await PomParser.parse(pomPath);
        const depsTable = this.tableName('dependencies');
        db.transaction(() => {
            db.prepare(`DELETE FROM ${depsTable} WHERE artifact_id = ?`).run(artifact.id);
            if (pomInfo.dependencies.length === 0) {
                return;
            }
            const insertDep = db.prepare(`
                INSERT INTO ${depsTable} (artifact_id, dep_group_id, dep_artifact_id, dep_version, scope, optional)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            for (const dep of pomInfo.dependencies) {
                insertDep.run(artifact.id, dep.groupId, dep.artifactId, dep.version || null, dep.scope || null, dep.optional ? 1 : 0);
            }
        });
    }

    /** Per-file size cap for stored text resources (64 KB). */
    private static readonly MAX_RESOURCE_SIZE = 64 * 1024;
    private static readonly TEXT_RESOURCE_EXTS = ['.properties', '.xml', '.json', '.yaml', '.yml'];

    /** Returns true if a JAR entry should be indexed as a text resource. */
    public static isTextResource(fileName: string, uncompressedSize: number): boolean {
        if (uncompressedSize > Indexer.MAX_RESOURCE_SIZE) return false;
        if (fileName.startsWith('META-INF/services/')) return true;
        return Indexer.TEXT_RESOURCE_EXTS.some(ext => fileName.endsWith(ext));
    }

    /** Returns the resource type label for a JAR entry path. */
    public static resourceTypeFor(fileName: string): string {
        if (fileName.startsWith('META-INF/services/')) return 'services';
        const ext = path.extname(fileName).slice(1);
        return ext || 'text';
    }

    /**
     * Checks if a class package is included in the configuration patterns.
     *
     * @param className The fully qualified class name.
     * @param normalizedPatterns The list of normalized package patterns.
     */
    private isPackageIncluded(className: string, normalizedPatterns: string[]): boolean {
        if (!normalizedPatterns || normalizedPatterns.length === 0) return true;

        for (const pattern of normalizedPatterns) {
            // Match exact package or subpackage
            if (className === pattern || className.startsWith(pattern + '.')) {
                return true;
            }
        }

        return false;
    }

    /**
     * Searches for artifacts by group ID or artifact ID.
     */
    public search(query: string, limit: number = 100): Artifact[] {
        // Artifact coordinates search
        const db = DB.getInstance();
        try {
            const like = likeContains(query);
            const rows = db.prepare(`
                SELECT id, group_id, artifact_id, version, abspath, has_source, layout
                FROM artifacts
                WHERE group_id LIKE ? ESCAPE '\\'
                   OR artifact_id LIKE ? ESCAPE '\\'
                LIMIT ?
            `).all(like, like, limit) as ArtifactRow[];
            return rows.map(row => this.mapArtifact(row));
        } catch (e) {
            console.error(`search failed (query=${JSON.stringify(query)})`, e);
            return [];
        }
    }

    /**
     * Searches for classes matching the pattern.
     * Uses Full-Text Search (FTS) for efficient matching.
     *
     * Options:
     * - `exact`: exact match on class_name or simple_name.
     * - `regex`: treat the pattern as a regex (strip `regex:` prefix if present).
     * - `simpleNameOnly`: apply search to `simple_name` column only.
     * - `packageOnly`: apply search to class_name excluding the last segment
     *   (e.g. `com.example` matches `com.example.Foo`).
     * - `caseSensitive`: for exact and LIKE queries, don't use `LOWER()`.
     *   No-op for FTS (trigram tokenizer is case-insensitive by design).
     *
     * When no flags are given, auto-detection is preserved: `regex:` prefix →
     * regex; `*`/`?` in pattern → glob (LIKE); otherwise FTS.
     */
    public searchClass(
        classNamePattern: string,
        limit: number = 100,
        opts: { exact?: boolean; regex?: boolean; simpleNameOnly?: boolean; packageOnly?: boolean; caseSensitive?: boolean } = {}
    ): { className: string, artifacts: Artifact[] }[] {
        const db = DB.getInstance();

        const selectCols = `
            SELECT c.class_name,
                   c.simple_name,
                   a.id,
                   a.group_id,
                   a.artifact_id,
                   a.version,
                   a.abspath,
                   a.has_source,
                   a.layout
            FROM classes_fts c
                     JOIN artifacts a ON c.artifact_id = a.id
        `;

        try {
            let rows: ClassRow[] = [];

            const hasRegexPrefix = classNamePattern.startsWith('regex:');
            const hasGlobChars = classNamePattern.includes('*') || classNamePattern.includes('?');

            // Determine mode (precedence: --regex > --exact > --package-only > auto-detect)
            let mode: 'regex' | 'exact' | 'package-only' | 'glob' | 'fts';
            if (opts.regex) {
                mode = 'regex';
            } else if (opts.exact) {
                mode = 'exact';
            } else if (opts.packageOnly) {
                mode = 'package-only';
            } else if (hasRegexPrefix) {
                mode = 'regex';
            } else if (hasGlobChars) {
                mode = 'glob';
            } else {
                mode = 'fts';
            }

            if (mode === 'regex') {
                const regex = hasRegexPrefix ? classNamePattern.substring(6) : classNamePattern;
                const compiled = compileUserRegex(regex);
                if (opts.simpleNameOnly) {
                    rows = db.prepare(`${selectCols} WHERE c.simple_name REGEXP ? LIMIT ?`)
                        .all(compiled.source, limit) as ClassRow[];
                } else if (opts.packageOnly) {
                    rows = db.prepare(`${selectCols} WHERE c.class_name REGEXP ? LIMIT ?`)
                        .all(compiled.source, limit) as ClassRow[];
                } else {
                    rows = db.prepare(`${selectCols} WHERE c.class_name REGEXP ? OR c.simple_name REGEXP ? LIMIT ?`)
                        .all(compiled.source, compiled.source, limit) as ClassRow[];
                }
            } else if (mode === 'exact') {
                if (opts.caseSensitive) {
                    if (opts.simpleNameOnly) {
                        rows = db.prepare(`${selectCols} WHERE c.simple_name = ? LIMIT ?`)
                            .all(classNamePattern, limit) as ClassRow[];
                    } else if (opts.packageOnly) {
                        rows = db.prepare(`${selectCols} WHERE c.class_name = ? LIMIT ?`)
                            .all(classNamePattern, limit) as ClassRow[];
                    } else {
                        rows = db.prepare(`${selectCols} WHERE c.class_name = ? OR c.simple_name = ? LIMIT ?`)
                            .all(classNamePattern, classNamePattern, limit) as ClassRow[];
                    }
                } else {
                    const lower = classNamePattern.toLowerCase();
                    if (opts.simpleNameOnly) {
                        rows = db.prepare(`${selectCols} WHERE LOWER(c.simple_name) = ? LIMIT ?`)
                            .all(lower, limit) as ClassRow[];
                    } else if (opts.packageOnly) {
                        rows = db.prepare(`${selectCols} WHERE LOWER(c.class_name) = ? LIMIT ?`)
                            .all(lower, limit) as ClassRow[];
                    } else {
                        rows = db.prepare(`${selectCols} WHERE LOWER(c.class_name) = ? OR LOWER(c.simple_name) = ? LIMIT ?`)
                            .all(lower, lower, limit) as ClassRow[];
                    }
                }
            } else if (mode === 'package-only') {
                // LIKE prefix.% on class_name (e.g. "com.example" -> "com.example.%")
                const likePattern = `${escapeLike(classNamePattern)}.%`;
                if (opts.caseSensitive) {
                    rows = db.prepare(`${selectCols} WHERE c.class_name LIKE ? ESCAPE '\\' LIMIT ?`)
                        .all(likePattern, limit) as ClassRow[];
                } else {
                    rows = db.prepare(`${selectCols} WHERE LOWER(c.class_name) LIKE LOWER(?) ESCAPE '\\' LIMIT ?`)
                        .all(likePattern, limit) as ClassRow[];
                }
            } else if (mode === 'glob') {
                // Glob-style search (auto-detect: pattern has * or ?)
                // Convert glob wildcards to SQL wildcards, escaping literal % and _ first.
                const likePattern = escapeLike(classNamePattern).replace(/\*/g, '%').replace(/\?/g, '_');
                if (opts.simpleNameOnly) {
                    rows = db.prepare(`${selectCols} WHERE c.simple_name LIKE ? ESCAPE '\\' LIMIT ?`)
                        .all(likePattern, limit) as ClassRow[];
                } else {
                    rows = db.prepare(`${selectCols} WHERE c.class_name LIKE ? ESCAPE '\\' OR c.simple_name LIKE ? ESCAPE '\\' LIMIT ?`)
                        .all(likePattern, likePattern, limit) as ClassRow[];
                }
            } else {
                // FTS mode (default)
                const ftsQuery = buildFtsQuery(classNamePattern);
                if (opts.simpleNameOnly) {
                    rows = db.prepare(`${selectCols} WHERE c.simple_name MATCH ? ORDER BY rank LIMIT ?`)
                        .all(ftsQuery, limit) as ClassRow[];
                } else {
                    rows = db.prepare(`${selectCols} WHERE c.classes_fts MATCH ? ORDER BY rank LIMIT ?`)
                        .all(ftsQuery, limit) as ClassRow[];
                }
            }

            return this.groupByArtifact(rows);

        } catch (e) {
            console.error(`searchClass failed (pattern=${JSON.stringify(classNamePattern)})`, e);
            return [];
        }
    }

    /**
     * Searches for implementations/subclasses of a specific class/interface.
     */
    public searchImplementations(className: string, limit: number = 100): { className: string, artifacts: Artifact[] }[] {
        const db = DB.getInstance();
        try {
            console.error(`Searching implementations for ${className}...`);

            // Debug: Check if we have any inheritance data at all
            const count = db.prepare("SELECT count(*) as c FROM inheritance").get() as { c: number };
            if (count.c === 0) {
                console.error("WARNING: Inheritance table is empty!");
            }

            // Recursive search for all implementations/subclasses.
            // depth cap (20) prevents runaway recursion on cyclic hierarchies.
            const rows = db.prepare(`
                WITH RECURSIVE hierarchy(class_name, artifact_id, depth) AS (
                    SELECT class_name, artifact_id, 0
                    FROM inheritance
                    WHERE parent_class_name = ?
                    UNION
                    SELECT i.class_name, i.artifact_id, h.depth + 1
                    FROM inheritance i
                             JOIN hierarchy h ON i.parent_class_name = h.class_name
                    WHERE h.depth < 20
                )
                SELECT DISTINCT h.class_name, a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source, a.layout
                FROM hierarchy h
                         JOIN artifacts a ON h.artifact_id = a.id LIMIT ?
            `).all(className, limit) as ClassRow[];

            console.error(`Searching implementations for ${className}: found ${rows.length} rows.`);

            if (rows.length === 0) {
                // Fallback: Try searching without recursion to see if direct children exist
                const direct = db.prepare('SELECT count(*) as c FROM inheritance WHERE parent_class_name = ?').get(className) as {
                    c: number
                };
                console.error(`Direct implementations check for ${className}: ${direct.c}`);
            }

            return this.groupByArtifact(rows);

        } catch (e) {
            console.error(`searchImplementations failed (className=${JSON.stringify(className)})`, e);
            return [];
        }
    }

    /**
     * Searches for methods by name across indexed artifacts.
     *
     * Options:
     * - `exact`: exact (case-insensitive) match on method_name.
     * - `caseSensitive`: for exact mode, don't use LOWER().
     * - `limit`: cap on raw rows (default 100).
     *
     * Default mode is a substring LIKE match on method_name.
     */
    public searchMethods(
        name: string,
        opts: { exact?: boolean; caseSensitive?: boolean; limit?: number } = {}
    ): { methodName: string; className: string; artifacts: Artifact[] }[] {
        const db = DB.getInstance();
        const limit = opts.limit ?? 100;
        try {
            const selectCols = `
                SELECT m.method_name, m.class_name,
                       a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source, a.layout
                FROM methods m JOIN artifacts a ON m.artifact_id = a.id
            `;
            let rows: MethodRow[];
            if (opts.exact) {
                if (opts.caseSensitive) {
                    rows = db.prepare(`${selectCols} WHERE m.method_name = ? LIMIT ?`)
                        .all(name, limit) as MethodRow[];
                } else {
                    const lower = name.toLowerCase();
                    rows = db.prepare(`${selectCols} WHERE LOWER(m.method_name) = ? LIMIT ?`)
                        .all(lower, limit) as MethodRow[];
                }
            } else {
                const like = likeContains(name);
                rows = db.prepare(`${selectCols} WHERE m.method_name LIKE ? ESCAPE '\\' LIMIT ?`)
                    .all(like, limit) as MethodRow[];
            }
            return this.groupByMethod(rows);
        } catch (e) {
            console.error(`searchMethods failed (name=${JSON.stringify(name)})`, e);
            return [];
        }
    }

    /**
     * Retrieves an artifact by its database ID.
     */
    public getArtifactById(id: number): Artifact | undefined {
        const db = DB.getInstance();
        const row = db.prepare(`
            SELECT id, group_id, artifact_id, version, abspath, has_source, layout
            FROM artifacts
            WHERE id = ?
        `).get(id) as ArtifactRow | undefined;

        return row ? this.mapArtifact(row) : undefined;
    }

    /**
     * Retrieves an artifact by its Maven coordinate.
     */
    public getArtifactByCoordinate(groupId: string, artifactId: string, version: string): Artifact | undefined {
        const db = DB.getInstance();
        const row = db.prepare(`
            SELECT id, group_id, artifact_id, version, abspath, has_source, layout
            FROM artifacts
            WHERE group_id = ?
              AND artifact_id = ?
              AND version = ?
        `).get(groupId, artifactId, version) as ArtifactRow | undefined;

        return row ? this.mapArtifact(row) : undefined;
    }

  /**
   * Searches for resources matching the pattern.
   */
  public searchResources(pattern: string, limit: number = 100): { path: string, artifact: Artifact }[] {
      const db = DB.getInstance();
      try {
          const like = likeContains(pattern);
          const rows = db.prepare(`
              SELECT r.path, a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source, a.layout
              FROM resources r
              JOIN artifacts a ON r.artifact_id = a.id
              WHERE r.path LIKE ? ESCAPE '\\'
              LIMIT ?
          `).all(like, limit) as ResourceRow[];

          return rows.map(row => ({
              path: row.path,
              artifact: this.mapArtifact(row)
          }));
      } catch (e) {
          console.error(`searchResources failed (pattern=${JSON.stringify(pattern)})`, e);
          return [];
      }
  }

  /**
   * Retrieves resources associated with a given class name.
   */
  public getResourcesForClass(className: string): { path: string, content: string, type: string }[] {
      const db = DB.getInstance();
      try {
          const rows = db.prepare(`
              SELECT r.path, r.content, r.type
              FROM resource_classes rc
              JOIN resources r ON rc.resource_id = r.id
              WHERE rc.class_name = ?
          `).all(className) as { path: string, content: string, type: string }[];

          // Deduplicate by content to avoid returning the same proto from many artifact versions
          const seen = new Set<string>();
          return rows.filter(row => {
              if (seen.has(row.content)) return false;
              seen.add(row.content);
              return true;
          });
      } catch (e) {
          console.error("Get resources for class failed", e);
          return [];
      }
  }

  public getResourcesForClassInArtifact(className: string, artifactId: number): { path: string, content: string, type: string }[] {
      const db = DB.getInstance();
      try {
          const rows = db.prepare(`
              SELECT r.path, r.content, r.type
              FROM resource_classes rc
              JOIN resources r ON rc.resource_id = r.id
              WHERE rc.class_name = ? AND r.artifact_id = ?
          `).all(className, artifactId) as { path: string, content: string, type: string }[];
          return rows;
      } catch (e) {
          console.error("Get resources for class in artifact failed", e);
          return [];
      }
  }

  /**
   * Returns detailed info for one or more artifacts matching a coordinate.
   * If `version` is omitted, returns info for every known version of the
   * given groupId:artifactId.
   */
  public getArtifactInfo(groupId: string, artifactId: string, version?: string): ArtifactInfo[] {
      const db = DB.getInstance();
      try {
          const sql = version
              ? `SELECT id, group_id, artifact_id, version, abspath, has_source, layout FROM artifacts WHERE group_id=? AND artifact_id=? AND version=?`
              : `SELECT id, group_id, artifact_id, version, abspath, has_source, layout FROM artifacts WHERE group_id=? AND artifact_id=?`;
          const rows = version
              ? (db.prepare(sql).all(groupId, artifactId, version) as ArtifactRow[])
              : (db.prepare(sql).all(groupId, artifactId) as ArtifactRow[]);

          return rows.map(row => {
              const artifact = this.mapArtifact(row);
              const classCount = (db.prepare('SELECT COUNT(*) as n FROM classes_fts WHERE artifact_id=?').get(artifact.id) as { n: number }).n;
              const resourceCount = (db.prepare('SELECT COUNT(*) as n FROM resources WHERE artifact_id=?').get(artifact.id) as { n: number }).n;
              const mainJarExists = fsSync.existsSync(resolveMainJar(artifact));
              return { artifact, classCount, resourceCount, mainJarExists };
          });
      } catch (e) {
          console.error(`getArtifactInfo failed (groupId=${JSON.stringify(groupId)}, artifactId=${JSON.stringify(artifactId)}, version=${JSON.stringify(version)})`, e);
          return [];
      }
  }

  /**
   * Returns aggregate statistics about the index.
   */
  public getStats(): IndexStats {
      const db = DB.getInstance();
      const meta = db.prepare("SELECT value FROM meta WHERE key='last_indexed_at'").get() as { value: string } | undefined;
      const artifactCount = (db.prepare('SELECT COUNT(*) as n FROM artifacts').get() as { n: number }).n;
      const classCount = (db.prepare('SELECT COUNT(*) as n FROM classes_fts').get() as { n: number }).n;
      const resourceCount = (db.prepare('SELECT COUNT(*) as n FROM resources').get() as { n: number }).n;
      const dbPath = db.currentPath;
      let dbSizeBytes = 0;
      try {
          dbSizeBytes = fsSync.statSync(dbPath).size;
      } catch (e) {
          // ignore stat errors (e.g. file removed)
      }
      return {
          lastIndexedAt: meta?.value ?? null,
          artifactCount,
          classCount,
          resourceCount,
          dbPath,
          dbSizeBytes,
      };
  }

  /**
   * Lists every distinct class name indexed for the given artifact coordinate.
   */
  public listClasses(groupId: string, artifactId: string, version: string): string[] {
      const db = DB.getInstance();
      try {
          const rows = db.prepare(`
              SELECT DISTINCT class_name FROM classes_fts
              WHERE artifact_id = (SELECT id FROM artifacts WHERE group_id=? AND artifact_id=? AND version=?)
          `).all(groupId, artifactId, version) as { class_name: string }[];
          return rows.map(r => r.class_name);
      } catch (e) {
          console.error(`listClasses failed (groupId=${JSON.stringify(groupId)}, artifactId=${JSON.stringify(artifactId)}, version=${JSON.stringify(version)})`, e);
          return [];
      }
  }

  /**
   * Retrieves a single indexed resource (path/content/type) by artifact coordinate
   * and in-JAR path. Returns null when not found or when the content exceeds the
   * 64KB safety cap.
   */
  public getResource(groupId: string, artifactId: string, version: string, resourcePath: string): { path: string, content: string, type: string } | null {
      const db = DB.getInstance();
      try {
          const row = db.prepare(`
              SELECT r.path, r.content, r.type
              FROM resources r
              JOIN artifacts a ON r.artifact_id = a.id
              WHERE a.group_id=? AND a.artifact_id=? AND a.version=? AND r.path=?
          `).get(groupId, artifactId, version, resourcePath) as { path: string, content: string, type: string } | undefined;
          if (!row) return null;
          // 64KB safety cap (defense-in-depth even though indexing already caps it)
          if (row.content && Buffer.byteLength(row.content, 'utf-8') > Indexer.MAX_RESOURCE_SIZE) {
              return null;
          }
          return { path: row.path, content: row.content, type: row.type };
      } catch (e) {
          console.error(`getResource failed (groupId=${JSON.stringify(groupId)}, artifactId=${JSON.stringify(artifactId)}, version=${JSON.stringify(version)}, resourcePath=${JSON.stringify(resourcePath)})`, e);
          return null;
      }
  }

  /**
   * Returns the parsed `<dependencies>` of the given artifact coordinate.
   * `scope` defaults to 'compile' and `version` defaults to '' when the POM
   * did not specify them. Errors return an empty array.
   */
  public getDependencies(groupId: string, artifactId: string, version: string): { groupId: string; artifactId: string; version: string; scope: string; optional: boolean }[] {
      const db = DB.getInstance();
      try {
          const rows = db.prepare(`
              SELECT d.dep_group_id, d.dep_artifact_id, d.dep_version, d.scope, d.optional
              FROM dependencies d
              JOIN artifacts a ON d.artifact_id = a.id
              WHERE a.group_id = ? AND a.artifact_id = ? AND a.version = ?
              ORDER BY d.dep_group_id, d.dep_artifact_id
          `).all(groupId, artifactId, version) as any[];
          return rows.map(r => ({
              groupId: r.dep_group_id,
              artifactId: r.dep_artifact_id,
              version: r.dep_version || '',
              scope: r.scope || 'compile',
              optional: Boolean(r.optional),
          }));
      } catch (e) {
          console.error(`getDependencies failed (groupId=${JSON.stringify(groupId)}, artifactId=${JSON.stringify(artifactId)}, version=${JSON.stringify(version)})`, e);
          return [];
      }
  }

  /**
   * Returns artifacts that declare a dependency on the given coordinate
   * (version is optional — dependents are matched by groupId:artifactId only).
   */
  public findDependents(groupId: string, artifactId: string): { groupId: string; artifactId: string; version: string; scope: string }[] {
      const db = DB.getInstance();
      try {
          const rows = db.prepare(`
              SELECT DISTINCT a.group_id, a.artifact_id, a.version, d.scope
              FROM artifacts a
              JOIN dependencies d ON d.artifact_id = a.id
              WHERE d.dep_group_id = ? AND d.dep_artifact_id = ?
              ORDER BY a.group_id, a.artifact_id, a.version
          `).all(groupId, artifactId) as any[];
          return rows.map(r => ({
              groupId: r.group_id,
              artifactId: r.artifact_id,
              version: r.version,
              scope: r.scope || 'compile',
          }));
      } catch (e) {
          console.error(`findDependents failed (groupId=${JSON.stringify(groupId)}, artifactId=${JSON.stringify(artifactId)})`, e);
          return [];
      }
  }

}

export interface ArtifactInfo {
    artifact: Artifact;
    classCount: number;
    resourceCount: number;
    mainJarExists: boolean;
}

export interface IndexStats {
    lastIndexedAt: string | null;
    artifactCount: number;
    classCount: number;
    resourceCount: number;
    dbPath: string;
    dbSizeBytes: number;
}
