---
name: maven-indexer
description: Look up Java/Kotlin classes, method signatures, source code, implementations, callers and dependencies inside the local Maven (~/.m2) and Gradle caches with the `maven-indexer-cli` command. Use when code imports a class from a library you cannot see in the workspace (internal company packages, less-known open-source libraries, a specific dependency version), when you need to know how a dependency class works, which artifact provides a class, who implements an interface, which methods call a method, or what an artifact depends on. Prefer it over guessing APIs from memory or decompiling JARs by hand.
---

# maven-indexer

`maven-indexer-cli` indexes the JARs already downloaded to the local Maven repository
(`~/.m2/repository`) and Gradle cache (`~/.gradle/caches/modules-2/files-2.1`) into a SQLite
database and answers questions about them. It sees exactly the versions this machine has,
including private artifacts that are not on the public internet.

## Before the first query

1. Check the CLI is available: `maven-indexer-cli --version`. If it is missing, install it with
   `npm install -g maven-indexer-cli` (Node.js 18+), or prefix every command with
   `npx -y maven-indexer-cli`.
2. Check the index: `maven-indexer-cli stats`. If `Artifact Count` is `0` or
   `Last Indexed At: never`, build it once with `maven-indexer-cli refresh-index`
   (can take a few minutes on a large repository; run it in the background if your tools allow).
3. Before later queries, run `maven-indexer-cli sync --quiet` to pick up JARs downloaded since the
   last run. It is sub-second when nothing changed.

If a class you expect is missing, the dependency may not be downloaded yet: run the project's build
(`mvn dependency:resolve`, `./gradlew dependencies`, or a normal compile), then `sync` again.

## Always pass `--for-llm`

Put `--for-llm` (and optionally `--max-lines <n>`) **before** the subcommand. It trims decorative
output and caps the line count so results fit in context:

```bash
maven-indexer-cli --for-llm explore com.example.client.OrderClient
```

Use `--json` instead when you need to parse the output in a script.

## Start with `explore`

`explore` answers most questions in one call: it resolves each identifier and returns the class
signatures, implementations, callers and callees together.

```bash
# One or more identifiers: simple or fully-qualified class names, Class.method, g:a[:v] coordinates
maven-indexer-cli --for-llm explore OrderClient
maven-indexer-cli --for-llm explore com.example.client.OrderClient.submit

# Choose sections explicitly
maven-indexer-cli --for-llm explore com.example.client.OrderClient --include source
maven-indexer-cli --for-llm explore com.example.spi.Codec --include implementations
maven-indexer-cli --for-llm explore com.example:order-client --include dependencies,dependents

# Pin a version, or resolve versions against a specific project's dependency tree
maven-indexer-cli --for-llm explore OrderClient --coordinate com.example:order-client:2.3.1
maven-indexer-cli --for-llm explore OrderClient --project-path /abs/path/to/project
```

`--include` sections: `source`, `signatures`, `implementations`, `callers`, `callees`, `path`,
`resources`, `dependencies`, `dependents`. Without `--include` you get signatures,
implementations, callers and callees. `--max-lines` sets the line budget (default 200).

`--project-path` defaults to the current directory. Run from the project root (or pass the path)
so the version that project actually uses is picked when several versions are cached.

If no identifier resolves, the `### Meta` block lists it under `unresolved`. Try a shorter name,
`search-classes`, or `--question "<what you are looking for>"`.

## Narrow commands

Use these when you need one specific slice, more results than `explore` shows, or exact flags.

| Need | Command |
|---|---|
| Find which artifact contains a class | `search-classes <name> [--exact] [--limit n]` |
| Read signatures / Javadoc / full source | `get-class <FQCN> --type signatures\|docs\|source [--coordinate g:a:v]` |
| Find implementations or subclasses | `search-implementations <FQCN> [--limit n]` |
| Find methods by name | `search-methods <name> [--exact]` |
| Who calls a class or method | `callers <FQCN[.method]> [--limit n]` |
| What a class or method calls | `callees <FQCN[.method]> [--limit n]` |
| Transitive callers (blast radius) | `impact <FQCN[.method]> [--depth n] [--format tree]` |
| Find artifacts / list versions | `search-artifacts <groupId\|artifactId\|keyword\|g:a[:v]>` |
| Artifact location and counts | `info <g:a[:v]>` |
| Classes in one artifact | `list-classes <g:a:v>` |
| An artifact's declared dependencies | `get-dependencies <g:a:v>` |
| Indexed artifacts depending on one | `find-dependents <g:a[:v]>` |
| Proto / XML / properties inside JARs | `search-resources <pattern>`, then `get-resource <g:a:v> <path>` |
| The project's resolved dependency tree | `project-context [project-path]` |

Run `maven-indexer-cli <command> --help` for the full option list.

## Tips

- Reach for `get-class --type source` only when signatures are not enough; source is long.
  Sources come from `-sources.jar` when present, otherwise from the bundled CFR decompiler
  (needs Java via `JAVA_HOME` or `PATH`).
- When several versions are cached and the answer depends on the version, check which one the
  project uses with `project-context`, then pass `--coordinate`.
- If results look stale or wrong after a dependency upgrade, run `maven-indexer-cli sync`; for a
  full rebuild run `maven-indexer-cli refresh-index`.
- `maven-indexer-cli doctor` reports indexed artifacts whose JARs were deleted from disk.

## Configuration

Set these environment variables when the defaults do not fit:

- `MAVEN_REPO`: Maven repository path, if not `~/.m2/repository`.
- `GRADLE_REPO_PATH`: Gradle cache path, if not `~/.gradle/caches/modules-2/files-2.1`.
- `INCLUDED_PACKAGES` / `EXCLUDED_PACKAGES`: comma-separated package patterns to index or skip
  (for example `EXCLUDED_PACKAGES=java.*,javax.*,sun.*`).
- `VERSION_RESOLUTION_STRATEGY`: `semver` (default), `latest-published` or `latest-used`.
