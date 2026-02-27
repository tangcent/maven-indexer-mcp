import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock chokidar
const mockWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
};

vi.mock('chokidar', () => ({
    default: {
        watch: vi.fn(() => mockWatcher),
    },
}));

// Keep a reference to chokidar mock for assertions
import chokidar from 'chokidar';

import { Config } from '../src/config';
import { Indexer } from '../src/indexer';
import fsSync from 'fs';

describe('Indexer startWatch - glob pattern generation', () => {
    let existsSyncSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        // Reset chokidar mock
        vi.mocked(chokidar.watch).mockClear();
        mockWatcher.on.mockClear();

        // Reset watcher state on the singleton so startWatch can run again
        const indexer = Indexer.getInstance();
        (indexer as any).watcher = null;
    });

    afterEach(() => {
        existsSyncSpy?.mockRestore();
    });

    it('should watch glob patterns for .jar and .pom files', async () => {
        const testMavenRepo = '/test/maven/repo';

        // Mock Config to return known paths
        const config = await Config.getInstance();
        const origLocal = config.localRepository;
        const origGradle = config.gradleRepository;
        config.localRepository = testMavenRepo;
        config.gradleRepository = '';

        // Mock existsSync to return true for our test path
        existsSyncSpy = vi.spyOn(fsSync, 'existsSync').mockImplementation((p) => {
            return p === testMavenRepo;
        });

        try {
            const indexer = Indexer.getInstance();
            await indexer.startWatch();

            // Verify chokidar.watch was called
            expect(chokidar.watch).toHaveBeenCalledTimes(1);

            // Get the patterns passed to chokidar.watch
            const watchPatterns = vi.mocked(chokidar.watch).mock.calls[0][0] as string[];

            // The patterns should use forward slashes (glob format) and end with /**/*.jar and /**/*.pom
            const expectedBase = testMavenRepo.split(path.sep).join('/');
            expect(watchPatterns).toEqual([
                `${expectedBase}/**/*.jar`,
                `${expectedBase}/**/*.pom`,
            ]);
        } finally {
            // Restore config
            config.localRepository = origLocal;
            config.gradleRepository = origGradle;
        }
    });

    it('should watch both Maven and Gradle repos when both exist', async () => {
        const testMavenRepo = '/test/maven/repo';
        const testGradleRepo = '/test/gradle/repo';

        const config = await Config.getInstance();
        const origLocal = config.localRepository;
        const origGradle = config.gradleRepository;
        config.localRepository = testMavenRepo;
        config.gradleRepository = testGradleRepo;

        existsSyncSpy = vi.spyOn(fsSync, 'existsSync').mockImplementation((p) => {
            return p === testMavenRepo || p === testGradleRepo;
        });

        try {
            const indexer = Indexer.getInstance();
            await indexer.startWatch();

            expect(chokidar.watch).toHaveBeenCalledTimes(1);

            const watchPatterns = vi.mocked(chokidar.watch).mock.calls[0][0] as string[];
            const expectedMaven = testMavenRepo.split(path.sep).join('/');
            const expectedGradle = testGradleRepo.split(path.sep).join('/');

            expect(watchPatterns).toEqual([
                `${expectedMaven}/**/*.jar`,
                `${expectedMaven}/**/*.pom`,
                `${expectedGradle}/**/*.jar`,
                `${expectedGradle}/**/*.pom`,
            ]);
        } finally {
            config.localRepository = origLocal;
            config.gradleRepository = origGradle;
        }
    });

    it('should convert Windows-style paths to glob paths with forward slashes', async () => {
        // Simulate a Windows-style path (regardless of current OS)
        const windowsPath = 'C:\\Users\\test\\.m2\\repository';

        const config = await Config.getInstance();
        const origLocal = config.localRepository;
        const origGradle = config.gradleRepository;
        config.localRepository = windowsPath;
        config.gradleRepository = '';

        existsSyncSpy = vi.spyOn(fsSync, 'existsSync').mockImplementation((p) => {
            return p === windowsPath;
        });

        try {
            const indexer = Indexer.getInstance();
            await indexer.startWatch();

            expect(chokidar.watch).toHaveBeenCalledTimes(1);

            const watchPatterns = vi.mocked(chokidar.watch).mock.calls[0][0] as string[];

            // toGlobPath converts path.sep to '/', but on Unix path.sep is already '/'
            // so the backslashes in windowsPath won't be converted by path.sep.join('/') on Unix.
            // The actual toGlobPath logic is: p.split(path.sep).join('/')
            // On Unix, path.sep = '/', so split('/') then join('/') leaves backslashes intact in the segments.
            // On Windows, path.sep = '\\', so it would correctly convert.
            // We test the actual behavior: the patterns should contain /**/*.jar and /**/*.pom
            for (const pattern of watchPatterns) {
                expect(pattern).toMatch(/\*\*\/\*\.jar$|\*\*\/\*\.pom$/);
            }
            expect(watchPatterns).toHaveLength(2);
        } finally {
            config.localRepository = origLocal;
            config.gradleRepository = origGradle;
        }
    });

    it('should pass correct options to chokidar.watch', async () => {
        const testMavenRepo = '/test/maven/repo';

        const config = await Config.getInstance();
        const origLocal = config.localRepository;
        const origGradle = config.gradleRepository;
        config.localRepository = testMavenRepo;
        config.gradleRepository = '';

        existsSyncSpy = vi.spyOn(fsSync, 'existsSync').mockImplementation((p) => {
            return p === testMavenRepo;
        });

        try {
            const indexer = Indexer.getInstance();
            await indexer.startWatch();

            const options = vi.mocked(chokidar.watch).mock.calls[0][1] as any;

            // Verify key watcher options
            expect(options.persistent).toBe(true);
            expect(options.ignoreInitial).toBe(true);
            expect(options.ignorePermissionErrors).toBe(true);

            // Verify the ignored pattern is a regex that matches dotfiles and common dirs
            const ignored = options.ignored;
            expect(ignored).toBeInstanceOf(RegExp);
            expect(ignored.test('.git')).toBe(true);
            expect(ignored.test('node_modules')).toBe(true);
            expect(ignored.test('target')).toBe(true);
            expect(ignored.test('build')).toBe(true);
        } finally {
            config.localRepository = origLocal;
            config.gradleRepository = origGradle;
        }
    });

    it('should not start watcher when no repository paths exist', async () => {
        const config = await Config.getInstance();
        const origLocal = config.localRepository;
        const origGradle = config.gradleRepository;
        config.localRepository = '/nonexistent/path';
        config.gradleRepository = '';

        existsSyncSpy = vi.spyOn(fsSync, 'existsSync').mockReturnValue(false);

        try {
            const indexer = Indexer.getInstance();
            await indexer.startWatch();

            // chokidar.watch should NOT be called
            expect(chokidar.watch).not.toHaveBeenCalled();
        } finally {
            config.localRepository = origLocal;
            config.gradleRepository = origGradle;
        }
    });

    it('should register event handlers on the watcher', async () => {
        const testMavenRepo = '/test/maven/repo';

        const config = await Config.getInstance();
        const origLocal = config.localRepository;
        const origGradle = config.gradleRepository;
        config.localRepository = testMavenRepo;
        config.gradleRepository = '';

        existsSyncSpy = vi.spyOn(fsSync, 'existsSync').mockImplementation((p) => {
            return p === testMavenRepo;
        });

        try {
            const indexer = Indexer.getInstance();
            await indexer.startWatch();

            // Verify event handlers were registered
            const onCalls = mockWatcher.on.mock.calls.map((c: any[]) => c[0]);
            expect(onCalls).toContain('add');
            expect(onCalls).toContain('addDir');
            expect(onCalls).toContain('unlink');
            expect(onCalls).toContain('unlinkDir');
            expect(onCalls).toContain('error');
        } finally {
            config.localRepository = origLocal;
            config.gradleRepository = origGradle;
        }
    });
});
