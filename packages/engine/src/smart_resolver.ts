import fs from 'fs/promises';
import path from 'path';
import { Indexer } from './indexer.js';

/**
 * Resolves a simple (unqualified) class name to a fully qualified name
 * by searching the project source files and triggering a targeted index scan.
 */
export async function resolve(simpleName: string, basePath: string): Promise<string | null> {
  process.stderr.write(`Searching for '${simpleName}' in project sources under '${basePath}'...\n`);

  const candidates = await findSourceFiles(basePath, simpleName);

  if (candidates.length === 0) {
    return null;
  }

  for (const filePath of candidates) {
    process.stderr.write(`Found source file: ${filePath}\n`);

    const pkg = await extractPackage(filePath);
    if (!pkg) {
      process.stderr.write(`No package declaration found in ${filePath}, skipping.\n`);
      continue;
    }

    const fqn = `${pkg}.${simpleName}`;
    process.stderr.write(`Resolved FQN: ${fqn}\n`);

    // Extract top-2 package segments for targeted scan
    const segments = pkg.split('.');
    const topPackage = segments.slice(0, 2).join('.');
    process.stderr.write(`Triggering targeted scan for groupId prefix '${topPackage}'...\n`);

    const indexer = Indexer.getInstance();
    await indexer.index({ groupIdPrefix: topPackage, quickScan: true });

    const results = indexer.searchClass(fqn);
    const exact = results.find(r => r.className === fqn);

    if (exact) {
      return fqn;
    }

    process.stderr.write(
      `Class '${fqn}' not found after targeted scan. ` +
      `If this is a new dependency, try running 'maven-indexer-cli refresh-index' to rebuild the index.\n`
    );
  }

  return null;
}

async function findSourceFiles(basePath: string, simpleName: string): Promise<string[]> {
  const results: string[] = [];

  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'target') {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        const stem = path.basename(entry.name, ext);
        if ((ext === '.java' || ext === '.kt') && stem === simpleName) {
          results.push(fullPath);
        }
      }
    }
  };

  await walk(basePath);
  return results;
}

async function extractPackage(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').slice(0, 20).join('\n');
    const match = /^package\s+([\w.]+)/m.exec(lines);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
