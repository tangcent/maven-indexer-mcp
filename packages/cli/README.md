# `maven-indexer-cli`

[![npm version](https://img.shields.io/npm/v/maven-indexer-cli.svg?style=flat)](https://www.npmjs.com/package/maven-indexer-cli)

> Part of the **[`maven-index`](https://github.com/tangcent/maven-index)** monorepo — the unified home for `maven-indexer-cli` and `maven-indexer-mcp`.

The Commander.js CLI face of the Maven/Gradle artifact index. Thin wrapper over the [`@maven-indexer/engine`](../engine) package. Use this when driving dependency lookups from a terminal coding agent (token-efficient CLI + SKILL workflow).

## Related packages

- **[`@maven-indexer/engine`](../engine)** — the shared engine (Indexer, parsers, schema, resolver, `explore()`).
- **[`maven-indexer-mcp`](../mcp)** — the MCP server face, for IDE-integrated agents (Cursor, Kiro, Windsurf).

## Repository

- Source: <https://github.com/tangcent/maven-index/tree/main/packages/cli>
- Issues: <https://github.com/tangcent/maven-index/issues>
- Unified repo: <https://github.com/tangcent/maven-index> (formerly `maven-indexer-mcp`; the standalone `maven-indexer-cli` git repo is deprecated)

## Install

```bash
npm install -g maven-indexer-cli
# or
npx maven-indexer-cli <command>
```

## Primary command

```bash
maven-indexer-cli explore <identifier...> [--coordinate g:a:v] [--include source,signatures,...] [--project-path <dir>]
```

One composed query: class source + implementations + callers/callees + call path in a single capped response. Run `maven-indexer-cli --help` for the full command menu.

## Output modes

All query commands support:

- default (human-readable text)
- `--json` (machine-readable JSON)
- `--for-llm` (trimmed text for LLM context budgets)
- `--json --for-llm` (trimmed JSON for LLM context budgets)
