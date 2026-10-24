import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { Indexer, Config, DB, ArtifactResolver } from '@maven-indexer/engine';
import { createTempWorkspace } from './helpers/fixture.js';

/**
 * `Indexer.search` ordering and coordinate queries. With many versions of one
 * artifact, a display cap must keep the newest versions, and an exact
 * `g:a:v` query must find a version that a keyword search would truncate.
 */
describe('search artifacts', () => {
  let tmpDir: string;
  let repoDir: string;
  let savedEnv: Record<string, string | undefined>;

  // 9.4.31 sorts last as a string, which is where an unordered cap drops it.
  const versions = [
    ...Array.from({ length: 30 }, (_, i) => `1.0.${i + 1}`),
    '1.0.41-SNAPSHOT', '1.0.41', '2.0.36', '9.4.31',
  ];

  beforeAll(async () => {
    const ws = createTempWorkspace('search-artifacts-');
    tmpDir = ws.tmpDir;
    repoDir = ws.repoDir;
    savedEnv = {
      DB_FILE: process.env.DB_FILE,
      MAVEN_REPO_PATH: process.env.MAVEN_REPO_PATH,
      GRADLE_REPO_PATH: process.env.GRADLE_REPO_PATH,
    };
    process.env.DB_FILE = ws.dbFile;
    process.env.MAVEN_REPO_PATH = ws.repoDir;
    process.env.GRADLE_REPO_PATH = path.join(tmpDir, 'no-gradle');

    DB.reset();
    Config.reset();
    (Indexer as any).instance = undefined;

    const config = await Config.getInstance();
    config.localRepository = ws.repoDir;
    config.gradleRepository = '';

    // Coordinate search needs only a POM and a main JAR (artifacts without one
    // are pruned); an empty zip keeps this test independent of a JDK.
    const emptyZip = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
    for (const v of [...versions, '1.0.0']) {
      const groupId = v === '1.0.0' ? 'com.other' : 'com.example';
      const dir = path.join(ws.repoDir, ...groupId.split('.'), 'calc-features', v);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `calc-features-${v}.pom`), '<project></project>');
      fs.writeFileSync(path.join(dir, `calc-features-${v}.jar`), emptyZip);
    }

    await Indexer.getInstance().index();
  }, 60000);

  afterAll(() => {
    DB.reset();
    Config.reset();
    (Indexer as any).instance = undefined;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists newest versions first, so a cap keeps them', () => {
    const results = Indexer.getInstance().search('calc-features', 3);
    expect(results.map(a => `${a.groupId}:${a.version}`)).toEqual([
      'com.example:9.4.31', 'com.example:2.0.36', 'com.example:1.0.41',
    ]);
  });

  it('returns every match when no cap is needed', () => {
    const results = Indexer.getInstance().search('calc-features', Number.POSITIVE_INFINITY);
    expect(results.length).toBe(versions.length + 1);
    // Groups are ordered by coordinate; a release sorts before its snapshot.
    expect(results[results.length - 1].groupId).toBe('com.other');
    const v = results.map(a => a.version);
    expect(v.indexOf('1.0.41')).toBeLessThan(v.indexOf('1.0.41-SNAPSHOT'));
  });

  it('matches an exact groupId:artifactId:version coordinate', () => {
    const results = Indexer.getInstance().search('com.example:calc-features:1.0.7');
    expect(results.map(a => a.version)).toEqual(['1.0.7']);
  });

  it('matches a groupId:artifactId coordinate exactly', () => {
    const results = Indexer.getInstance().search('com.other:calc-features');
    expect(results.map(a => `${a.groupId}:${a.version}`)).toEqual(['com.other:1.0.0']);
    expect(Indexer.getInstance().search('com.example:calc-features:0.0.0')).toEqual([]);
  });

  it('explains why an exact version on disk is not indexed', async () => {
    const indexer = Indexer.getInstance();
    const base = path.join(repoDir, 'com', 'example', 'calc-features');
    // Failed download: only *.lastUpdated left behind.
    fs.mkdirSync(path.join(base, '9.9.0'));
    fs.writeFileSync(path.join(base, '9.9.0', 'calc-features-9.9.0.pom.lastUpdated'), '');
    // POM without the main JAR.
    fs.mkdirSync(path.join(base, '9.9.1'));
    fs.writeFileSync(path.join(base, '9.9.1', 'calc-features-9.9.1.pom'), '<project></project>');

    expect(await indexer.explainMissingVersion('com.example', 'calc-features', '9.9.0')).toContain('no .pom file');
    expect(await indexer.explainMissingVersion('com.example', 'calc-features', '9.9.1')).toContain('no main JAR (calc-features-9.9.1.jar)');
    expect(await indexer.explainMissingVersion('com.example', 'calc-features', '9.9.2')).toBeUndefined();
  });
});

describe('compareMavenVersions', () => {
  // Each list is oldest to newest.
  it.each([
    [['1.2.3.9', '1.2.3.10']],
    [['2.0-M1', '2.0-RC1', '2.0']],
    [['1.0-alpha-1', '1.0-beta-1', '1.0-beta-2', '1.0-SNAPSHOT', '1.0', '1.0.1']],
    [['1.0.41-SNAPSHOT', '1.0.41', '1.0.101', '2.0.36', '9.4.31']],
    [['5.3.9.RELEASE', '5.3.10.RELEASE']],
  ])('orders %j', (ordered) => {
    for (const shuffled of [[...ordered].reverse(), [...ordered]]) {
      expect([...shuffled].sort(ArtifactResolver.compareMavenVersions)).toEqual(ordered);
    }
  });

  it('treats trailing zeros and release qualifiers as equal', () => {
    expect(ArtifactResolver.compareMavenVersions('1.0', '1.0.0')).toBe(0);
    expect(ArtifactResolver.compareMavenVersions('2.0.0.RELEASE', '2.0.0')).toBe(0);
  });

  it.each(['1.0', '1.0.0', '1.0.0.0', '1.0.0.RELEASE'])('ranks service packs above equivalent release %s', (release) => {
    expect(ArtifactResolver.compareMavenVersions('1.0-sp', release)).toBeGreaterThan(0);
    expect(ArtifactResolver.compareMavenVersions(release, '1.0-sp')).toBeLessThan(0);
  });

  it.each([
    ['1.0.0-RC1', '1.0-RC2'],
    ['1.0-RC1', '1.0.0-RC2'],
    ['1.0.0-alpha1', '1.0-beta1'],
  ])('orders padded prerelease %s before %s', (older, newer) => {
    expect(ArtifactResolver.compareMavenVersions(older, newer)).toBeLessThan(0);
    expect(ArtifactResolver.compareMavenVersions(newer, older)).toBeGreaterThan(0);
  });

  it('keeps the newest version first for every input permutation', () => {
    const versions = ['1.0', '1.0.0', '1.0-sp'];
    for (const first of versions) {
      for (const second of versions.filter(v => v !== first)) {
        const third = versions.find(v => v !== first && v !== second)!;
        const artifacts = [first, second, third].map(version => ({
          id: 0, groupId: 'com.example', artifactId: 'calc', version, abspath: '', hasSource: false,
        }));
        expect(artifacts.sort(ArtifactResolver.compareForListing)[0].version).toBe('1.0-sp');
      }
    }
  });
});
