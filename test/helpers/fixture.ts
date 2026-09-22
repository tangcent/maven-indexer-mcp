/**
 * Shared test fixtures: builds real Maven artifacts (compiled .class inside a
 * JAR + POM, optional resources) under a temp repository root, so tests can
 * exercise the indexer against data shaped like a genuine local ~/.m2.
 *
 * Requires `javac` and `jar` on PATH (CI installs a JDK).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

export interface ResourceSpec {
  /** Path inside the JAR, e.g. `META-INF/spring.factories`. */
  path: string;
  content: string;
}

/**
 * Creates `<repoRoot>/<group/path>/<artifactId>/<version>/` containing
 * `<artifactId>-<version>.jar` and `.pom`.
 *
 * @param className Fully qualified class name to compile into the JAR.
 * @param resources Extra entries to put in the JAR.
 * @param extraMethods Number of additional `mN()` methods to generate — used to
 *   build payloads that exceed the explore line budget.
 */
export function buildArtifact(
  repoRoot: string,
  groupId: string,
  artifactId: string,
  version: string,
  className: string,
  resources: ResourceSpec[] = [],
  extraMethods = 0,
): string {
  const groupPath = groupId.replace(/\./g, '/');
  const artifactDir = path.join(repoRoot, groupPath, artifactId, version);
  fs.mkdirSync(artifactDir, { recursive: true });

  const pkg = className.substring(0, className.lastIndexOf('.'));
  const simpleName = className.substring(className.lastIndexOf('.') + 1);
  const pkgPath = pkg.replace(/\./g, '/');

  const srcDir = path.join(artifactDir, '.src-tmp');
  fs.mkdirSync(path.join(srcDir, pkgPath), { recursive: true });

  const methods = Array.from({ length: extraMethods }, (_, i) => `  public int m${i}() { return ${i}; }`).join('\n');
  fs.writeFileSync(
    path.join(srcDir, pkgPath, `${simpleName}.java`),
    `package ${pkg};\npublic class ${simpleName} {\n  public String echo(String s) { return s; }\n${methods}\n}\n`,
  );
  execSync(`javac "${path.join(srcDir, pkgPath, `${simpleName}.java`)}"`);

  for (const res of resources) {
    const target = path.join(srcDir, res.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, res.content);
  }

  const jarPath = path.join(artifactDir, `${artifactId}-${version}.jar`);
  execSync(`jar -cf "${jarPath}" -C "${srcDir}" .`);

  fs.writeFileSync(
    path.join(artifactDir, `${artifactId}-${version}.pom`),
    `<project><modelVersion>4.0.0</modelVersion><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version></project>`,
  );

  fs.rmSync(srcDir, { recursive: true, force: true });
  return artifactDir;
}

/** Creates an isolated temp dir with its own DB + fake repositories. */
export function createTempWorkspace(prefix: string): {
  tmpDir: string;
  repoDir: string;
  dbFile: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  return { tmpDir, repoDir, dbFile: path.join(tmpDir, 'index.sqlite') };
}

/** Points the env at the temp workspace and resets engine singletons. */
export function applyEnv(env: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
