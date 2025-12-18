# Maven Indexer MCP Server

[![npm version](https://img.shields.io/npm/v/maven-indexer-mcp.svg?style=flat)](https://www.npmjs.com/package/maven-indexer-mcp)
[![Tests](https://github.com/tangcent/maven-indexer-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tangcent/maven-indexer-mcp/actions/workflows/ci.yml)

A Model Context Protocol (MCP) server that indexes your local Maven repository (`~/.m2/repository`) and Gradle cache (
`~/.gradle/caches/modules-2/files-2.1`) to provide AI agents with tools to search for Java classes, method signatures,
and source code.

**Key Use Case**: While AI models are well-versed in popular public libraries (like Spring, Apache Commons, Guava), they
often struggle with:

1. **Internal Company Packages**: Private libraries that are not public.
2. **Non-Well-Known Public Packages**: Niche or less popular open-source libraries.

This server bridges that gap by allowing the AI to "read" your local dependencies, effectively giving it knowledge of
your private and obscure libraries.

## Features

* **Semantic Class Search**: Search for classes by name or purpose.
* **Inheritance Search**: Find all implementations of an interface or subclasses of a class.
* **On-Demand Analysis**: Extracts method signatures and Javadocs directly from JARs.
* **Source Code Retrieval**: Provides full source code if available.
* **Real-time Monitoring**: Automatically updates the index when repositories change.

## Getting Started

Add the following config to your MCP client:

```json
{
  "mcpServers": {
    "maven-indexer": {
      "command": "npx",
      "args": [
        "-y",
        "maven-indexer-mcp@latest"
      ]
    }
  }
}
```

This will automatically download and run the latest version of the server. It will auto-detect your Maven repository
location (usually `~/.m2/repository`) and Gradle cache.

### MCP Client configuration

<details>
  <summary>Cline</summary>

Follow <a href="https://docs.cline.bot/mcp/configuring-mcp-servers">Cline's MCP guide</a> and use the config provided
above.
</details>

<details>
  <summary>Codex</summary>

Follow the <a href="https://github.com/openai/codex/blob/main/docs/advanced.md#model-context-protocol-mcp">configure MCP
guide</a> using the standard config from above.
</details>

<details>
  <summary>Cursor</summary>

**Click the button to install:**

[![Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=maven-indexer&config=eyJjb21tYW5kIjoibnB4IC15IG1hdmVuLWluZGV4ZXItbWNwQGxhdGVzdCJ9)

**Or install manually:**

Go to `Cursor Settings` -> `MCP` -> `New MCP Server`. Use the config provided above.

</details>

<details>
  <summary>JetBrains AI Assistant & Junie</summary>

Go to `Settings | Tools | AI Assistant | Model Context Protocol (MCP)` -> `Add`. Use the config provided above.
The same way `maven-indexer` can be configured for JetBrains Junie in `Settings | Tools | Junie | MCP Settings` ->`Add`.
Use the config provided above.
</details>

<details>
  <summary>Kiro</summary>

In **Kiro Settings**, go to `Configure MCP` > `Open Workspace or User MCP Config` > Use the configuration snippet
provided above.

Or, from the IDE **Activity Bar** > `Kiro` > `MCP Servers` > `Click Open MCP Config`. Use the configuration snippet
provided above.

</details>

<details>
  <summary>Qoder</summary>

In **Qoder Settings**, go to `MCP Server` > `+ Add` > Use the configuration snippet provided above.

Alternatively, follow the <a href="https://docs.qoder.com/user-guide/chat/model-context-protocol">MCP guide</a> and use
the standard config from above.

</details>

<details>
  <summary>Trae</summary>

Go to `Settings` -> `MCP` -> `+ Add` -> `Add Manually` to add an MCP Server. Use the config provided above.
</details>

<details>
  <summary>Windsurf</summary>

Follow the <a href="https://docs.windsurf.com/windsurf/cascade/mcp#mcp-config-json">configure MCP guide</a>
using the standard config from above.
</details>

## Your first prompt

Enter the following prompt in your MCP Client to check if everything is working:

```text
Find the class `StringUtils` in my local maven repository and show me its methods.
```

Your MCP client should read the class `StringUtils` from your local Maven repository and show its methods.

### Configuration (Optional)

If the auto-detection fails, or if you want to filter which packages are indexed, you can add environment variables to
the configuration:

* **`MAVEN_REPO`**: Absolute path to your local Maven repository (e.g., `/Users/yourname/.m2/repository`). Use this if
  your repository is in a non-standard location.
* **`GRADLE_REPO_PATH`**: Absolute path to your Gradle cache (e.g.,
  `/Users/yourname/.gradle/caches/modules-2/files-2.1`).
* **`INCLUDED_PACKAGES`**: Comma-separated list of package patterns to index (e.g., `com.mycompany.*,org.example.*`).
  Default is `*` (index everything).
* **`MAVEN_INDEXER_CFR_PATH`**: (Optional) Absolute path to a specific CFR decompiler JAR. If not provided, the server
  will attempt to use its bundled CFR version.

Example with optional configuration:

```json
{
  "mcpServers": {
    "maven-indexer": {
      "command": "npx",
      "args": [
        "-y",
        "maven-indexer-mcp@latest"
      ],
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

1. Clone the repository:

    ```bash
    git clone https://github.com/tangcent/maven-indexer-mcp.git
    cd maven-indexer-mcp
    ```

2. Install dependencies and build:

    ```bash
    npm install
    npm run build
    ```

3. Use the absolute path in your config:

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

* **`search_classes`**: Search for Java classes in the local Maven repository and Gradle caches.
  * **WHEN TO USE**:
        1. **Internal/Private Code**: You need to find a class from a company-internal library.
        2. **Obscure Libraries**: You are using a less common public library that the AI doesn't know well.
        3. **Version Verification**: You need to check exactly which version of a class is present locally.

    * *Note*: For well-known libraries (e.g., standard Java lib, Spring), the AI likely knows the class structure
          already, so this tool is less critical.
  * **Examples**: "Show me the source of StringUtils", "What methods are available on DateTimeUtils?", "Where is this
      class imported from?".
  * Input: `className` (e.g., "StringUtils", "Json parser")
  * Output: List of matching classes with their artifacts.
* **`get_class_details`**: Decompile and read the source code of external libraries/dependencies. **Use this instead
  of 'SearchCodebase' for classes that are imported but defined in JAR files.**
  * **Key Value**: "Don't guess what the internal library does—read the code."
  * **Tip**: Essential for internal/proprietary code where documentation is scarce or non-existent.
  * Input: `className` (required), `artifactId` (optional), `type` ("signatures", "docs", "source")
  * Output: Method signatures, Javadocs, or full source code.
  * **Note**: If `artifactId` is omitted, the tool automatically selects the best available artifact (preferring those
      with source code attached).
* **`search_artifacts`**: Search for artifacts in Maven/Gradle caches by coordinate (groupId, artifactId).
* **`search_implementations`**: Search for classes that implement a specific interface or extend a specific class.
  Useful for finding SPI implementations in external libraries.
  * Input: `className` (e.g. "java.util.List")
  * Output: List of implementation/subclass names and their artifacts.
* **`refresh_index`**: Trigger a re-scan of the Maven repository.

## Development

* **Run tests**: `npm test`
* **Watch mode**: `npm run watch`

## License

[ISC](LICENSE)
