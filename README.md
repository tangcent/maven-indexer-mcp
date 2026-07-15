# Maven Index

[![npm version](https://img.shields.io/npm/v/maven-indexer-mcp.svg?style=flat)](https://www.npmjs.com/package/maven-indexer-mcp)
[![Tests](https://github.com/tangcent/maven-index/actions/workflows/ci.yml/badge.svg)](https://github.com/tangcent/maven-index/actions/workflows/ci.yml)

An MCP server and CLI that indexes your local Maven repository (`~/.m2/repository`) and Gradle cache
(`~/.gradle/caches/modules-2/files-2.1`) to provide AI agents with tools to search for Java classes, method signatures,
and source code — even for internal company packages and non-well-known public libraries.

## Quick Install

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

### CLI alternative

Install globally for direct terminal usage:

```bash
npm install -g maven-indexer-cli
```

Then use `maven-indexer explore ...` or any of the CLI commands directly.

### MCP Client configuration

#### Cline

Follow [Cline's MCP guide](https://docs.cline.bot/mcp/configuring-mcp-servers) and use the config provided above.

#### Codex

Follow the [configure MCP guide](https://github.com/openai/codex/blob/main/docs/advanced.md#model-context-protocol-mcp) using the standard config from above.

#### Cursor

**Click the button to install:**

[![Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=maven-indexer&config=eyJjb21tYW5kIjoibnB4IC15IG1hdmVuLWluZGV4ZXItbWNwQGxhdGVzdCJ9)

**Or install manually:**

Go to `Cursor Settings` -> `MCP` -> `New MCP Server`. Use the config provided above.

#### JetBrains AI Assistant & Junie

Go to `Settings | Tools | AI Assistant | Model Context Protocol (MCP)` -> `Add`. Use the config provided above.
The same way `maven-indexer` can be configured for JetBrains Junie in `Settings | Tools | Junie | MCP Settings` ->`Add`.
Use the config provided above.

#### Kiro

In **Kiro Settings**, go to `Configure MCP` > `Open Workspace or User MCP Config` > Use the configuration snippet provided above.

Or, from the IDE **Activity Bar** > `Kiro` > `MCP Servers` > `Click Open MCP Config`. Use the configuration snippet provided above.

#### Qoder

In **Qoder Settings**, go to `MCP Server` > `+ Add` > Use the configuration snippet provided above.

Alternatively, follow the [MCP guide](https://docs.qoder.com/user-guide/chat/model-context-protocol) and use the standard config from above.

#### Trae

Go to `Settings` -> `MCP` -> `+ Add` -> `Add Manually` to add an MCP Server. Use the config provided above.

#### Windsurf

Follow the [configure MCP guide](https://docs.windsurf.com/windsurf/cascade/mcp#mcp-config-json) using the standard config from above.

## Your first prompt

Enter the following prompt in your MCP Client to check if everything is working:

```text
Find the class `StringUtils` in my local maven repository and show me its methods.
```

Your MCP client should read the class `StringUtils` from your local Maven repository and show its methods.

## Configuration (Optional)

If the auto-detection fails, or if you want to filter which packages are indexed, you can add environment variables to
the configuration:

* **`MAVEN_REPO`**: Absolute path to your local Maven repository (e.g., `/Users/yourname/.m2/repository`). Use this if
  your repository is in a non-standard location.
* **`GRADLE_REPO_PATH`**: Absolute path to your Gradle cache (e.g.,
  `/Users/yourname/.gradle/caches/modules-2/files-2.1`).
* **`INCLUDED_PACKAGES`**: Comma-separated list of package patterns to index (e.g., `com.mycompany.*,org.example.*`).
  Default is `*` (index everything). Append `!` to an entry to force-include it, overriding `EXCLUDED_PACKAGES`
  (e.g. `org.springframework.security.web!`).
* **`EXCLUDED_PACKAGES`**: Comma-separated list of package-prefix patterns to skip at index time
  (e.g. `java.*,javax.*,sun.*`). Default is empty (index everything). Takes precedence over `INCLUDED_PACKAGES`,
  except for force-include (`!`) entries. **Recommended default:**
  `java.*,javax.*,sun.*,jdk.internal.*,org.omg.*`. Excluding `org.springframework.*` is a trade-off (smaller index
  vs. losing Spring-internal queries) — leave Spring indexed unless index size is a concern.
* **`MAVEN_INDEXER_CFR_PATH`**: (Optional) Absolute path to a specific CFR decompiler JAR. If not provided, the server
  will attempt to use its bundled CFR version.
* **`VERSION_RESOLUTION_STRATEGY`**: (Optional) Strategy to choose the version when multiple versions of an artifact are found and no specific coordinate is provided.
  * `semver`: (Default) Prefer the highest semantic version (e.g. 1.2.0 > 1.1.9).
  * `latest-published`: Prefer the version with the latest publish time (checks `*.pom.lastUpdated` first, then file modification time).
  * `latest-used`: Prefer the version most recently imported/used by the user (based on file creation time).

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
        "MAVEN_INDEXER_CFR_PATH": "/path/to/cfr-0.152.jar",
        "VERSION_RESOLUTION_STRATEGY": "semver"
      }
    }
  }
}
```

## Available Tools

By default only **`explore`** is registered — it covers almost every question in a single call. The other 16 tools below are *defined* but only registered when you opt in via `MAVEN_INDEXER_MCP_TOOLS` (see [Narrow Tools](#narrow-tools-opt-in-via-maven_indexer_mcp_tools)).

### `explore` (PRIMARY — default-registered)

* **`explore`**: PRIMARY tool — call FIRST for almost any question about a class, dependency, or call flow in the local Maven/Gradle artifact cache. Returns class source/signatures + implementations + callers/callees + call path in ONE capped response. Answers "how does this work / where is this used?" in a single call. Registered by default (no opt-in needed).
  - **Input:**
    - `identifiers` (string[], required): bag of names — class names (FQCN or simple), coordinates (`groupId:artifactId[:version]`), method targets (`Class.method`), or resource paths.
    - `coordinate` (string, optional): pin the artifact version for all class/method identifiers (`groupId:artifactId:version`).
    - `include` (string[], optional): sections to populate. Omit for the default (`signatures`, `implementations`, `callers`, `callees`). Vocabulary: `source`, `signatures`, `implementations`, `callers`, `callees`, `path`, `resources`, `dependencies`, `dependents`.
    - `maxLines` (number, optional): line budget (default 200).
    - `question` (string, optional): natural-language question; used as a fallback when no identifier resolves (search-candidates mode).
    - `projectPath` (string, REQUIRED for MCP; optional for CLI — defaults to cwd): absolute path to the project root. MCP servers launch globally with an unreliable cwd, so state the project explicitly to pin version resolution to your project's dependencies.
  - **Output:** composed, line-capped text with the requested sections.

### Narrow Tools (opt-in via MAVEN_INDEXER_MCP_TOOLS)

These 16 narrow tools are *defined* but NOT registered by default — `explore` already covers the same ground in one call. Register them only when you need a specific slice.

- Set `MAVEN_INDEXER_MCP_TOOLS=search,get_class,callers` to enable specific tools (CSV of short names).
- Set `MAVEN_INDEXER_MCP_TOOLS=` (empty-but-set) to enable ALL narrow tools (escape hatch — useful for tests and batch scripts).
- `explore` is always registered regardless of this setting.

Each tool below names `explore` as the preferred alternative.

* **`search`**: Search for Java classes by name (FQCN, partial, or keyword). Replaces `search_classes`. Prefer `explore` (pass class names in `identifiers`).
* **`get_class`**: Retrieve source code or signatures for a class. Supports batch. Replaces `get_class_details`. Prefer `explore` with `include: ["source"]` or `["signatures"]`.
* **`get_resource`**: Retrieve a single text resource (proto, XML, properties) from a JAR. Prefer `explore` with `include: ["resources"]`.
* **`implementations`**: Search for classes that implement/extend a given interface/class. Prefer `explore` with `include: ["implementations"]`.
* **`callers`**: List methods that invoke the given class/method (call-graph). Prefer `explore` with `include: ["callers"]`.
* **`callees`**: List methods invoked by the given class/method (call-graph). Prefer `explore` with `include: ["callees"]`.
* **`impact`**: Transitive impact (callers-of-callers) via BFS up the call graph. Prefer `explore` (which surfaces direct callers/callees in one call).
* **`dependencies`**: List the parsed Maven `<dependencies>` of an artifact. Replaces `get_dependencies`. Prefer `explore` with `include: ["dependencies"]`.
* **`dependents`**: Find indexed artifacts that depend on the given coordinate. Replaces `find_dependents`. Prefer `explore` with `include: ["dependents"]`.
* **`info`**: Get artifact info (path, layout, class count, resource count). Prefer `explore` with `include: ["path"]`.
* **`stats`**: Aggregate index statistics (artifact count, class count, db size). Prefer `explore` (no direct equivalent; use `stats` for raw counts).
* **`list_classes`**: List all distinct Java/protobuf class names indexed for a specific artifact coordinate. Prefer `explore` (pass the coordinate in `identifiers`).
* **`project_context`**: Inspect the active project's Maven/Gradle context (declared/resolved dependency tree, build file, project coordinate). Useful when version resolution surprises you. Takes required `projectPath`. Prefer `explore` (pass `projectPath`).
* **`search_artifacts`**: Search for artifacts by coordinate (groupId, artifactId, keyword). Supports batch. Prefer `explore` (pass coordinates in `identifiers`).
* **`search_resources`**: Search for text resources inside JARs (proto, XML, properties). Prefer `explore` with `include: ["resources"]`.
* **`search_methods`**: Search for Java methods by name across indexed artifacts. Prefer `explore` (pass `Class.method` in `identifiers`).

> **Note**: The `doctor` command (check indexed artifacts for missing JARs on disk) is CLI-only — there is no MCP equivalent.
>
> **Note**: The `sync` command (fast incremental refresh via mtime) is CLI-only. MCP has its own background watcher that re-indexes on filesystem changes, so a manual sync is unnecessary when the watcher is active.

## Maven Indexer MCP vs Maven Indexer CLI

This repository hosts **both** packages. Pick the face that matches your workflow:

- **CLI** (`maven-indexer-cli`): Modern **coding agents** increasingly favor CLI-based workflows exposed as SKILLs over MCP because CLI invocations are more token-efficient: they avoid loading large tool schemas into the model context, allowing agents to act through concise, purpose-built commands. This makes CLI + SKILLs better suited for high-throughput coding agents that must balance dependency lookups with large codebases and reasoning within limited context windows.<br>**Learn more about [Maven Indexer CLI with SKILLS](packages/cli)**.

- **MCP** (`maven-indexer-mcp`): MCP remains the better choice for IDE-integrated agents (Cursor, Kiro, Windsurf, etc.) that benefit from persistent background indexing, automatic repository watching, and seamless tool invocation without any CLI setup. The MCP server indexes your repository in the background and keeps the index up to date automatically.

## Local Development

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

* **Run tests**: `npm test`
* **Watch mode**: `npm run watch`

## Repository

This repository was **renamed from `maven-indexer-mcp`** to `maven-index` as part of the engine unification (one engine, two thin faces).
The standalone [`maven-indexer-cli`](https://github.com/tangcent/maven-indexer-cli) git repo is **deprecated** — its npm package is now published from this repo's workspace.

| Path | Published as | Description |
|---|---|---|
| [`packages/engine`](packages/engine) | `@maven-indexer/engine` (private, internal) | The shared engine: `Indexer`, parsers, schema, resolver, `explore()`, `project_context` |
| [`packages/cli`](packages/cli) | [`maven-indexer-cli`](https://www.npmjs.com/package/maven-indexer-cli) | Commander.js CLI face — thin; imports engine |
| [`packages/mcp`](packages/mcp) | [`maven-indexer-mcp`](https://www.npmjs.com/package/maven-indexer-mcp) | MCP SDK server face — thin; imports engine |

Both published packages (`maven-indexer-cli`, `maven-indexer-mcp`) keep their names and bin entries unchanged for backward compatibility — existing `npx -y maven-indexer-mcp@latest` and `npm install -g maven-indexer-cli` invocations keep working.

## License

[ISC](LICENSE)
