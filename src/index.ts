#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from 'path';
import { Indexer } from "./indexer.js";
import { SourceParser } from "./source_parser.js";

const server = new Server(
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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_artifacts",
        description: "Search for artifacts in the local Maven repository",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query (groupId, artifactId, or keyword)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "search_classes",
        description: "Search for Java classes. Can be used to find classes by name or to find classes for a specific purpose (by searching keywords in class names).",
        inputSchema: {
          type: "object",
          properties: {
            className: {
              type: "string",
              description: "Fully qualified class name, partial name, or keywords describing the class purpose (e.g. 'JsonToXml').",
            },
          },
          required: ["className"],
        },
      },
      {
        name: "get_class_details",
        description: "Get details about a specific class from an artifact, including method signatures and javadocs (if source is available).",
        inputSchema: {
          type: "object",
          properties: {
            className: {
                type: "string",
                description: "Fully qualified class name",
            },
            artifactId: {
                type: "number",
                description: "The internal ID of the artifact (returned by search_classes)",
            },
            type: {
                type: "string",
                enum: ["signatures", "docs", "source"],
                description: "Type of detail to retrieve: 'signatures' (methods), 'docs' (javadocs + methods), 'source' (full source code).",
            }
          },
          required: ["className", "artifactId", "type"],
        },
      },
      {
        name: "refresh_index",
        description: "Trigger a re-scan of the Maven repository",
        inputSchema: {
          type: "object",
          properties: {},
        },
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "search_artifacts") {
    const query = String(request.params.arguments?.query);
    
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

  if (request.params.name === "search_classes") {
    const className = String(request.params.arguments?.className);
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

  if (request.params.name === "get_class_details") {
      const className = String(request.params.arguments?.className);
      const artifactId = Number(request.params.arguments?.artifactId);
      const type = String(request.params.arguments?.type) as 'signatures' | 'docs' | 'source';

      const artifact = indexer.getArtifactById(artifactId);
      if (!artifact) {
          return { content: [{ type: "text", text: "Artifact not found." }] };
      }

      let jarPath: string;
      
      if (type === 'signatures') {
          // Use Main JAR for signatures (javap)
          jarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}.jar`);
      } else {
          // Use Source JAR for docs and full source
          if (!artifact.hasSource) {
              return { content: [{ type: "text", text: `Artifact ${artifact.groupId}:${artifact.artifactId}:${artifact.version} does not have a sources jar available locally.` }] };
          }
          jarPath = path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}-sources.jar`);
      }
      
      try {
          const detail = await SourceParser.getClassDetail(jarPath, className, type);
          if (!detail) {
              return { content: [{ type: "text", text: `Class ${className} not found in ${type === 'signatures' ? 'artifact' : 'sources'} of ${artifact.artifactId}.` }] };
          }

          let resultText = `Class: ${detail.className}\n\n`;
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
  
  if (request.params.name === "refresh_index") {
      // Re-run index
      indexer.index().catch(console.error);
      return {
          content: [{ type: "text", text: "Index refresh started." }]
      };
  }

  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
await server.connect(transport);
