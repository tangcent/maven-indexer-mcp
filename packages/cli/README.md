# `maven-indexer-cli`

[![npm version](https://img.shields.io/npm/v/maven-indexer-cli.svg?style=flat)](https://www.npmjs.com/package/maven-indexer-cli)

> Part of the **[`maven-indexer-mcp`](https://github.com/tangcent/maven-indexer-mcp)** monorepo — the unified home for `maven-indexer-cli` and `maven-indexer-mcp`.

The Commander.js CLI face of the Maven/Gradle artifact index. Thin wrapper over the [`@maven-indexer/engine`](../engine) package. Use this when driving dependency lookups from a terminal coding agent (token-efficient CLI + SKILL workflow).

## Related packages

- **[`@maven-indexer/engine`](../engine)** — the shared engine (Indexer, parsers, schema, resolver, `explore()`).
- **[`maven-indexer-mcp`](../mcp)** — the MCP server face, for IDE-integrated agents (Cursor, Kiro, Windsurf).

## Repository

- Source: <https://github.com/tangcent/maven-indexer-mcp/tree/main/packages/cli>
- Issues: <https://github.com/tangcent/maven-indexer-mcp/issues>
- Unified repo: <https://github.com/tangcent/maven-indexer-mcp> (the standalone `maven-indexer-cli` git repo is deprecated)

## Install

Install the CLI and the `maven-indexer` Agent Skill in one step:

```bash
curl -fsSL https://raw.githubusercontent.com/tangcent/maven-indexer-mcp/main/install.sh | bash
```

Or step by step:

```bash
npm install -g maven-indexer-cli   # or: npx -y maven-indexer-cli <command>
maven-indexer-cli refresh-index    # build the index once
maven-indexer-cli skills install   # copy the skill into every detected agent's skills directory
```

`maven-indexer-cli skills install|status|uninstall` accept `--target auto|all|claude,agents,cursor`,
`--location global|local` and `--dir <skills-dir>`. See the
[root README](https://github.com/tangcent/maven-indexer-mcp#cli--agent-skill) for all install options
and the per-agent skill directories.

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
