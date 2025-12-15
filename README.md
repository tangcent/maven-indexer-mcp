# Maven Indexer MCP Server

A Model Context Protocol (MCP) server that indexes your local Maven repository (`~/.m2/repository`) and provides AI agents with tools to search for Java classes, method signatures, and source code.

## Features

*   **Semantic Class Search**: Search for classes by name (e.g., `StringUtils`) or purpose (e.g., `JsonToXml`).
*   **Inheritance Search**: Find all implementations of an interface or subclasses of a class.
*   **On-Demand Analysis**: Extracts method signatures (`javap`) and Javadocs directly from JARs without extracting the entire archive.
*   **Source Code Retrieval**: Provides full source code if `-sources.jar` is available.
*   **Real-time Monitoring**: Watches the Maven repository for changes (e.g., new `mvn install`) and automatically updates the index.
*   **Efficient Persistence**: Uses SQLite to store the index, handling large repositories with minimal memory footprint.

## Getting Started

Add the following config to your MCP client:

```json
{
  "mcpServers": {
    "maven-indexer": {
      "command": "npx",
      "args": ["-y", "maven-indexer-mcp@latest"]
    }
  }
}
```

This will automatically download and run the latest version of the server. It will auto-detect your Maven repository location (usually `~/.m2/repository`).

### Configuration (Optional)

If the auto-detection fails, or if you want to filter which packages are indexed, you can add environment variables to the configuration:

*   **`MAVEN_REPO`**: Absolute path to your local Maven repository (e.g., `/Users/yourname/.m2/repository`). Use this if your repository is in a non-standard location.
*   **`INCLUDED_PACKAGES`**: Comma-separated list of package patterns to index (e.g., `com.mycompany.*,org.example.*`). Default is `*` (index everything).
*   **`MAVEN_INDEXER_CFR_PATH`**: (Optional) Absolute path to a specific CFR decompiler JAR. If not provided, the server will attempt to use its bundled CFR version.

Example with optional configuration:

```json
{
  "mcpServers": {
    "maven-indexer": {
      "command": "npx",
      "args": ["-y", "maven-indexer-mcp@latest"],
      "env": {
        "MAVEN_REPO": "/Users/yourname/.m2/repository",
        "INCLUDED_PACKAGES": "com.mycompany.*",
        "MAVEN_INDEXER_CFR_PATH": "/path/to/cfr-0.152.jar"
      }
    }
  }
}
```

### Local Development

If you prefer to run from source:

1.  Clone the repository:
    ```bash
    git clone https://github.com/tangcent/maven-indexer-mcp.git
    cd maven-indexer-mcp
    ```

2.  Install dependencies and build:
    ```bash
    npm install
    npm run build
    ```

3.  Use the absolute path in your config:
    ```json
    {
      "mcpServers": {
        "maven-indexer": {
          "command": "node",
          "args": ["/absolute/path/to/maven-indexer-mcp/build/index.js"]
        }
      }
    }
    ```

## Available Tools

*   **`search_classes`**: Search for Java classes.
    *   Input: `className` (e.g., "StringUtils", "Json parser")
    *   Output: List of matching classes with their artifacts.
*   **`get_class_details`**: Get detailed information about a class.
    *   Input: `className`, `artifactId`, `type` ("signatures", "docs", "source")
    *   Output: Method signatures, Javadocs, or full source code.
*   **`search_artifacts`**: Search for artifacts by coordinate (groupId, artifactId).
*   **`search_implementations`**: Search for classes that implement a specific interface or extend a specific class.
    *   Input: `className` (e.g. "java.util.List")
    *   Output: List of implementation/subclass names and their artifacts.
*   **`refresh_index`**: Trigger a re-scan of the Maven repository.

## Development

*   **Run tests**: `npm test`
*   **Watch mode**: `npm run watch`

## License

ISC
