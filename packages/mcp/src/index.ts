#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Indexer, Artifact, ArtifactInfo, IndexStats, SourceParser, ArtifactResolver, resolveMainJar, resolveSourcesJar, DB, explore, trimForLlm, renderForLlm, getProjectContext } from '@maven-indexer/engine';

/**
 * Module 3 — MCP Surface: tool gating.
 *
 * By default only `explore` is registered (Req 1.1). The narrow tools are
 * *defined* (handlers preserved) but only registered when opted in via the
 * `MAVEN_INDEXER_MCP_TOOLS` env var (Req 2.1–2.6). Design: see
 * `.spec/maven-indexer-redesign/design.md` §D3.
 */

/** Closed catalog of short names that MAY be registered (Req 3.4). */
const CATALOG_NAMES: ReadonlySet<string> = new Set([
  'explore',
  'search',
  'get_class',
  'get_resource',
  'implementations',
  'callers',
  'callees',
  'impact',
  'dependencies',
  'dependents',
  'info',
  'stats',
  'project_context',
  'search_artifacts',
  'search_resources',
  'search_methods',
  'list_classes',
]);

/**
 * Resolve which short tool names should be registered, per design D3.1.
 *
 * - env unset → only `explore` (default)
 * - env set to a csv of short names → `explore` + exactly that set (filtered
 *   against the catalog; accepts both `search` and `maven_indexer_search`)
 * - env set but parses to empty set → `explore` + ALL catalog tools (escape hatch)
 *
 * `explore` is ALWAYS included (it is the default tool).
 */
function resolveEnabledTools(): Set<string> {
  const env = process.env.MAVEN_INDEXER_MCP_TOOLS;
  const enabled = new Set<string>(['explore']);

  if (env === undefined) {
    return enabled;
  }

  const requested = env.split(',').map(s => s.trim()).filter(Boolean);
  if (requested.length === 0) {
    // Empty-but-set = escape hatch: register all catalog tools.
    for (const name of CATALOG_NAMES) enabled.add(name);
    return enabled;
  }

  for (const raw of requested) {
    // Accept both short names (`search`) and prefixed names (`maven_indexer_search`).
    const short = raw.replace(/^maven_indexer_/, '');
    if (CATALOG_NAMES.has(short)) {
      enabled.add(short);
    }
  }
  return enabled;
}

/**
 * Parses a `className[.methodName]` target string for the call-graph tools.
 *
 * Heuristic: Java method names start with a lowercase letter, class names
 * with an uppercase letter. If the last dot-separated segment starts with
 * lowercase, it's treated as a method name; otherwise the whole string is
 * treated as a class name.
 */
function parseTarget(target: string): { className: string; methodName: string | undefined } {
  const lastDotIndex = target.lastIndexOf('.');
  if (lastDotIndex > 0 && lastDotIndex < target.length - 1) {
    const lastSegment = target.substring(lastDotIndex + 1);
    if (lastSegment.length > 0 && lastSegment[0] >= 'a' && lastSegment[0] <= 'z') {
      return {
        className: target.substring(0, lastDotIndex),
        methodName: lastSegment,
      };
    }
  }
  return { className: target, methodName: undefined };
}

const healthError = DB.checkHealth();
if (healthError) {
  console.error(`
================================================================================
ERROR: Failed to initialize the database engine (better-sqlite3).

This is most likely because the prebuilt binary is not available for your
platform/Node.js version and the native compilation also failed.

The original error was:
  ${healthError}

To fix this on Windows:
  1. Install Visual Studio Build Tools with the "Desktop development with C++"
     workload from https://visualstudio.microsoft.com/visual-cpp-build-tools/
  2. Or run the following as Administrator:
       npm install -g windows-build-tools
  3. Then retry: npx -y maven-indexer-mcp

To fix this on Linux/macOS:
  1. Ensure build tools are installed (gcc, g++, make, python3)
  2. On Debian/Ubuntu: sudo apt-get install build-essential python3
  3. Then retry: npx -y maven-indexer-mcp

For more information, see:
  https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md

If you believe this is a bug, please report it at:
  https://github.com/tangcent/maven-indexer-mcp/issues
================================================================================
`);
  process.exit(1);
}

const SERVER_INSTRUCTIONS =
  "Reach for 'explore' first — ONE call usually answers 'how does this work / where is this used'. " +
  "The index auto-syncs; pass projectPath (absolute project root) on every call to pin versions to your project's dependencies.";

const server = new McpServer(
  {
    name: "maven-indexer",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

// Start indexing in the background
const indexer = Indexer.getInstance();
// We trigger indexing but don't await it so server can start
indexer.index().then(() => {
    // Start watching for changes after initial index
    indexer.startSchedule();
    return indexer.startWatch();
}).catch(err => console.error("Initial indexing failed:", err));

// ---------------------------------------------------------------------------
// Gating: register tools conditionally per MAVEN_INDEXER_MCP_TOOLS (Req 2).
// `explore` is always registered; the narrow tools only when opted in.
// ---------------------------------------------------------------------------
const enabled = resolveEnabledTools();

/**
 * Registers `name` only if it is in the enabled set. The MCP SDK's
 * `registerTool` makes a non-registered tool absent from `tools/list` AND
 * uncallable — satisfying the call-time gate (Req 2.5) implicitly.
 */
function maybeRegister(
  name: string,
  config: { description?: string; inputSchema?: unknown },
  handler: (args: any) => Promise<any>,
): void {
  if (!enabled.has(name)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool(name, config as any, handler as any);
}

// ---------------------------------------------------------------------------
// PRIMARY TOOL: explore (always registered)
// ---------------------------------------------------------------------------
maybeRegister('explore', {
  description: "PRIMARY TOOL — call FIRST for almost any question about a class, dependency, or call flow in the local Maven/Gradle artifact cache. Returns class source + implementations + callers/callees + call path in ONE capped response. Answers 'how does this work / where is this used' in a single call. projectPath is REQUIRED (MCP servers are launched globally with an unreliable cwd — state the project explicitly to pin versions to your project's dependencies).",
  inputSchema: z.object({
    identifiers: z.array(z.string()).describe("Bag of names: class names (FQCN or simple), coordinates (groupId:artifactId[:version]), method targets (Class.method), resource paths. At least one required."),
    coordinate: z.string().optional().describe("Pin artifact version for all class/method identifiers (groupId:artifactId:version)"),
    include: z.array(z.enum(['source','signatures','implementations','callers','callees','path','resources','dependencies','dependents'])).optional().describe("Sections to populate. Omit = default (signatures, implementations, callers, callees)."),
    maxLines: z.number().optional().describe("Line budget (default 200)"),
    question: z.string().optional().describe("Natural-language question (fallback to search-candidates mode when no identifier resolves)"),
    projectPath: z.string().describe("REQUIRED: absolute path to the project root. Used to pin version resolution to the project's dependencies."),
  }),
}, async (input: any) => {
  const result = await explore(input);
  const maxLines = input.maxLines ?? 200;
  const trimmed = trimForLlm('explore', result, { maxLines });
  const text = typeof trimmed === 'string'
    ? trimmed
    : renderForLlm('explore', result, { maxLines });
  return { content: [{ type: "text" as const, text }] };
});

// ---------------------------------------------------------------------------
// Narrow tools (defined; registered only when opted in via MAVEN_INDEXER_MCP_TOOLS)
// ---------------------------------------------------------------------------

maybeRegister('get_class',
  {
    description: "Retrieve the source code for a class from the local Maven/Gradle cache (containing internal company libraries). This tool identifies the containing artifact and returns the source code. It prefers actual source files but will fall back to decompilation if necessary. Use this primarily for internal company libraries that are not present in the current workspace. IMPORTANT: Even if the code compiles and imports work, the source code might not be in the current workspace (it comes from a compiled internal library). Use this tool to see the actual implementation of those internal libraries. Supports batch queries.",
    inputSchema: z.object({
      className: z.string().optional().describe("Fully qualified class name"),
      classNames: z.array(z.string()).optional().describe("Batch class names"),
      coordinate: z.string().optional().describe("The Maven coordinate of the artifact (groupId:artifactId:version). Optional: if not provided, the tool will automatically find the best match (preferring artifacts with source code). Applies to all classes in batch mode."),
      type: z.enum(["signatures", "docs", "source"]).describe("Type of detail to retrieve: 'signatures' (methods), 'docs' (javadocs + methods), 'source' (full source code)."),
    }),
  },
  async ({ className, classNames, coordinate, type }) => {
      const resolveOne = async (clsName: string, coord?: string): Promise<{ text: string; isError?: boolean }> => {

          let targetArtifact: Artifact | undefined;
          let resolvedClassName = clsName;

          if (coord) {
              const parts = coord.split(':');
              if (parts.length === 3) {
                 targetArtifact = indexer.getArtifactByCoordinate(parts[0], parts[1], parts[2]);
              } else {
                 return { text: "Invalid coordinate format. Expected groupId:artifactId:version", isError: true };
              }
              if (!targetArtifact) {
                  return { text: `Artifact ${coord} not found in index.`, isError: true };
              }
          } else {
              // Auto-resolve artifact if coordinate is missing
              const matches = indexer.searchClass(clsName);
              // Find exact match for class name
              const exactMatch = matches.find(m => m.className === clsName);

              if (!exactMatch) {
                   // Try inner class resolution: com.pkg.Outer.Inner -> find com.pkg.Outer
                   // Java inner classes use $ in bytecode but . in user-facing names
                   const parts = clsName.split('.');
                   let innerClassMatch: typeof matches[0] | undefined;
                   for (let i = parts.length - 1; i > 0; i--) {
                       const candidate = parts.slice(0, i).join('.');
                       const candidateMatches = indexer.searchClass(candidate);
                       const candidateExact = candidateMatches.find(m => m.className === candidate);
                       if (candidateExact) {
                           // Found the outer class, use $ notation for inner class
                           const innerPart = parts.slice(i).join('$');
                           resolvedClassName = candidate + '$' + innerPart;
                           innerClassMatch = candidateExact;
                           break;
                       }
                   }

                   if (!innerClassMatch) {
                       if (matches.length > 0) {
                           const suggestions = matches.map(m => `- ${m.className}`).join("\n");
                           return { text: `Class '${clsName}' not found exactly. Did you mean:\n${suggestions}`, isError: true };
                       }
                       return { text: `Class '${clsName}' not found in the index. Try 'search_classes' with a keyword if you are unsure of the full name.`, isError: true };
                   }
                   // Use the outer class's artifact but decompile the inner class
                   const bestArt = await ArtifactResolver.resolveBestArtifact(innerClassMatch.artifacts);
                   if (!bestArt) {
                       return { text: `Class '${clsName}' found but no artifacts are associated with it.`, isError: true };
                   }
                   targetArtifact = bestArt;
              } else {
                  // We have an exact match, choose the best artifact
                  const bestArtifact = await ArtifactResolver.resolveBestArtifact(exactMatch.artifacts);

                  if (!bestArtifact) {
                      return { text: `Class '${clsName}' found but no artifacts are associated with it (database inconsistency).`, isError: true };
                  }

                  targetArtifact = bestArtifact;
              }
          }

          const artifact = targetArtifact;

          let detail: Awaited<ReturnType<typeof SourceParser.getClassDetail>> = null;
          let usedDecompilation = false;
          let lastError = "";

          // 1. If requesting source/docs, try Source JAR first
          if (type === 'source' || type === 'docs') {
              if (artifact.hasSource) {
                  const sourceJarPath = resolveSourcesJar(artifact);
                  try {
                      detail = await SourceParser.getClassDetail(sourceJarPath, resolvedClassName, type);
                  } catch (e: any) {
                      // Ignore error and fallthrough to main jar (decompilation)
                      lastError = e.message;
                  }
              }

              // If not found in source jar (or no source jar), try main jar (decompilation)
              if (!detail) {
                 const mainJarPath = resolveMainJar(artifact);
                 try {
                     // SourceParser will try to decompile if source file not found in jar
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
              // Signatures -> Use Main JAR
              const mainJarPath = resolveMainJar(artifact);
              try {
                  detail = await SourceParser.getClassDetail(mainJarPath, resolvedClassName, type);
              } catch (e: any) {
                  lastError = e.message;
              }
          }

          try {
              // Check for proto resources in the SAME artifact only (no cross-artifact mixing)
              // Try exact class name first, then walk up to find outer class
              const getResourcesFromArtifact = (name: string) =>
                  indexer.getResourcesForClassInArtifact(name, artifact.id);

              let resources = getResourcesFromArtifact(clsName);
              if (resources.length === 0) {
                  // Walk up the class name to find outer class resources in same artifact
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

              // If no resources in the resolved artifact, search across all artifacts
              // but only use resources (proto), not decompiled code from a different artifact
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
                  const errorMsg = lastError ? `\nLast error: ${lastError}` : "";
                  return { text: `Class ${clsName} not found in artifact ${artifact.artifactId}. \nDebug info: ${debugInfo}${errorMsg}`, isError: true };
              }

              let resultText = '';

              // Only show decompiled/source if resources come from the same artifact
              // (avoid mixing compiled code from one artifact with proto from another)
              if (detail && !resourcesFromDifferentArtifact) {
                  resultText += `### Class: ${detail.className}\n`;
                  resultText += `Artifact: ${artifact.groupId}:${artifact.artifactId}:${artifact.version}\n\n`;

                  if (usedDecompilation) {
                      resultText += "*Source code decompiled from binary class file.*\n\n";
                  }

                  if (type === 'source') {
                      const lang = detail.language || 'java';
                      resultText += "```" + lang + "\n" + detail.source + "\n```";
                  } else {
                      if (detail.doc) {
                          resultText += "Documentation:\n" + detail.doc + "\n\n";
                      }
                      if (detail.signatures) {
                          resultText += "Methods:\n" + detail.signatures.join("\n") + "\n";
                      }
                  }
              } else if (!detail) {
                  resultText += `### Class: ${clsName}\n`;
                  resultText += `Artifact: ${artifact.groupId}:${artifact.artifactId}:${artifact.version}\n\n`;
              }

              // Append related resources if any
              if (allResources.length > 0) {
                  resultText += "\n\n### Related Resources\n";
                  for (const res of allResources) {
                      const lang = res.type === 'proto' ? 'protobuf' : res.type;
                      resultText += `\n**${res.path}** (${res.type})\n\`\`\`${lang}\n${res.content}\n\`\`\`\n`;
                  }
              }

              return { text: resultText };
          } catch (e: any) {
              return { text: `Error reading source: ${e.message}`, isError: true };
          }
      };

      const allNames: string[] = [];
      if (className) allNames.push(className);
      if (classNames) allNames.push(...classNames);

      if (allNames.length === 0) {
          return { content: [{ type: "text", text: "No class name provided." }], isError: true };
      }

      const results = await Promise.all(allNames.map(name => resolveOne(name, coordinate)));
      // Mark the batch as an error only when every result is an error.
      const allErrored = results.length > 0 && results.every(r => r.isError);

      return {
          content: [{ type: "text", text: results.map(r => r.text).join("\n\n") }],
          ...(allErrored ? { isError: true } : {})
      };
  }
);

maybeRegister('search_artifacts',
  {
    description: "Search for internal company artifacts and libraries in the local Maven repository and Gradle caches by coordinate (groupId, artifactId), keyword, or class name. Use this primarily for internal company packages or to find available versions of internal projects that are locally built. Also supports searching third-party libraries in the local cache. Supports batch queries.",
    inputSchema: z.object({
      query: z.string().optional().describe("Search query (groupId, artifactId, keyword, or class name)"),
      queries: z.array(z.string()).optional().describe("Batch search queries"),
    }),
  },
  async ({ query, queries }) => {
    const allQueries: string[] = [];
    if (query) allQueries.push(query);
    if (queries) allQueries.push(...queries);

    if (allQueries.length === 0) {
        return { content: [{ type: "text", text: "No query provided." }], isError: true };
    }

    const results = allQueries.map(q => {
        let allMatches: Artifact[] = [];
        let searchType = "artifact";
        
        // First try class search (for both simple and fully qualified class names)
        const classSearchResults = indexer.searchClass(q);
        if (classSearchResults.length > 0) {
          // Extract unique artifacts from class search results
          const artifactMap = new Map<string, Artifact>();
          classSearchResults.forEach(result => {
            result.artifacts.forEach(artifact => {
              const key = `${artifact.groupId}:${artifact.artifactId}:${artifact.version}`;
              if (!artifactMap.has(key)) {
                artifactMap.set(key, artifact);
              }
            });
          });
          allMatches = Array.from(artifactMap.values());
          searchType = "class";
        } else {
          // Fallback to artifact search if class search finds nothing
          allMatches = indexer.search(q);
        }
        
        // Limit results to avoid overflow
        const limitedMatches = allMatches.slice(0, 20);
        
        const text = limitedMatches.length > 0
            ? limitedMatches.map(a => `${a.groupId}:${a.artifactId}:${a.version} (Has Source: ${a.hasSource})`).join("\n")
            : "No artifacts found matching the query.";

        return `### Results for "${q}" (Found ${allMatches.length} via ${searchType} search${allMatches.length > 20 ? ', showing first 20' : ''}):\n${text}`;
    });

    return {
      content: [
        {
          type: "text",
          text: results.join("\n\n"),
        },
      ],
    }
  }
);

maybeRegister('search',
  {
    description: "Search for Java classes in internal company libraries found in the local Maven/Gradle caches. Essential for finding classes in internal company libraries that are not part of the current workspace source code. Use this when you see an import (e.g., 'com.company.util.Helper') but cannot find the definition. Do not assume that because the code compiles or the import exists, the source is local. It often comes from a compiled internal library. This tool helps locate the defining artifact. Supports batch queries.",
    inputSchema: z.object({
      className: z.string().optional().describe("Fully qualified class name, partial name, or keywords describing the class purpose (e.g. 'JsonToXml')."),
      classNames: z.array(z.string()).optional().describe("Batch class names"),
    }),
  },
  async ({ className, classNames }) => {
    const allNames: string[] = [];
    if (className) allNames.push(className);
    if (classNames) allNames.push(...classNames);

    if (allNames.length === 0) {
        return { content: [{ type: "text", text: "No class name provided." }], isError: true };
    }

    const results = allNames.map(name => {
        const matches = indexer.searchClass(name);

        const text = matches.length > 0
            ? matches.map(m => {
                // Group by artifact ID to allow easy selection
                const artifacts = m.artifacts.slice(0, 3).map(a => `${a.groupId}:${a.artifactId}:${a.version}${a.hasSource ? ' (Has Source)' : ''}`).join("\n    ");
                const more = m.artifacts.length > 3 ? `\n    ... (${m.artifacts.length - 3} more)` : '';
                return `Class: ${m.className}\n    ${artifacts}${more}`;
            }).join("\n\n")
            : "No classes found matching the query. Try different keywords.";
        
        return `### Results for "${name}":\n${text}`;
    });

    return {
        content: [{ type: "text", text: results.join("\n\n") }]
    };
  }
);

maybeRegister('implementations',
  {
    description: "Search for internal implementations of an interface or base class. This is particularly useful for finding implementations of SPIs or base classes within internal company libraries in the local Maven/Gradle cache. Supports batch queries.",
    inputSchema: z.object({
      className: z.string().optional().describe("Fully qualified class name of the interface or base class (e.g. 'java.util.List')"),
      classNames: z.array(z.string()).optional().describe("Batch class names"),
    }),
  },
  async ({ className, classNames }) => {
    const allNames: string[] = [];
    if (className) allNames.push(className);
    if (classNames) allNames.push(...classNames);

    if (allNames.length === 0) {
        return { content: [{ type: "text", text: "No class name provided." }], isError: true };
    }

    const results = allNames.map(name => {
        const matches = indexer.searchImplementations(name);

        const text = matches.length > 0
            ? matches.map(m => {
                const artifacts = m.artifacts.slice(0, 3).map(a => `${a.groupId}:${a.artifactId}:${a.version}`).join("\n    ");
                const more = m.artifacts.length > 3 ? `\n    ... (${m.artifacts.length - 3} more)` : '';
                return `Implementation: ${m.className}\n    ${artifacts}${more}`;
            }).join("\n\n")
            : `No implementations found for ${name}. Ensure the index is up to date and the class name is correct.`;
        
        return `### Results for "${name}":\n${text}`;
    });

    return {
        content: [{ type: "text", text: results.join("\n\n") }]
    };
  }
);

maybeRegister('search_resources',
  {
    description: "Search for text resources (non-class files) inside indexed JARs. Supports .properties, .xml, .json, .yaml/.yml, and META-INF/services/* entries up to 64KB. Use 'glob:' prefix for glob patterns, 'regex:' prefix for regex, otherwise substring match on the path.",
    inputSchema: z.object({
      pattern: z.string().describe("Resource path pattern: plain substring (default), 'glob:*.xml', or 'regex:\\.properties$'. Matches against the in-JAR path (e.g. 'META-INF/services/java.sql.Driver')."),
    }),
  },
  async ({ pattern }) => {
    const matches = indexer.searchResources(pattern);
    
    const text = matches.length > 0
        ? matches.map(m => `Resource: ${m.path}\n    Artifact: ${m.artifact.groupId}:${m.artifact.artifactId}:${m.artifact.version}`).join("\n\n")
        : `No resources found matching '${pattern}'.`;

    return {
      content: [{ type: "text", text }]
    };
  }
);

maybeRegister('search_methods',
  {
    description: "Search for Java methods by name across indexed artifacts in the local Maven/Gradle caches. Returns matching method names with their declaring class and the artifacts that contain them. Requires method indexing to be enabled (INDEX_METHODS=1). Supports batch queries.",
    inputSchema: z.object({
      name: z.string().optional().describe("Method name (or substring) to search for"),
      names: z.array(z.string()).optional().describe("Batch method names"),
      exact: z.boolean().optional().describe("Exact match (default: substring match)"),
    }),
  },
  async ({ name, names, exact }) => {
    const allNames: string[] = [];
    if (name) allNames.push(name);
    if (names) allNames.push(...names);

    if (allNames.length === 0) {
        return { content: [{ type: "text", text: "No method name provided." }], isError: true };
    }

    const results = allNames.map(n => {
        const matches = indexer.searchMethods(n, { exact });

        const text = matches.length > 0
            ? matches.map(m => {
                const artifacts = m.artifacts.slice(0, 3).map(a => `${a.groupId}:${a.artifactId}:${a.version}`).join("\n    ");
                const more = m.artifacts.length > 3 ? `\n    ... (${m.artifacts.length - 3} more)` : '';
                return `Method: ${m.methodName}\n  Class: ${m.className}\n    ${artifacts}${more}`;
              }).join("\n\n")
            : `No methods found matching '${n}'. Ensure method indexing is enabled (INDEX_METHODS=1) and the index is up to date.`;

        return `### Results for "${n}":\n${text}`;
    });

    return {
        content: [{ type: "text", text: results.join("\n\n") }]
    };
  }
);

maybeRegister('callers',
  {
    description: "List callers (methods that invoke) a class or method from the call-graph index. Target format: 'className' (all methods) or 'className.methodName' (specific method). Requires call-graph indexing (enabled by default; opt out with INDEX_CALL_GRAPH=0).",
    inputSchema: z.object({
      target: z.string().describe("Class name (e.g. 'com.example.Foo') or Class.method (e.g. 'com.example.Foo.bar')"),
      limit: z.number().optional().describe("Maximum number of edges to return (default 50, max 500)"),
    }),
  },
  async ({ target, limit }) => {
    const { className, methodName } = parseTarget(target);
    const edges = indexer.searchCallers(className, methodName, limit ?? 50);
    const callGraphAvailable = indexer.isCallGraphAvailable();

    if (!callGraphAvailable) {
      return {
        content: [{ type: "text", text: `Call-graph index is empty (INDEX_CALL_GRAPH=0 or no artifacts indexed). No callers for ${target}.` }],
      };
    }

    if (edges.length === 0) {
      return {
        content: [{ type: "text", text: `No callers found for ${target}.` }],
      };
    }

    const text = edges.map(edge => {
      const desc = edge.methodDescriptor ? ` ${edge.methodDescriptor}` : '';
      const resolved = edge.resolved ? '' : ' [unresolved]';
      const sites = edge.sites > 1 ? ` (${edge.sites} sites)` : '';
      const arts = edge.artifacts.length > 0
        ? edge.artifacts.slice(0, 3).map(a => `    ${a.groupId}:${a.artifactId}:${a.version}`).join('\n')
        : '    (no indexed artifact)';
      const more = edge.artifacts.length > 3 ? `\n    ... (${edge.artifacts.length - 3} more)` : '';
      return `Caller: ${edge.className}.${edge.methodName}${desc} [${edge.invokeKind}]${resolved}${sites}\n${arts}${more}`;
    }).join('\n\n');

    return { content: [{ type: "text", text }] };
  }
);

maybeRegister('callees',
  {
    description: "List callees (methods invoked by) a class or method from the call-graph index. Target format: 'className' (all methods) or 'className.methodName' (specific method). Requires call-graph indexing (enabled by default; opt out with INDEX_CALL_GRAPH=0).",
    inputSchema: z.object({
      target: z.string().describe("Class name (e.g. 'com.example.Foo') or Class.method (e.g. 'com.example.Foo.bar')"),
      limit: z.number().optional().describe("Maximum number of edges to return (default 50, max 500)"),
    }),
  },
  async ({ target, limit }) => {
    const { className, methodName } = parseTarget(target);
    const edges = indexer.searchCallees(className, methodName, limit ?? 50);
    const callGraphAvailable = indexer.isCallGraphAvailable();

    if (!callGraphAvailable) {
      return {
        content: [{ type: "text", text: `Call-graph index is empty (INDEX_CALL_GRAPH=0 or no artifacts indexed). No callees for ${target}.` }],
      };
    }

    if (edges.length === 0) {
      return {
        content: [{ type: "text", text: `No callees found for ${target}.` }],
      };
    }

    const text = edges.map(edge => {
      const desc = edge.methodDescriptor ? ` ${edge.methodDescriptor}` : '';
      const resolved = edge.resolved ? '' : ' [unresolved]';
      const sites = edge.sites > 1 ? ` (${edge.sites} sites)` : '';
      const arts = edge.artifacts.length > 0
        ? edge.artifacts.slice(0, 3).map(a => `    ${a.groupId}:${a.artifactId}:${a.version}`).join('\n')
        : '    (no indexed artifact)';
      const more = edge.artifacts.length > 3 ? `\n    ... (${edge.artifacts.length - 3} more)` : '';
      return `Callee: ${edge.className}.${edge.methodName}${desc} [${edge.invokeKind}]${resolved}${sites}\n${arts}${more}`;
    }).join('\n\n');

    return { content: [{ type: "text", text }] };
  }
);

maybeRegister('impact',
  {
    description: "Show the transitive impact (callers-of-callers) of a class or method via BFS up to a depth cap. Useful for assessing blast radius of a change. Target format: 'className' or 'className.methodName'. Requires call-graph indexing.",
    inputSchema: z.object({
      target: z.string().describe("Class name (e.g. 'com.example.Foo') or Class.method (e.g. 'com.example.Foo.bar')"),
      depth: z.number().optional().describe("Maximum traversal depth (default 3, max 5)"),
      maxNodes: z.number().optional().describe("Maximum nodes to return (default 200, max 1000)"),
    }),
  },
  async ({ target, depth, maxNodes }) => {
    const { className, methodName } = parseTarget(target);
    const result = indexer.impact(className, methodName, { depth, maxNodes });

    if (!result.callGraphAvailable) {
      return {
        content: [{ type: "text", text: `Call-graph index is empty (INDEX_CALL_GRAPH=0 or no artifacts indexed). No impact for ${target}.` }],
      };
    }

    if (result.nodes.length === 0) {
      return {
        content: [{ type: "text", text: `No impact (transitive callers) found for ${target}.` }],
      };
    }

    const header = `Impact of ${target} (${result.nodes.length} nodes, depth ${result.maxDepth}, max ${result.maxNodes})${result.truncated > 0 ? `, truncated ${result.truncated}` : ''}:`;
    const lines = result.nodes.map(node => {
      const label = node.methodName ? `${node.className}.${node.methodName}` : node.className;
      const cycle = node.cycle ? ' [cycle]' : '';
      return `  [d${node.depth}] ${label}${cycle}  via  ${node.path.join(' -> ')}`;
    });
    return { content: [{ type: "text", text: [header, ...lines].join('\n') }] };
  }
);

maybeRegister('info',
  {
    description: "Get detailed info about one or more artifacts matching a Maven coordinate. Returns the artifact path, layout, hasSource flag, indexed class count, indexed resource count, and whether the main JAR file still exists on disk. If version is omitted, returns info for every known version of the artifact.",
    inputSchema: z.object({
      coordinate: z.string().describe("Maven coordinate in the form 'groupId:artifactId' (lists all versions) or 'groupId:artifactId:version' (specific version)."),
    }),
  },
  async ({ coordinate }) => {
      const parts = coordinate.split(':');
      if (parts.length < 2 || parts.length > 3) {
          return { content: [{ type: "text", text: "Invalid coordinate format. Expected 'groupId:artifactId' or 'groupId:artifactId:version'." }], isError: true };
      }
      const [groupId, artifactId, version] = parts;
      const items = indexer.getArtifactInfo(groupId, artifactId, version);

      if (items.length === 0) {
          return { content: [{ type: "text", text: `No artifact found for coordinate '${coordinate}'.` }], isError: true };
      }

      const text = items.map((item: ArtifactInfo) => {
          const a = item.artifact;
          return [
              `### ${a.groupId}:${a.artifactId}:${a.version}`,
              `- Path: ${a.abspath}`,
              `- Layout: ${a.layout ?? 'unknown'}`,
              `- Has Source: ${a.hasSource}`,
              `- Main JAR Exists: ${item.mainJarExists}`,
              `- Class Count: ${item.classCount}`,
              `- Resource Count: ${item.resourceCount}`,
          ].join('\n');
      }).join('\n\n');

      return { content: [{ type: "text", text }] };
  }
);

maybeRegister('stats',
  {
    description: "Return aggregate statistics about the local Maven/Gradle index: total artifact count, indexed class count, indexed resource count, the SQLite DB file path and size in bytes, and the last-indexed timestamp (ISO string). Useful for sanity-checking index health and freshness.",
    inputSchema: z.object({}),
  },
  async () => {
      const stats: IndexStats = indexer.getStats();
      const lines = [
          '### Index Statistics',
          `- DB Path: ${stats.dbPath}`,
          `- DB Size: ${stats.dbSizeBytes} bytes`,
          `- Last Indexed At: ${stats.lastIndexedAt ?? 'never'}`,
          `- Artifact Count: ${stats.artifactCount}`,
          `- Class Count: ${stats.classCount}`,
          `- Resource Count: ${stats.resourceCount}`,
      ];
      if (stats.skippedByExcludes && stats.skippedByExcludes > 0) {
          lines.push(`- Skipped By Excludes: ${stats.skippedByExcludes}`);
      }
      const text = lines.join('\n');
      return { content: [{ type: "text", text }] };
  }
);

maybeRegister('list_classes',
  {
    description: "List all distinct Java/protobuf class names indexed for a specific Maven artifact coordinate. Useful for inspecting what classes an internal company library exposes. The coordinate MUST include the version.",
    inputSchema: z.object({
      coordinate: z.string().describe("Full Maven coordinate 'groupId:artifactId:version'. Version is required."),
    }),
  },
  async ({ coordinate }) => {
      const parts = coordinate.split(':');
      if (parts.length !== 3) {
          return { content: [{ type: "text", text: "Invalid coordinate format. Expected 'groupId:artifactId:version'." }], isError: true };
      }
      const [groupId, artifactId, version] = parts;
      const classes = indexer.listClasses(groupId, artifactId, version);

      if (classes.length === 0) {
          return { content: [{ type: "text", text: `No classes found for artifact '${coordinate}'. Ensure the coordinate is correct and the artifact has been indexed.` }], isError: true };
      }

      const text = `### Classes in ${coordinate} (${classes.length} total)\n` + classes.map(c => `- ${c}`).join('\n');
      return { content: [{ type: "text", text }] };
  }
);

maybeRegister('get_resource',
  {
    description: "Retrieve the content of a single indexed text resource (proto file, XML, properties, JSON, YAML, META-INF/services/*) inside an artifact JAR. The coordinate MUST include the version. Returns the resource content, type label, and path. Resources larger than 64KB are not stored and will report as not found.",
    inputSchema: z.object({
      coordinate: z.string().describe("Full Maven coordinate 'groupId:artifactId:version'. Version is required."),
      resourcePath: z.string().describe("In-JAR path of the resource (e.g. 'META-INF/services/java.sql.Driver' or 'config/app.proto')."),
    }),
  },
  async ({ coordinate, resourcePath }) => {
      const parts = coordinate.split(':');
      if (parts.length !== 3) {
          return { content: [{ type: "text", text: "Invalid coordinate format. Expected 'groupId:artifactId:version'." }], isError: true };
      }
      const [groupId, artifactId, version] = parts;
      const resource = indexer.getResource(groupId, artifactId, version, resourcePath);

      if (!resource) {
          return { content: [{ type: "text", text: `Resource '${resourcePath}' not found in artifact '${coordinate}'.` }], isError: true };
      }

      const lang = resource.type === 'proto' ? 'protobuf' : resource.type;
      const text = `### Resource: ${resource.path}\nArtifact: ${coordinate}\nType: ${resource.type}\n\n\`\`\`${lang}\n${resource.content}\n\`\`\``;
      return { content: [{ type: "text", text }] };
  }
);

maybeRegister('dependencies',
  {
    description: "Return the parsed Maven `<dependencies>` of an artifact (groupId:artifactId:version). Each entry includes groupId, artifactId, version (empty string when the POM omits it), scope (defaults to 'compile'), and the optional flag. Useful for understanding what an internal company library transitively pulls in. Requires the full coordinate including version.",
    inputSchema: z.object({
      coordinate: z.string().describe("Full Maven coordinate 'groupId:artifactId:version'. Version is required."),
    }),
  },
  async ({ coordinate }) => {
      const parts = coordinate.split(':');
      if (parts.length !== 3) {
          return { content: [{ type: "text", text: "Invalid coordinate format. Expected 'groupId:artifactId:version'." }], isError: true };
      }
      const [groupId, artifactId, version] = parts;
      const deps = indexer.getDependencies(groupId, artifactId, version);

      if (deps.length === 0) {
          return { content: [{ type: "text", text: `No dependencies indexed for '${coordinate}'. Ensure the coordinate is correct and the artifact has been (re)indexed after POM parsing was enabled.` }], isError: true };
      }

      const text = `### Dependencies of ${coordinate} (${deps.length} total)\n` + deps.map(d => {
          const versionPart = d.version ? `:${d.version}` : '';
          const optPart = d.optional ? ' (optional)' : '';
          return `- ${d.groupId}:${d.artifactId}${versionPart} (scope: ${d.scope})${optPart}`;
      }).join('\n');
      return { content: [{ type: "text", text }] };
  }
);

maybeRegister('dependents',
  {
    description: "Find indexed artifacts that declare a dependency on the given coordinate. Matching is by groupId:artifactId only — version is optional in the input. Returns each dependent artifact's full coordinate and the declared scope (defaults to 'compile'). Useful for impact analysis when changing an internal library.",
    inputSchema: z.object({
      coordinate: z.string().describe("Maven coordinate 'groupId:artifactId' or 'groupId:artifactId:version'. Version is optional — dependents are matched by groupId:artifactId only."),
    }),
  },
  async ({ coordinate }) => {
      const parts = coordinate.split(':');
      if (parts.length < 2 || parts.length > 3) {
          return { content: [{ type: "text", text: "Invalid coordinate format. Expected 'groupId:artifactId' or 'groupId:artifactId:version'." }], isError: true };
      }
      const [groupId, artifactId] = parts;
      const dependents = indexer.findDependents(groupId, artifactId);

      if (dependents.length === 0) {
          return { content: [{ type: "text", text: `No indexed artifacts depend on '${groupId}:${artifactId}'.` }], isError: true };
      }

      const text = `### Dependents of ${groupId}:${artifactId} (${dependents.length} total)\n` + dependents.map(d => {
          return `- ${d.groupId}:${d.artifactId}:${d.version} (scope: ${d.scope})`;
      }).join('\n');
      return { content: [{ type: "text", text }] };
  }
);

// ---------------------------------------------------------------------------
// project_context (Module 8) — inspect the active project's build + dependency
// tree. Useful when version resolution surprises you (Req 6.3).
// ---------------------------------------------------------------------------
maybeRegister('project_context', {
  description: "Inspect the active project's Maven/Gradle context (declared and resolved dependency tree, build file, project coordinate). Useful when version resolution surprises you.",
  inputSchema: z.object({
    projectPath: z.string().describe("REQUIRED: absolute path to the project root."),
  }),
}, async ({ projectPath }: { projectPath: string }) => {
  const ctx = await getProjectContext(projectPath);
  return { content: [{ type: "text" as const, text: JSON.stringify(ctx, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown (T3.7): stop watcher + timers, close DB, exit 0.
async function shutdown() {
  try {
    await indexer.stopWatch();
    indexer.stopSchedule();
    DB.getInstance().close();
  } catch (e) {
    console.error("Error during shutdown:", e);
  }
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
