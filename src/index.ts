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
    description: "Search for Java classes in the local Maven repository. Use this to find classes from external dependencies/libraries when their source code is not available in the current workspace. You can search by class name (e.g. 'StringUtils') or keywords (e.g. 'Json').",
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
    description: "Search for classes that implement a specific interface or extend a specific class. This is useful for finding implementations of SPIs or base classes.",
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
    description: "Get details about a specific class from a Maven artifact. Use this to inspect external classes where source code is missing. It can provide method signatures (using javap), Javadocs, or even decompiled source code if the original source jar is unavailable.",
    inputSchema: z.object({
      className: z.string().describe("Fully qualified class name"),
      artifactId: z.number().describe("The internal ID of the artifact (returned by search_classes)"),
      type: z.enum(["signatures", "docs", "source"]).describe("Type of detail to retrieve: 'signatures' (methods), 'docs' (javadocs + methods), 'source' (full source code)."),
    }),
  },
  async ({ className, artifactId, type }) => {
      const artifact = indexer.getArtifactById(artifactId);
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

          let resultText = `Class: ${detail.className}\n\n`;
          if (usedDecompilation) {
              resultText += "*Source code decompiled from binary class file.*\n\n";
          }
          
          if (type === 'source') {
              resultText += "```java\n" + detail.source + "\n```";
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
