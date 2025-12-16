# Maven Indexer MCP Server

A Model Context Protocol (MCP) server that indexes your local Maven repository (`~/.m2/repository`) and Gradle cache (`~/.gradle/caches/modules-2/files-2.1`) to provide AI agents with tools to search for Java classes, method signatures, and source code.

## Features

*   **Semantic Class Search**: Search for classes by name (e.g., `StringUtils`) or purpose (e.g., `JsonToXml`).
*   **Inheritance Search**: Find all implementations of an interface or subclasses of a class.
*   **On-Demand Analysis**: Extracts method signatures (`javap`) and Javadocs directly from JARs without extracting the entire archive.
*   **Source Code Retrieval**: Provides full source code if `-sources.jar` is available.
*   **Real-time Monitoring**: Watches the repositories for changes (e.g., new `mvn install`) and automatically updates the index.
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

This will automatically download and run the latest version of the server. It will auto-detect your Maven repository location (usually `~/.m2/repository`) and Gradle cache.

### Configuration (Optional)

If the auto-detection fails, or if you want to filter which packages are indexed, you can add environment variables to the configuration:

*   **`MAVEN_REPO`**: Absolute path to your local Maven repository (e.g., `/Users/yourname/.m2/repository`). Use this if your repository is in a non-standard location.
*   **`GRADLE_REPO_PATH`**: Absolute path to your Gradle cache (e.g., `/Users/yourname/.gradle/caches/modules-2/files-2.1`).
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
        "GRADLE_REPO_PATH": "/Users/yourname/.gradle/caches/modules-2/files-2.1",
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

*   **`search_classes`**: Search for Java classes in the local Maven repository and Gradle caches.
    *   **WHEN TO USE**:
        1.  You cannot find a class definition in the current project source (it's likely a dependency).
        2.  You need to read the source code, method signatures, or Javadocs of an external library class.
        3.  You need to verify which version of a library class is being used.
    *   **Examples**: "Show me the source of StringUtils", "What methods are available on DateTimeUtils?", "Where is this class imported from?".
    *   Input: `className` (e.g., "StringUtils", "Json parser")
    *   Output: List of matching classes with their artifacts.
*   **`get_class_details`**: Decompile and read the source code of external libraries/dependencies. **Use this instead of 'SearchCodebase' for classes that are imported but defined in JAR files.**
    *   **Key Value**: "Don't guess what the library does—read the code."
    *   **Tip**: When reviewing usages of an external class, use this to retrieve the class definition to understand the context fully.
    *   Input: `className` (required), `artifactId` (optional), `type` ("signatures", "docs", "source")
    *   Output: Method signatures, Javadocs, or full source code.
    *   **Note**: If `artifactId` is omitted, the tool automatically selects the best available artifact (preferring those with source code attached).
*   **`search_artifacts`**: Search for artifacts in Maven/Gradle caches by coordinate (groupId, artifactId).
*   **`search_implementations`**: Search for classes that implement a specific interface or extend a specific class. Useful for finding SPI implementations in external libraries.
    *   Input: `className` (e.g. "java.util.List")
    *   Output: List of implementation/subclass names and their artifacts.
*   **`refresh_index`**: Trigger a re-scan of the Maven repository.

## Development

*   **Run tests**: `npm test`
*   **Watch mode**: `npm run watch`

## License

ISC
