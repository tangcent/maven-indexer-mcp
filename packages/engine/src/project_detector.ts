import fs from 'fs/promises';
import path from 'path';
import xml2js from 'xml2js';

export interface Dependency {
  groupId: string;
  artifactId: string;
  version?: string;
}

export async function detectDependencies(cwd: string): Promise<Dependency[]> {
  // Try pom.xml first
  const pomPath = path.join(cwd, 'pom.xml');
  try {
    const content = await fs.readFile(pomPath, 'utf-8');
    try {
      const parsed = await xml2js.parseStringPromise(content);
      const deps: Dependency[] = [];

      const dependenciesNode = parsed?.project?.dependencies?.[0]?.dependency;
      if (Array.isArray(dependenciesNode)) {
        for (const dep of dependenciesNode) {
          const groupId = dep.groupId?.[0];
          const artifactId = dep.artifactId?.[0];
          const version = dep.version?.[0];
          if (groupId && artifactId) {
            deps.push({ groupId, artifactId, version });
          }
        }
      }

      process.stderr.write(`Detected ${deps.length} dependencies from pom.xml\n`);
      return deps;
    } catch (e) {
      process.stderr.write(`Warning: Failed to parse pom.xml: ${(e as Error).message}\n`);
      return [];
    }
  } catch {
    // pom.xml not found, try gradle
  }

  // Try build.gradle or build.gradle.kts
  for (const gradleFile of ['build.gradle', 'build.gradle.kts']) {
    const gradlePath = path.join(cwd, gradleFile);
    try {
      const content = await fs.readFile(gradlePath, 'utf-8');
      const deps: Dependency[] = [];
      const regex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*[( ]["']([^"':]+):([^"':]+):([^"':]+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        deps.push({ groupId: match[1], artifactId: match[2], version: match[3] });
      }
      process.stderr.write(`Detected ${deps.length} dependencies from ${gradleFile}\n`);
      return deps;
    } catch {
      // file not found, continue
    }
  }

  return [];
}
