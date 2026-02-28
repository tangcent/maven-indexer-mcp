#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from 'path';
import { z } from "zod";
import { Indexer, Artifact } from "./indexer.js";
import { SourceParser } from "./source_parser.js";
import { ArtifactResolver } from "./artifact_resolver.js";

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
      const resolveOne = async (clsName: string, coord?: string) => {

          let targetArtifact: import("./indexer.js").Artifact | undefined;

          if (coord) {
              const parts = coord.split(':');
              if (parts.length === 3) {
                 targetArtifact = indexer.getArtifactByCoordinate(parts[0], parts[1], parts[2]);
              } else {
                 return "Invalid coordinate format. Expected groupId:artifactId:version";
              }
              if (!targetArtifact) {
                  return `Artifact ${coord} not found in index.`;
              }
          } else {
              // Auto-resolve artifact if coordinate is missing
              const matches = indexer.searchClass(clsName);
              // Find exact match for class name
              const exactMatch = matches.find(m => m.className === clsName);
              
              if (!exactMatch) {
                   // If no exact match, but we have some results, list them
                   if (matches.length > 0) {
                       const suggestions = matches.map(m => `- ${m.className}`).join("\n");
                       return `Class '${clsName}' not found exactly. Did you mean:\n${suggestions}`;
                   }
                   indexer.triggerReindex(10);
                   return `Class '${clsName}' not found in the index. Try 'search_classes' with a keyword if you are unsure of the full name.`;
              }

              // We have an exact match, choose the best artifact
              const bestArtifact = await ArtifactResolver.resolveBestArtifact(exactMatch.artifacts);

              if (!bestArtifact) {
                  return `Class '${clsName}' found but no artifacts are associated with it (database inconsistency).`;
              }

              targetArtifact = bestArtifact;
          }

          const artifact = targetArtifact;

          let detail: Awaited<ReturnType<typeof SourceParser.getClassDetail>> = null;
          let usedDecompilation = false;
          let lastError = "";

          // 1. If requesting source/docs, try Source JAR first
          if (type === 'source' || type === 'docs') {
              if (artifact.hasSource) {
                  const sourceJarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}-sources.jar`);
                  try {
                      detail = await SourceParser.getClassDetail(sourceJarPath, clsName, type);
                  } catch (e: any) {
                      // Ignore error and fallthrough to main jar (decompilation)
                      lastError = e.message;
                  }
              }
              
              // If not found in source jar (or no source jar), try main jar (decompilation)
              if (!detail) {
                 let mainJarPath = artifact.abspath;
                 if (!mainJarPath.endsWith('.jar')) {
                     mainJarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}.jar`);
                 }
                 try {
                     // SourceParser will try to decompile if source file not found in jar
                     detail = await SourceParser.getClassDetail(mainJarPath, clsName, type);
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
              let mainJarPath = artifact.abspath;
              if (!mainJarPath.endsWith('.jar')) {
                  mainJarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}.jar`);
              }
              try {
                  detail = await SourceParser.getClassDetail(mainJarPath, clsName, type);
              } catch (e: any) {
                  lastError = e.message;
              }
          }
          
          try {
              if (!detail) {
                  const debugInfo = `Artifact path: ${artifact.abspath}, hasSource: ${artifact.hasSource}`;
                  const errorMsg = lastError ? `\nLast error: ${lastError}` : "";
                  return `Class ${clsName} not found in artifact ${artifact.artifactId}. \nDebug info: ${debugInfo}${errorMsg}`;
              }

              let resultText = `### Class: ${detail.className}\n`;
              resultText += `Artifact: ${artifact.groupId}:${artifact.artifactId}:${artifact.version}\n\n`; // Inform user which artifact was used
              
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

              // Append related resources if any
              const resources = indexer.getResourcesForClass(clsName);
              if (resources.length > 0) {
                  resultText += "\n\n### Related Resources\n";
                  for (const res of resources) {
                      const lang = res.type === 'proto' ? 'protobuf' : res.type;
                      resultText += `\n**${res.path}** (${res.type})\n\`\`\`${lang}\n${res.content}\n\`\`\`\n`;
                  }
              }

              return resultText;
          } catch (e: any) {
              return `Error reading source: ${e.message}`;
          }
      };

      const allNames: string[] = [];
      if (className) allNames.push(className);
      if (classNames) allNames.push(...classNames);

      if (allNames.length === 0) {
          return { content: [{ type: "text", text: "No class name provided." }] };
      }

      const results = await Promise.all(allNames.map(name => resolveOne(name, coordinate)));

      return { content: [{ type: "text", text: results.join("\n\n") }] };
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
        return { content: [{ type: "text", text: "No query provided." }] };
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
        return { content: [{ type: "text", text: "No class name provided." }] };
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
        return { content: [{ type: "text", text: "No class name provided." }] };
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
    description: "Search for resources (non-class files) inside JARs, such as properties files, XML configs, or proto files.",
    inputSchema: z.object({
      pattern: z.string().describe("Partial path or filename pattern to search for (e.g. 'log4j.xml', '.proto')"),
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
  "refresh_index",
  {
    description: "Trigger a re-scan of the Maven repository. This will re-index all artifacts.",
  },
  async () => {
       // Re-run index
       indexer.refresh().catch(console.error);
       return {
           content: [{ type: "text", text: "Index refresh started. All artifacts will be re-indexed." }]
       };
   }
);

const transport = new StdioServerTransport();
await server.connect(transport);
