# `maven-indexer-mcp`

[![npm version](https://img.shields.io/npm/v/maven-indexer-mcp.svg?style=flat)](https://www.npmjs.com/package/maven-indexer-mcp)

> Part of the **[`maven-index`](https://github.com/tangcent/maven-index)** monorepo — the unified home for `maven-indexer-cli` and `maven-indexer-mcp`.

The MCP SDK server face of the Maven/Gradle artifact index. Thin wrapper over the [`@maven-indexer/engine`](../engine) package. Use this when integrating with IDE-based AI agents (Cursor, Kiro, Windsurf, Claude Code).

## Related packages

- **[`@maven-indexer/engine`](../engine)** — the shared engine (Indexer, parsers, schema, resolver, `explore()`).
- **[`maven-indexer-cli`](../cli)** — the CLI face, for terminal-based coding agents (token-efficient CLI + SKILL workflow).

## Repository

- Source: <https://github.com/tangcent/maven-index/tree/main/packages/mcp>
- Issues: <https://github.com/tangcent/maven-index/issues>
- Unified repo: <https://github.com/tangcent/maven-index> (formerly `maven-indexer-mcp`; the standalone `maven-indexer-cli` git repo is deprecated)

## Install

Add the following to your MCP client config:

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

## Default tool

By default only `explore` is registered — one call answers most questions about a class, dependency, or call flow in the local JVM artifact cache. Pass `projectPath` (absolute project root) on every call to pin version resolution to your project's dependencies.

## Opt-in narrow tools

Set `MAVEN_INDEXER_MCP_TOOLS=search,get_class,callers` to enable specific narrow tools, or `MAVEN_INDEXER_MCP_TOOLS=` (empty-but-set) to enable all of them. See the [top-level README](../../README.md#available-tools) for the full catalog.
