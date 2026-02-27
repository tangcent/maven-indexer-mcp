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
    private scheduleTimer: NodeJS.Timeout | null = null;

    private constructor() {
    }

    public static getInstance(): Indexer {
        if (!Indexer.instance) {
            Indexer.instance = new Indexer();
        }
        return Indexer.instance;
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

            // Watch for file additions and changes
            this.watcher
                .on('add', (filePath) => {
                    if (filePath.endsWith('.jar') || filePath.endsWith('.pom')) {
                        console.error(`📄 New file detected: ${path.basename(filePath)}`);
                        this.triggerReindex();
                    }
                })
                .on('addDir', (dirPath) => {
                    console.error(`📁 New directory detected: ${path.basename(dirPath)}`);
                    this.triggerReindex();
                })
                .on('unlink', (filePath) => {
                    if (filePath.endsWith('.jar') || filePath.endsWith('.pom')) {
                        console.error(`🗑️ File removed: ${path.basename(filePath)}`);
                        this.triggerReindex();
                    }
                })
                .on('unlinkDir', (dirPath) => {
                    console.error(`🗑️ Directory removed: ${path.basename(dirPath)}`);
                    this.triggerReindex();
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
     */
    private triggerReindex() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Wait 3 seconds after the last change before reindexing
        this.debounceTimer = setTimeout(() => {
            console.error('🔄 Changes detected - triggering reindex...');
            this.index().catch(console.error);
        }, 3000);
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
            db.prepare('DELETE FROM resources').run();
            db.prepare('DELETE FROM resource_classes').run();
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
                OR IGNORE INTO artifacts (group_id, artifact_id, version, abspath, has_source, is_indexed)
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
            const indexedArtifactsCount = db.prepare('SELECT COUNT(*) as count FROM artifacts WHERE is_indexed = 1').get() as {
                count: number
            };

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

                    // We need to iterate all hash dirs to find the jar and source jar
                    for (const hashEntry of hashDirs) {
                        if (!hashEntry.isDirectory()) continue;
                        const hashPath = path.join(versionPath, hashEntry.name);
                        const files = await readDirSafe(hashPath);

                        for (const file of files) {
                            if (file.isFile()) {
                                if (file.name.endsWith('.jar')) {
                                    if (file.name.endsWith('-sources.jar')) {
                                        hasSource = true;
                                    } else if (!file.name.endsWith('-javadoc.jar')) {
                                        // This should be the main jar
                                        jarPath = path.join(hashPath, file.name);
                                    }
                                }
                            }
                        }
                    }

                    if (jarPath) {
                        results.push({
                            id: 0, // Placeholder
                            groupId,
                            artifactId,
                            version,
                            abspath: jarPath, // Full path to JAR
                            hasSource
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
        let jarPath = artifact.abspath;
        if (!jarPath.endsWith('.jar')) {
            jarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}.jar`);
        }
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
                    resolve();
                    return;
                }

                const classes: string[] = [];
                const inheritance: { className: string, parent: string, type: 'extends' | 'implements' }[] = [];
                const resources: { path: string, content: string, type: string, protoInfo?: any }[] = [];

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
                                            if (info.superClass && info.superClass !== 'java.lang.Object') {
                                                inheritance.push({ className: info.className, parent: info.superClass, type: 'extends' });
                                            }
                                            for (const iface of info.interfaces) {
                                                inheritance.push({ className: info.className, parent: iface, type: 'implements' });
                                            }
                                        }
                                    }
                                } catch (e) {}
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
                    } else {
                        zipfile.readEntry();
                    }
                });

                zipfile.on('end', () => {
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
                            const insertResource = db.prepare(`
                                INSERT INTO resources (artifact_id, path, content, type)
                                VALUES (?, ?, ?, ?)
                            `);
                            const insertResourceClass = db.prepare(`
                                INSERT INTO resource_classes (resource_id, class_name)
                                VALUES (?, ?)
                            `);
                            const checkClassExists = db.prepare('SELECT 1 FROM classes_fts WHERE artifact_id = ? AND class_name = ?');

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
                zipfile.readEntry();
            });
        });
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
    public search(query: string): Artifact[] {
        // Artifact coordinates search
        const db = DB.getInstance();
        const rows = db.prepare(`
            SELECT id, group_id as groupId, artifact_id as artifactId, version, abspath, has_source as hasSource
            FROM artifacts
            WHERE group_id LIKE ?
               OR artifact_id LIKE ? LIMIT 50
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
                    SELECT c.class_name,
                           c.simple_name,
                           a.id,
                           a.group_id,
                           a.artifact_id,
                           a.version,
                           a.abspath,
                           a.has_source
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
                    SELECT c.class_name,
                           c.simple_name,
                           a.id,
                           a.group_id,
                           a.artifact_id,
                           a.version,
                           a.abspath,
                           a.has_source
                    FROM classes_fts c
                             JOIN artifacts a ON c.artifact_id = a.id
                    WHERE c.class_name LIKE ?
                       OR c.simple_name LIKE ? LIMIT 100
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
                    SELECT c.class_name,
                           c.simple_name,
                           a.id,
                           a.group_id,
                           a.artifact_id,
                           a.version,
                           a.abspath,
                           a.has_source
                    FROM classes_fts c
                             JOIN artifacts a ON c.artifact_id = a.id
                    WHERE c.classes_fts MATCH ?
                    ORDER BY rank LIMIT 100
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
            const count = db.prepare("SELECT count(*) as c FROM inheritance").get() as { c: number };
            if (count.c === 0) {
                console.error("WARNING: Inheritance table is empty!");
            }

            // Recursive search for all implementations/subclasses
            const rows = db.prepare(`
                WITH RECURSIVE hierarchy(class_name, artifact_id) AS (SELECT class_name, artifact_id
                                                                      FROM inheritance
                                                                      WHERE parent_class_name = ?
                                                                      UNION
                                                                      SELECT i.class_name, i.artifact_id
                                                                      FROM inheritance i
                                                                               JOIN hierarchy h ON i.parent_class_name = h.class_name)
                SELECT DISTINCT h.class_name, a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source
                FROM hierarchy h
                         JOIN artifacts a ON h.artifact_id = a.id LIMIT 100
            `).all(className) as any[];

            console.error(`Searching implementations for ${className}: found ${rows.length} rows.`);

            if (rows.length === 0) {
                // Fallback: Try searching without recursion to see if direct children exist
                const direct = db.prepare('SELECT count(*) as c FROM inheritance WHERE parent_class_name = ?').get(className) as {
                    c: number
                };
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
            FROM artifacts
            WHERE id = ?
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
            WHERE group_id = ?
              AND artifact_id = ?
              AND version = ?
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

  /**
   * Searches for resources matching the pattern.
   */
  public searchResources(pattern: string): { path: string, artifact: Artifact }[] {
      const db = DB.getInstance();
      try {
          // LIKE search for now
          const rows = db.prepare(`
              SELECT r.path, a.id, a.group_id, a.artifact_id, a.version, a.abspath, a.has_source
              FROM resources r
              JOIN artifacts a ON r.artifact_id = a.id
              WHERE r.path LIKE ?
              LIMIT 100
          `).all(`%${pattern}%`) as any[];

          return rows.map(row => ({
              path: row.path,
              artifact: {
                  id: row.id,
                  groupId: row.group_id,
                  artifactId: row.artifact_id,
                  version: row.version,
                  abspath: row.abspath,
                  hasSource: Boolean(row.has_source)
              }
          }));
      } catch (e) {
          console.error("Search resources failed", e);
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

          return rows;
      } catch (e) {
          console.error("Get resources for class failed", e);
          return [];
      }
  }
}
