#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { GlobalOpts } from './commands/shared.js';
import * as explore from './commands/explore.js';
import * as searchClasses from './commands/search-classes.js';
import * as searchArtifacts from './commands/search-artifacts.js';
import * as searchImplementations from './commands/search-implementations.js';
import * as searchResources from './commands/search-resources.js';
import * as searchMethods from './commands/search-methods.js';
import * as getClass from './commands/get-class.js';
import * as refreshIndex from './commands/refresh-index.js';
import * as sync from './commands/sync.js';
import * as info from './commands/info.js';
import * as projectContext from './commands/project-context.js';
import * as stats from './commands/stats.js';
import * as listClasses from './commands/list-classes.js';
import * as getResource from './commands/get-resource.js';
import * as getDependencies from './commands/get-dependencies.js';
import * as findDependents from './commands/find-dependents.js';
import * as callers from './commands/callers.js';
import * as callees from './commands/callees.js';
import * as impact from './commands/impact.js';
import * as trace from './commands/trace.js';
import * as doctor from './commands/doctor.js';
import { runInstall, runUninstall } from './commands/install/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return (pkg.version as string) ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, got '${value}'.`);
  }
  return n;
}

const program = new Command();

program
  .name('maven-indexer-cli')
  .description('CLI tool for querying the local Maven/Gradle artifact index')
  .version(readVersion())
  .option('--json', 'Output results as JSON', false)
  .option('--for-llm', 'Trim output for LLM context budgets (drops decorative elements, caps lines).', false)
  .option('--max-lines <n>', 'Maximum lines/rows for --for-llm output (default 200).', parseLimit);

program
  .command('explore <identifier...>')
  .description('Composed query: class + implementations + callers/callees + call path in one call. PRIMARY command.')
  .option('--coordinate <coord>', 'Pin artifact version (groupId:artifactId:version)')
  .option('--include <csv>', 'Sections: source,signatures,implementations,callers,callees,path,resources,dependencies,dependents')
  .option('--max-lines <n>', 'Line budget (default 200)', parseLimit)
  .option('--question <text>', 'Natural-language question')
  .option('--project-path <dir>', 'Project root (defaults to cwd)', process.cwd())
  .action(async (identifiers: string[], cmdOpts: {
    coordinate?: string;
    include?: string;
    maxLines?: number;
    question?: string;
    projectPath?: string;
  }) => {
    const globalOpts = getGlobalOpts();
    await explore.run(identifiers, { ...cmdOpts, ...globalOpts });
  });

program
  .command('search-classes <query>')
  .description('Search for Java classes in the index')
  .option('--limit <n>', 'Maximum number of results', parseLimit)
  .option('--exact', 'Exact match only')
  .option('--regex', 'Treat query as regex')
  .option('--simple-name-only', 'Search simple name only')
  .option('--package-only', 'Search package prefix only')
  .option('--case-sensitive', 'Case-sensitive matching')
  .action(async (query: string, cmdOpts: { limit?: number; exact?: boolean; regex?: boolean; simpleNameOnly?: boolean; packageOnly?: boolean; caseSensitive?: boolean }) => {
    const globalOpts = getGlobalOpts();
    await searchClasses.run(query, { ...cmdOpts, ...globalOpts });
  });

program
  .command('search-artifacts <query>')
  .description('Search for artifacts by groupId, artifactId, or keyword')
  .option('--limit <n>', 'Maximum number of results', parseLimit)
  .action(async (query: string, cmdOpts: { limit?: number }) => {
    const globalOpts = getGlobalOpts();
    await searchArtifacts.run(query, { ...cmdOpts, ...globalOpts });
  });

program
  .command('search-implementations <className>')
  .description('Search for implementations of an interface or base class')
  .option('--limit <n>', 'Maximum number of results', parseLimit)
  .action(async (className: string, cmdOpts: { limit?: number }) => {
    const globalOpts = getGlobalOpts();
    await searchImplementations.run(className, { ...cmdOpts, ...globalOpts });
  });

program
  .command('search-resources <pattern>')
  .description('Search for resources (proto files, XML configs, etc.) inside JARs')
  .option('--limit <n>', 'Maximum number of results', parseLimit)
  .action(async (pattern: string, cmdOpts: { limit?: number }) => {
    const globalOpts = getGlobalOpts();
    await searchResources.run(pattern, { ...cmdOpts, ...globalOpts });
  });

program
  .command('search-methods <name>')
  .description('Search for Java methods by name in the index')
  .option('--limit <n>', 'Maximum number of results', parseLimit)
  .option('--exact', 'Exact match only')
  .option('--case-sensitive', 'Case-sensitive matching')
  .action(async (name: string, cmdOpts: { limit?: number; exact?: boolean; caseSensitive?: boolean }) => {
    const globalOpts = getGlobalOpts();
    await searchMethods.run(name, { ...cmdOpts, ...globalOpts });
  });

program
  .command('get-class <className>')
  .description('Get class details (signatures, docs, or source)')
  .option('--type <type>', 'Detail type: signatures, docs, or source', 'signatures')
  .option('--coordinate <coordinate>', 'Maven coordinate (groupId:artifactId:version)')
  .action(async (className: string, cmdOpts: { type?: string; coordinate?: string }) => {
    const globalOpts = getGlobalOpts();
    await getClass.run(className, { ...cmdOpts, ...globalOpts });
  });

program
  .command('refresh-index')
  .description('Refresh the artifact index')
  .option('--quick', 'Index only the best version per artifact (default)')
  .option('--full', 'Index all versions of all artifacts')
  .option('--watch', 'Watch for changes and re-index automatically')
  .action(async (cmdOpts: { quick?: boolean; full?: boolean; watch?: boolean }) => {
    const globalOpts = getGlobalOpts();
    await refreshIndex.run({ ...cmdOpts, ...globalOpts });
  });

program
  .command('sync')
  .description('Fast incremental refresh of the index (sub-second on unchanged indexes). Use before queries to pick up newly added JARs.')
  .option('--quiet', 'Suppress stdout on success')
  .action(async (cmdOpts: { quiet?: boolean }) => {
    const globalOpts = getGlobalOpts();
    await sync.run({ ...globalOpts, quiet: cmdOpts.quiet });
  });

program
  .command('info <coordinate>')
  .description('Show artifact info (path, layout, class count, resource count). Coordinate format: groupId:artifactId[:version]')
  .action(async (coordinate: string) => {
    const globalOpts = getGlobalOpts();
    await info.run(coordinate, globalOpts);
  });

program
  .command('project-context [project-path]')
  .description('Inspect the project context (declared/resolved dependency tree, build file, project coordinate) for a project root. Defaults to cwd.')
  .action(async (projectPath?: string) => {
    const globalOpts = getGlobalOpts();
    await projectContext.run(projectPath ?? process.cwd(), globalOpts);
  });

program
  .command('stats')
  .description('Show aggregate statistics about the index (artifact count, class count, db size, etc.)')
  .action(async () => {
    const globalOpts = getGlobalOpts();
    await stats.run(globalOpts);
  });

program
  .command('list-classes <coordinate>')
  .description('List all classes indexed for an artifact. Coordinate format: groupId:artifactId:version')
  .action(async (coordinate: string) => {
    const globalOpts = getGlobalOpts();
    await listClasses.run(coordinate, globalOpts);
  });

program
  .command('get-resource <coordinate> <resourcePath>')
  .description('Get the content of an indexed resource (proto, XML, properties, etc.) inside an artifact JAR')
  .action(async (coordinate: string, resourcePath: string) => {
    const globalOpts = getGlobalOpts();
    await getResource.run(coordinate, resourcePath, globalOpts);
  });

program
  .command('get-dependencies <coordinate>')
  .description('List the Maven <dependencies> of an artifact. Coordinate format: groupId:artifactId:version')
  .action(async (coordinate: string) => {
    const globalOpts = getGlobalOpts();
    await getDependencies.run(coordinate, globalOpts);
  });

program
  .command('find-dependents <coordinate>')
  .description('Find indexed artifacts that depend on the given coordinate. Coordinate format: groupId:artifactId[:version] (version optional)')
  .action(async (coordinate: string) => {
    const globalOpts = getGlobalOpts();
    await findDependents.run(coordinate, globalOpts);
  });

program
  .command('callers <target>')
  .description('List callers of a class or method (call-graph). Target format: className[.methodName] (e.g. com.example.Foo or com.example.Foo.bar)')
  .option('--limit <n>', 'Maximum number of results (default 50, max 500)', parseLimit)
  .action(async (target: string, cmdOpts: { limit?: number }) => {
    const globalOpts = getGlobalOpts();
    await callers.run(target, { ...cmdOpts, ...globalOpts });
  });

program
  .command('callees <target>')
  .description('List callees of a class or method (call-graph). Target format: className[.methodName] (e.g. com.example.Foo or com.example.Foo.bar)')
  .option('--limit <n>', 'Maximum number of results (default 50, max 500)', parseLimit)
  .action(async (target: string, cmdOpts: { limit?: number }) => {
    const globalOpts = getGlobalOpts();
    await callees.run(target, { ...cmdOpts, ...globalOpts });
  });

program
  .command('impact <target>')
  .description('Show transitive impact (callers-of-callers) for a class or method. Target format: className[.methodName]')
  .option('--depth <n>', 'Maximum traversal depth (default 3, max 5)', parseLimit)
  .option('--max-nodes <n>', 'Maximum nodes to return (default 200, max 1000)', parseLimit)
  .option('--format <format>', 'Output format: flat (default) or tree', (v: string) => v === 'tree' ? 'tree' : 'flat', 'flat')
  .action(async (target: string, cmdOpts: { depth?: number; maxNodes?: number; format?: 'flat' | 'tree' }) => {
    const globalOpts = getGlobalOpts();
    await impact.run(target, { ...cmdOpts, ...globalOpts });
  });

program
  .command('trace <className>')
  .description('Composed view of a class + implementations + callers + callees in one response. Reduces round-trips for "how does this work / where is this used?" queries.')
  .option('--coordinate <coordinate>', 'Maven coordinate (groupId:artifactId:version) to disambiguate')
  .option('--limit-implementations <n>', 'Maximum implementations to return (default 10)', parseLimit)
  .option('--limit-callers <n>', 'Maximum callers to return (default 10)', parseLimit)
  .option('--limit-callees <n>', 'Maximum callees to return (default 10)', parseLimit)
  .option('--max-lines <n>', 'Maximum total lines for text output (default 200)', parseLimit)
  .action(async (className: string, cmdOpts: {
    coordinate?: string;
    limitImplementations?: number;
    limitCallers?: number;
    limitCallees?: number;
    maxLines?: number;
  }) => {
    const globalOpts = getGlobalOpts();
    await trace.run(className, {
      ...cmdOpts,
      ...globalOpts,
      maxLines: cmdOpts.maxLines ?? globalOpts.maxLines,
    });
  });

program
  .command('doctor')
  .description('Check indexed artifacts for missing JARs on disk')
  .option('--prune', 'Delete stale artifact rows')
  .option('--check-filters', 'List indexed classes matching current EXCLUDED_PACKAGES')
  .option('--json', 'Output as JSON')
  .action(async (cmdOpts: { prune?: boolean; checkFilters?: boolean; json?: boolean }) => {
    const globalOpts = getGlobalOpts();
    await doctor.run({ prune: cmdOpts.prune, checkFilters: cmdOpts.checkFilters, json: Boolean(cmdOpts.json) || globalOpts.json });
  });

program
  .command('install')
  .description('Wire up maven-indexer for an AI coding agent (Claude Code, Cursor): MCP server entry, permissions, and instructions block.')
  .option('--target <csv|auto|all|none>', 'Which agent target(s) to install for. `auto` = detected clients (default), `all` = every known client, `none` = skip agent writes, or a csv like `claude,cursor`.', 'auto')
  .option('--location <global|local>', 'Install scope: `global` (default) or `local` (project-relative).', 'global')
  .option('--auto-allow', 'Auto-approve MCP tool calls (Claude: adds mcp__maven-indexer__* to permissions.allow).')
  .option('--dry-run', 'Print the plan without writing any files.')
  .option('--yes', 'Skip confirmation prompts (non-interactive).')
  .option('--status', 'Show installation status per known target and exit.')
  .option('--print-mcp-config [client]', 'Print the MCP config block without writing. Optional client name.')
  .action(async (cmdOpts: {
    target?: string;
    location?: string;
    autoAllow?: boolean;
    dryRun?: boolean;
    yes?: boolean;
    status?: boolean;
    printMcpConfig?: string | boolean;
  }) => {
    const globalOpts = getGlobalOpts();
    runInstall({
      target: cmdOpts.target,
      location: cmdOpts.location,
      autoAllow: cmdOpts.autoAllow,
      dryRun: cmdOpts.dryRun,
      yes: cmdOpts.yes,
      json: globalOpts.json,
      status: cmdOpts.status,
      printMcpConfig: Boolean(cmdOpts.printMcpConfig),
      client: typeof cmdOpts.printMcpConfig === 'string' ? cmdOpts.printMcpConfig : undefined,
    });
  });

program
  .command('uninstall')
  .description('Remove maven-indexer MCP config, permissions, and instructions block from agent client config files.')
  .option('--target <csv|auto|all|none>', 'Which agent target(s) to uninstall from.', 'auto')
  .option('--location <global|local>', 'Uninstall scope: `global` (default) or `local`.', 'global')
  .option('--dry-run', 'Print the plan without modifying any files.')
  .option('--yes', 'Skip confirmation prompts (non-interactive).')
  .action(async (cmdOpts: {
    target?: string;
    location?: string;
    dryRun?: boolean;
    yes?: boolean;
  }) => {
    const globalOpts = getGlobalOpts();
    runUninstall({
      target: cmdOpts.target,
      location: cmdOpts.location,
      dryRun: cmdOpts.dryRun,
      yes: cmdOpts.yes,
      json: globalOpts.json,
    });
  });

// Handle unknown commands
program.on('command:*', () => {
  process.stderr.write(`Error: Unknown command '${program.args[0]}'\n`);
  process.stderr.write('Run with --help to see available commands.\n');
  process.exit(1);
});

function getGlobalOpts(): GlobalOpts {
  const opts = program.opts();
  return {
    json: Boolean(opts.json),
    forLlm: Boolean(opts.forLlm),
    maxLines: typeof opts.maxLines === 'number' ? opts.maxLines : undefined,
  };
}

// Parse args; if no command given, show help
program.parse(process.argv);

if (process.argv.length <= 2) {
  program.help();
}
