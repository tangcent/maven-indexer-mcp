# Development and Publication Guide

This guide covers how to build, test, and publish the Maven Indexer packages.

## Repository layout

This repository is an npm workspace monorepo:

| Path | Package | Published | Role |
|---|---|---|---|
| `packages/engine` | `@maven-indexer/engine` | no (`private`) | All indexing / querying logic |
| `packages/mcp` | `maven-indexer-mcp` | yes | MCP server (primary artifact) |
| `packages/cli` | `maven-indexer-cli` | yes | CLI face over the same engine |

The root package is `private: true` — it is never published.

## Local Development & Testing

### 1. Building the Project

```bash
npm install
npm run build
```

`npm run build` compiles each workspace in dependency order. The two published
packages are **bundled** with esbuild (`scripts/bundle-package.mjs`): the engine
source is inlined into each package's `dist`, because `@maven-indexer/engine` is
private and would otherwise be unresolvable for consumers. Third-party runtime
dependencies (notably the native `better-sqlite3` addon) stay external, and each
bundle script copies `cfr-0.152.jar` into the package's `lib/`.

### 2. Running Tests

```bash
npm test          # or: npx vitest run
```

Vitest aliases `@maven-indexer/engine` to `packages/engine/src/index.ts`, so
tests run against engine **source** — no prior `npm run build` required.

### 3. Testing the MCP Server Locally

#### Option A: Absolute path (recommended for active dev)

Point your MCP client at the bundled file and rebuild after each change:

```json
{
  "mcpServers": {
    "maven-indexer-local": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/maven-index/packages/mcp/dist/index.js"],
      "env": {
        "MAVEN_REPO": "/path/to/test/repo",
        "GRADLE_REPO_PATH": "/path/to/test/gradle-repo"
      }
    }
  }
}
```

#### Option B: `npm link` (simulate global install)

```bash
cd packages/mcp
npm link
```

This registers the `maven-indexer-mcp` binary globally.

### 4. Verify Local Packaging

Never publish without checking what ships:

```bash
npm pack --dry-run --workspace=maven-indexer-mcp
npm pack --dry-run --workspace=maven-indexer-cli
```

Each tarball must contain `dist/`, `lib/cfr-0.152.jar`, `README.md`, `LICENSE`
and **no** dependency on `@maven-indexer/engine` (it is private).

## Publishing

### Prerequisites

1. An account on [npmjs.com](https://www.npmjs.com/).
2. `npm login`

### Publishing steps

```bash
./scripts/release.sh      # bumps every workspace version + builds + publishes
./scripts/publish.sh      # publish only (npm / GitHub Packages / both)
```

Notes:

- **Always target workspaces.** Plain `npm publish` from the root fails: the root
  package is private.
- `prepublishOnly` runs the bundle step for each published workspace.
- Verify afterwards with `npx -y maven-indexer-mcp@latest`.

### Automation

`.github/workflows/ci.yml` runs build + tests on every push and pull request
across Linux, macOS, and Windows.
