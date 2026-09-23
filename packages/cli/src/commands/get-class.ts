import { DB } from '@maven-indexer/engine';
import { Indexer, Artifact } from '@maven-indexer/engine';
import { SourceParser } from '@maven-indexer/engine';
import { ArtifactResolver } from '@maven-indexer/engine';
import { resolveMainJar, resolveSourcesJar } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath, assertIndexNotEmpty } from './shared.js';
import { print } from '@maven-indexer/engine';
import { resolve as smartResolve } from '@maven-indexer/engine';

const VALID_TYPES = ['signatures', 'docs', 'source'] as const;
type DetailType = typeof VALID_TYPES[number];

export async function run(
  className: string,
  opts: { type?: string; coordinate?: string } & GlobalOpts
): Promise<void> {
  // Validate type
  const type: DetailType = (opts.type as DetailType) ?? 'signatures';
  if (!VALID_TYPES.includes(type)) {
    process.stderr.write(`Invalid --type "${opts.type}". Must be one of: signatures, docs, source\n`);
    process.exit(1);
  }

  const db = DB.getInstance(resolveDbPath());
  assertIndexNotEmpty(db);

  const indexer = Indexer.getInstance();

  // If unqualified and no coordinate, try smart resolver
  let resolvedClassName = className;
  if (!className.includes('.') && !opts.coordinate) {
    const fqn = await smartResolve(className, process.cwd());
    if (fqn) {
      resolvedClassName = fqn;
    }
    // AC5/AC6: if fqn is null, fall through to index search with simple name;
    // resolveOne will return a descriptive message if not found
  }

  const resultText = await resolveOne(indexer, resolvedClassName, type, opts.coordinate);
  print('get-class', resultText, opts);
}

async function resolveOne(
  indexer: Indexer,
  clsName: string,
  type: DetailType,
  coord?: string
): Promise<string> {
  let targetArtifact: Artifact | undefined;
  let resolvedClassName = clsName;

  if (coord) {
    const parts = coord.split(':');
    if (parts.length !== 3) {
      return 'Invalid coordinate format. Expected groupId:artifactId:version';
    }
    targetArtifact = indexer.getArtifactByCoordinate(parts[0], parts[1], parts[2]);
    if (!targetArtifact) {
      return `Artifact ${coord} not found in index.`;
    }
  } else {
    const matches = indexer.searchClass(clsName);
    const exactMatch = matches.find(m => m.className === clsName);

    if (!exactMatch) {
      // Try inner class resolution
      const parts = clsName.split('.');
      let innerClassMatch: typeof matches[0] | undefined;
      for (let i = parts.length - 1; i > 0; i--) {
        const candidate = parts.slice(0, i).join('.');
        const candidateMatches = indexer.searchClass(candidate);
        const candidateExact = candidateMatches.find(m => m.className === candidate);
        if (candidateExact) {
          const innerPart = parts.slice(i).join('$');
          resolvedClassName = candidate + '$' + innerPart;
          innerClassMatch = candidateExact;
          break;
        }
      }

      if (!innerClassMatch) {
        if (matches.length > 0) {
          const suggestions = matches.map(m => `- ${m.className}`).join('\n');
          return `Class '${clsName}' not found exactly. Did you mean:\n${suggestions}`;
        }
        return `Class '${clsName}' not found in the index. Try 'search-classes' with a keyword if you are unsure of the full name.`;
      }

      const bestArt = await ArtifactResolver.resolveBestArtifact(innerClassMatch.artifacts);
      if (!bestArt) {
        return `Class '${clsName}' found but no artifacts are associated with it.`;
      }
      targetArtifact = bestArt;
    } else {
      const bestArtifact = await ArtifactResolver.resolveBestArtifact(exactMatch.artifacts);
      if (!bestArtifact) {
        return `Class '${clsName}' found but no artifacts are associated with it (database inconsistency).`;
      }
      targetArtifact = bestArtifact;
    }
  }

  const artifact = targetArtifact;

  let detail: Awaited<ReturnType<typeof SourceParser.getClassDetail>> = null;
  let usedDecompilation = false;
  let lastError = '';

  if (type === 'source' || type === 'docs') {
    if (artifact.hasSource) {
      const sourceJarPath = resolveSourcesJar(artifact);
      try {
        detail = await SourceParser.getClassDetail(sourceJarPath, resolvedClassName, type);
      } catch (e: any) {
        lastError = e.message;
      }
    }

    if (!detail) {
      const mainJarPath = resolveMainJar(artifact);
      try {
        detail = await SourceParser.getClassDetail(mainJarPath, resolvedClassName, type);
        if (detail && detail.source) {
          usedDecompilation = true;
        }
      } catch (e: any) {
        console.error(`Decompilation/MainJar access failed: ${e.message}`);
        lastError = e.message;
      }
    }
  } else {
    const mainJarPath = resolveMainJar(artifact);
    try {
      detail = await SourceParser.getClassDetail(mainJarPath, resolvedClassName, type);
    } catch (e: any) {
      lastError = e.message;
    }
  }

  try {
    const getResourcesFromArtifact = (name: string) =>
      indexer.getResourcesForClassInArtifact(name, artifact.id);

    let resources = getResourcesFromArtifact(clsName);
    if (resources.length === 0) {
      const parts = clsName.split('.');
      for (let i = parts.length - 1; i > 0; i--) {
        const candidate = parts.slice(0, i).join('.');
        const candidateResources = getResourcesFromArtifact(candidate);
        if (candidateResources.length > 0) {
          resources = candidateResources;
          break;
        }
      }
    }

    let crossArtifactResources: typeof resources = [];
    if (resources.length === 0) {
      crossArtifactResources = indexer.getResourcesForClass(clsName);
      if (crossArtifactResources.length === 0) {
        const parts = clsName.split('.');
        for (let i = parts.length - 1; i > 0; i--) {
          const candidate = parts.slice(0, i).join('.');
          const found = indexer.getResourcesForClass(candidate);
          if (found.length > 0) {
            crossArtifactResources = found;
            break;
          }
        }
      }
    }

    const allResources = resources.length > 0 ? resources : crossArtifactResources;
    const resourcesFromDifferentArtifact = resources.length === 0 && crossArtifactResources.length > 0;

    if (!detail && allResources.length === 0) {
      const debugInfo = `Artifact path: ${artifact.abspath}, hasSource: ${artifact.hasSource}`;
      const errorMsg = lastError ? `\nLast error: ${lastError}` : '';
      return `Class ${clsName} not found in artifact ${artifact.artifactId}. \nDebug info: ${debugInfo}${errorMsg}`;
    }

    let resultText = '';

    if (detail && !resourcesFromDifferentArtifact) {
      resultText += `### Class: ${detail.className}\n`;
      resultText += `Artifact: ${artifact.groupId}:${artifact.artifactId}:${artifact.version}\n\n`;

      if (usedDecompilation) {
        resultText += '*Source code decompiled from binary class file.*\n\n';
      }

      if (type === 'source') {
        const lang = detail.language || 'java';
        resultText += '```' + lang + '\n' + detail.source + '\n```';
      } else {
        if (detail.doc) {
          resultText += 'Documentation:\n' + detail.doc + '\n\n';
        }
        if (detail.signatures) {
          resultText += 'Methods:\n' + detail.signatures.join('\n') + '\n';
        }
      }
    } else if (!detail) {
      resultText += `### Class: ${clsName}\n`;
      resultText += `Artifact: ${artifact.groupId}:${artifact.artifactId}:${artifact.version}\n\n`;
    }

    if (allResources.length > 0) {
      resultText += '\n\n### Related Resources\n';
      for (const res of allResources) {
        const lang = res.type === 'proto' ? 'protobuf' : res.type;
        resultText += `\n**${res.path}** (${res.type})\n\`\`\`${lang}\n${res.content}\n\`\`\`\n`;
      }
    }

    return resultText;
  } catch (e: any) {
    return `Error reading source: ${e.message}`;
  }
}
