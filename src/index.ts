#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from 'path';
import { z } from "zod";
import { Indexer } from "./indexer.js";
import { SourceParser } from "./source_parser.js";

const server = new McpServer(
  {
    name: "maven-indexer",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Start indexing in the background
const indexer = Indexer.getInstance();
// We trigger indexing but don't await it so server can start
indexer.index().then(() => {
    // Start watching for changes after initial index
    return indexer.startWatch();
}).catch(err => console.error("Initial indexing failed:", err));

server.registerTool(
  "search_artifacts",
  {
    description: "Search for Maven artifacts (libraries) in the local repository by coordinate (groupId, artifactId) or keyword. Use this to find available versions of a library.",
    inputSchema: z.object({
      query: z.string().describe("Search query (groupId, artifactId, or keyword)"),
    }),
  },
  async ({ query }) => {
    const matches = indexer.search(query);
    
    // Limit results to avoid overflow
    const limitedMatches = matches.slice(0, 20);
    
    const text = limitedMatches.length > 0
        ? limitedMatches.map(a => `[ID: ${a.id}] ${a.groupId}:${a.artifactId}:${a.version} (Has Source: ${a.hasSource})`).join("\n")
        : "No artifacts found matching the query.";

    return {
      content: [
        {
          type: "text",
          text: `Found ${matches.length} matches${matches.length > 20 ? ' (showing first 20)' : ''}:\n${text}`,
        },
      ],
    };
  }
);

server.registerTool(
  "search_classes",
  {
    description: "Search for Java classes in the local Maven repository. WHEN TO USE: 1. You cannot find a class definition in the current project source (it's likely a dependency). 2. You need to read the source code, method signatures, or Javadocs of an external library class. 3. You need to verify which version of a library class is being used. Examples: 'Show me the source of StringUtils', 'What methods are available on DateTimeUtils?', 'Where is this class imported from?'.",
    inputSchema: z.object({
      className: z.string().describe("Fully qualified class name, partial name, or keywords describing the class purpose (e.g. 'JsonToXml')."),
    }),
  },
  async ({ className }) => {
    const matches = indexer.searchClass(className);

    const text = matches.length > 0
        ? matches.map(m => {
            // Group by artifact ID to allow easy selection
            const artifacts = m.artifacts.slice(0, 5).map(a => `[ID: ${a.id}] ${a.groupId}:${a.artifactId}:${a.version}${a.hasSource ? ' (Has Source)' : ''}`).join("\n    ");
            const more = m.artifacts.length > 5 ? `\n    ... (${m.artifacts.length - 5} more versions)` : '';
            return `Class: ${m.className}\n    ${artifacts}${more}`;
        }).join("\n\n")
        : "No classes found matching the query. Try different keywords.";

    return {
        content: [{ type: "text", text }]
    };
  }
);

server.registerTool(
  "search_implementations",
  {
    description: "Search for classes that implement a specific interface or extend a specific class. This is useful for finding implementations of SPIs or base classes, especially in external libraries.",
    inputSchema: z.object({
      className: z.string().describe("Fully qualified class name of the interface or base class (e.g. 'java.util.List')"),
    }),
  },
  async ({ className }) => {
    const matches = indexer.searchImplementations(className);

    const text = matches.length > 0
        ? matches.map(m => {
            const artifacts = m.artifacts.slice(0, 5).map(a => `[ID: ${a.id}] ${a.groupId}:${a.artifactId}:${a.version}`).join("\n    ");
            const more = m.artifacts.length > 5 ? `\n    ... (${m.artifacts.length - 5} more versions)` : '';
            return `Implementation: ${m.className}\n    ${artifacts}${more}`;
        }).join("\n\n")
        : `No implementations found for ${className}. Ensure the index is up to date and the class name is correct.`;

    return {
        content: [{ type: "text", text }]
    };
  }
);

server.registerTool(
  "get_class_details",
  {
    description: "Decompile and read the source code of external libraries/dependencies. Use this instead of 'SearchCodebase' for classes that are imported but defined in JAR files. Returns method signatures, Javadocs, or full source. Essential for verifying implementation details during refactoring. Don't guess what the library does—read the code. When reviewing usages of an external class, use this to retrieve the class definition to understand the context fully.",
    inputSchema: z.object({
      className: z.string().describe("Fully qualified class name"),
      artifactId: z.number().optional().describe("The internal ID of the artifact. Optional: if not provided, the tool will automatically find the best match (preferring artifacts with source code)."),
      type: z.enum(["signatures", "docs", "source"]).describe("Type of detail to retrieve: 'signatures' (methods), 'docs' (javadocs + methods), 'source' (full source code)."),
    }),
  },
  async ({ className, artifactId, type }) => {
      let targetArtifactId = artifactId;

      // Auto-resolve artifact if ID is missing
      if (!targetArtifactId) {
          const matches = indexer.searchClass(className);
          // Find exact match for class name
          const exactMatch = matches.find(m => m.className === className);
          
          if (!exactMatch) {
               // If no exact match, but we have some results, list them
               if (matches.length > 0) {
                   const suggestions = matches.map(m => `- ${m.className}`).join("\n");
                   return { content: [{ type: "text", text: `Class '${className}' not found exactly. Did you mean:\n${suggestions}` }] };
               }
               return { content: [{ type: "text", text: `Class '${className}' not found in the index. Try 'search_classes' with a keyword if you are unsure of the full name.` }] };
          }

          // We have an exact match, choose the best artifact
          // Strategy: 1. Prefer hasSource=true. 2. Prefer highest ID (likely newest).
          const artifacts = exactMatch.artifacts.sort((a, b) => {
              if (a.hasSource !== b.hasSource) {
                  return a.hasSource ? -1 : 1; // source comes first
              }
              return b.id - a.id; // higher ID comes first
          });

          if (artifacts.length === 0) {
              return { content: [{ type: "text", text: `Class '${className}' found but no artifacts are associated with it (database inconsistency).` }] };
          }

          targetArtifactId = artifacts[0].id;
          // console.error(`Auto-resolved ${className} to artifact ${artifacts[0].groupId}:${artifacts[0].artifactId}:${artifacts[0].version} (ID: ${targetArtifactId})`);
      }

      const artifact = indexer.getArtifactById(targetArtifactId);
      if (!artifact) {
          return { content: [{ type: "text", text: "Artifact not found." }] };
      }

      let detail: Awaited<ReturnType<typeof SourceParser.getClassDetail>> = null;
      let usedDecompilation = false;
      let lastError = "";

      // 1. If requesting source/docs, try Source JAR first
      if (type === 'source' || type === 'docs') {
          if (artifact.hasSource) {
              const sourceJarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}-sources.jar`);
              try {
                  detail = await SourceParser.getClassDetail(sourceJarPath, className, type);
              } catch (e: any) {
                  // Ignore error and fallthrough to main jar (decompilation)
                  lastError = e.message;
              }
          }
          
          // If not found in source jar (or no source jar), try main jar (decompilation)
          if (!detail) {
             const mainJarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}.jar`);
             try {
                 // SourceParser will try to decompile if source file not found in jar
                 detail = await SourceParser.getClassDetail(mainJarPath, className, type);
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
          const mainJarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}.jar`);
          try {
              detail = await SourceParser.getClassDetail(mainJarPath, className, type);
          } catch (e: any) {
              lastError = e.message;
          }
      }
      
      try {
          if (!detail) {
              const debugInfo = `Artifact path: ${artifact.abspath}, hasSource: ${artifact.hasSource}`;
              const errorMsg = lastError ? `\nLast error: ${lastError}` : "";
              return { content: [{ type: "text", text: `Class ${className} not found in artifact ${artifact.artifactId}. \nDebug info: ${debugInfo}${errorMsg}` }] };
          }

          let resultText = `Class: ${detail.className}\n`;
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

          return { content: [{ type: "text", text: resultText }] };
      } catch (e: any) {
          return { content: [{ type: "text", text: `Error reading source: ${e.message}` }] };
      }
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
