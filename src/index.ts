#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Indexer, Artifact, ArtifactInfo, IndexStats } from "./indexer.js";
import { SourceParser } from "./source_parser.js";
import { ArtifactResolver } from "./artifact_resolver.js";
import { resolveMainJar, resolveSourcesJar } from "./path_helpers.js";
import { DB } from "./db/index.js";

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

server.registerTool(
  "get_class_details",
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

          let targetArtifact: import("./indexer.js").Artifact | undefined;
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

server.registerTool(
  "search_artifacts",
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

server.registerTool(
  "search_classes",
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

server.registerTool(
  "search_implementations",
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

server.registerTool(
  "search_resources",
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

server.registerTool(
  "search_methods",
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

server.registerTool(
  "refresh_index",
  {
    description: "Trigger a re-scan of the Maven repository. Re-indexes all artifacts into shadow tables and atomically swaps on success. Returns an error result if the refresh fails.",
  },
  async () => {
       try {
           await indexer.refresh();
           return {
               content: [{ type: "text", text: "Index refresh complete. All artifacts have been re-indexed." }]
           };
       } catch (e) {
           const message = e instanceof Error ? e.message : String(e);
           return {
               isError: true,
               content: [{ type: "text", text: `Index refresh failed: ${message}` }]
           };
       }
   }
);

server.registerTool(
  "info",
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

server.registerTool(
  "stats",
  {
    description: "Return aggregate statistics about the local Maven/Gradle index: total artifact count, indexed class count, indexed resource count, the SQLite DB file path and size in bytes, and the last-indexed timestamp (ISO string). Useful for sanity-checking index health and freshness.",
    inputSchema: z.object({}),
  },
  async () => {
      const stats: IndexStats = indexer.getStats();
      const text = [
          '### Index Statistics',
          `- DB Path: ${stats.dbPath}`,
          `- DB Size: ${stats.dbSizeBytes} bytes`,
          `- Last Indexed At: ${stats.lastIndexedAt ?? 'never'}`,
          `- Artifact Count: ${stats.artifactCount}`,
          `- Class Count: ${stats.classCount}`,
          `- Resource Count: ${stats.resourceCount}`,
      ].join('\n');
      return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "list_classes",
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

server.registerTool(
  "get_resource",
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

server.registerTool(
  "get_dependencies",
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

server.registerTool(
  "find_dependents",
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
