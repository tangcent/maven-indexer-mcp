import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { Config } from '../src/config';
import { ArtifactResolver } from '../src/artifact_resolver';
import { Artifact } from '../src/indexer';

const TEST_DIR = path.resolve('test-strategy');

describe('ArtifactResolver Strategy', () => {
    beforeAll(() => {
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
        fs.mkdirSync(TEST_DIR);
    });

    afterAll(() => {
        vi.restoreAllMocks();
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    });

    beforeEach(() => {
        Config.reset();
        delete process.env.VERSION_RESOLUTION_STRATEGY;
        vi.restoreAllMocks();
        // Clean up test directory to ensure isolation
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
        fs.mkdirSync(TEST_DIR);
    });

    function createArtifact(version: string, mtimeOffsetMs: number, birthtimeOffsetMs: number = 0): Artifact {
        const dir = path.join(TEST_DIR, version);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        
        const jarPath = path.join(dir, `demo-${version}.jar`);
        fs.writeFileSync(jarPath, 'dummy');
        
        const now = Date.now();
        const mtime = new Date(now + mtimeOffsetMs);
        const atime = mtime;
        
        fs.utimesSync(jarPath, atime, mtime);

        return {
            id: Math.floor(Math.random() * 1000),
            groupId: 'com.test',
            artifactId: 'demo',
            version: version,
            abspath: dir,
            hasSource: false 
        };
    }

    it('should prefer release over snapshot in semver strategy', async () => {
        process.env.VERSION_RESOLUTION_STRATEGY = 'semver';
        
        const a1 = createArtifact('1.2.0-SNAPSHOT', 0);
        const a2 = createArtifact('1.2.0', 0);
        
        // 1.2.0 > 1.2.0-SNAPSHOT
        const artifacts = [a1, a2];
        const best = await ArtifactResolver.resolveBestArtifact(artifacts);
        
        expect(best?.version).toBe('1.2.0');
    });

    it('should prefer semver-latest by default', async () => {
        const a1 = createArtifact('1.0.0', 0);
        const a2 = createArtifact('2.0.0', -10000); // Newer version, but older mtime
        
        const artifacts = [a1, a2];
        const best = await ArtifactResolver.resolveBestArtifact(artifacts);
        
        expect(best?.version).toBe('2.0.0');
    });

    it('should prefer latest-published when configured', async () => {
        process.env.VERSION_RESOLUTION_STRATEGY = 'latest-published';
        
        const a1 = createArtifact('1.0.0', 10000); // Older version, but newer mtime (future)
        const a2 = createArtifact('2.0.0', -10000); // Newer version, but older mtime (past)
        
        const artifacts = [a1, a2];
        const best = await ArtifactResolver.resolveBestArtifact(artifacts);
        
        expect(best?.version).toBe('1.0.0');
    });

    it('should prefer latest-published from .lastUpdated file if present', async () => {
        process.env.VERSION_RESOLUTION_STRATEGY = 'latest-published';
        
        // a1: Newer mtime (2000), but no .lastUpdated
        const a1 = createArtifact('1.0.0', 2000); 

        // a2: Older mtime (1000), but has .lastUpdated with Future timestamp (3000)
        const a2 = createArtifact('2.0.0', 1000); 
        const pomPath = path.join(a2.abspath, `demo-2.0.0.pom`);
        fs.writeFileSync(pomPath, 'dummy pom');
        const lastUpdatedPath = `${pomPath}.lastUpdated`;
        // Create a .lastUpdated file with a future timestamp
        const futureTime = Date.now() + 100000;
        fs.writeFileSync(lastUpdatedPath, `https\\://repo.maven.apache.org/maven2/.lastUpdated=${futureTime}\n#Some comments`);
        
        const artifacts = [a1, a2];
        const best = await ArtifactResolver.resolveBestArtifact(artifacts);
        
        expect(best?.version).toBe('2.0.0');
    });

    it('should prefer latest-used when configured', async () => {
         process.env.VERSION_RESOLUTION_STRATEGY = 'latest-used';
         
         const a1 = createArtifact('1.0.0', 0);
         const a2 = createArtifact('2.0.0', 0);
         
         // Mock fs.statSync to control birthtime independently of OS behavior
         const originalStatSync = fs.statSync;
         vi.spyOn(fs, 'statSync').mockImplementation((p: any) => {
             // @ts-ignore
             if (p.includes('demo-1.0.0.jar') || p.includes('demo-1.0.0.pom')) {
                 return {
                     isDirectory: () => false,
                     mtime: new Date(1000),
                     birthtime: new Date(1000) // Created early
                 } as any;
             }
             // @ts-ignore
             if (p.includes('demo-2.0.0.jar') || p.includes('demo-2.0.0.pom')) {
                 return {
                     isDirectory: () => false,
                     mtime: new Date(1000), 
                     birthtime: new Date(2000) // Created later
                 } as any;
             }
             // Check directory stats logic in ArtifactResolver
             if (p.endsWith('1.0.0')) {
                  return { isDirectory: () => true } as any;
             }
             if (p.endsWith('2.0.0')) {
                  return { isDirectory: () => true } as any;
             }

             return originalStatSync(p);
         });
         
         const artifacts = [a1, a2];
         const best = await ArtifactResolver.resolveBestArtifact(artifacts);
         
         expect(best?.version).toBe('2.0.0');
    });

    it('should support legacy date-latest alias', async () => {
        process.env.VERSION_RESOLUTION_STRATEGY = 'date-latest';
        
        const a1 = createArtifact('1.0.0', 10000); // Older version, but newer mtime
        const a2 = createArtifact('2.0.0', -10000); // Newer version, but older mtime
        
        // date-latest -> latest-published
        const artifacts = [a1, a2];
        const best = await ArtifactResolver.resolveBestArtifact(artifacts);
        
        expect(best?.version).toBe('1.0.0');
    });
    
    it('should prefer source over version/date', async () => {
         const a1 = createArtifact('1.0.0', 0);
         a1.hasSource = true;
         const a2 = createArtifact('2.0.0', 10000);
         a2.hasSource = false;
         
         const artifacts = [a1, a2];
         const best = await ArtifactResolver.resolveBestArtifact(artifacts);
         
         expect(best?.version).toBe('1.0.0');
    });
});
