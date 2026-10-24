/**
 * The `skills` subcommand: copies the bundled `maven-indexer` Agent Skill
 * (`skills/maven-indexer/SKILL.md`) into an agent's skills directory.
 *
 * Unlike `install`, this writes no MCP config — the skill teaches the agent to
 * call `maven-indexer-cli` directly, which is the token-efficient CLI + SKILL
 * workflow.
 *
 * Skill directories per target:
 *   - claude: `~/.claude/skills` (global) / `./.claude/skills` (local)
 *   - agents: `~/.agents/skills` / `./.agents/skills` — the shared location read by
 *             Codex, Gemini CLI, OpenCode and other Agent Skills clients
 *   - cursor: `~/.cursor/skills` / `./.cursor/skills`
 * `--dir <path>` installs into an arbitrary skills directory instead.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { InstallAction, Location } from './types.js';
import { resolveHome, writeWholeFile } from './targets/shared.js';

export const SKILL_NAME = 'maven-indexer';

interface SkillTarget {
  id: string;
  displayName: string;
  /** Skills root (the directory that holds `<skill-name>/SKILL.md`). */
  skillsDir(loc: Location): string;
  /** Agent home markers; the target counts as detected when any exists. */
  markers(loc: Location): string[];
}

const homeOrLocal = (loc: Location, dir: string) => (loc === 'global' ? resolveHome(`~/${dir}`) : `./${dir}`);

export const SKILL_TARGETS: SkillTarget[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    skillsDir: loc => path.join(homeOrLocal(loc, '.claude'), 'skills'),
    markers: loc => [homeOrLocal(loc, '.claude')],
  },
  {
    id: 'agents',
    displayName: 'Agents (Codex, Gemini CLI, OpenCode, ...)',
    skillsDir: loc => path.join(homeOrLocal(loc, '.agents'), 'skills'),
    markers: loc => ['.agents', '.codex', '.gemini', '.config/opencode'].map(d => homeOrLocal(loc, d)),
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    skillsDir: loc => path.join(homeOrLocal(loc, '.cursor'), 'skills'),
    markers: loc => [homeOrLocal(loc, '.cursor')],
  },
];

export interface SkillsCliOpts {
  /** `auto` | `all` | csv of target ids. Default: `auto`. */
  target?: string;
  /** `global` | `local`. Default: `global`. */
  location?: string;
  /** Explicit skills directory; overrides `target`/`location`. */
  dir?: string;
  dryRun?: boolean;
  json?: boolean;
}

/**
 * Finds the bundled skill directory. Published layout: `<pkg>/dist/cli.js` →
 * `<pkg>/skills`. Running from source in the monorepo: `packages/cli/src/...` →
 * repo-root `skills`.
 */
export function findBundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../skills', SKILL_NAME),
    path.resolve(here, '../../../../../skills', SKILL_NAME),
  ];
  const found = candidates.find(c => fs.existsSync(path.join(c, 'SKILL.md')));
  if (!found) {
    throw new Error(`Bundled skill not found (looked in: ${candidates.join(', ')})`);
  }
  return found;
}

/** Lists files under `dir` as paths relative to it. */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(dir, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** True when `dir/SKILL.md` declares `name: maven-indexer` (so we never delete someone else's skill). */
function isOurSkill(dir: string): boolean {
  try {
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    return new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, 'm').test(text);
  } catch {
    return false;
  }
}

interface ResolvedDest {
  id: string;
  displayName: string;
  skillsDir: string;
}

function parseLocation(s: string | undefined): Location {
  if (s === 'local') return 'local';
  if (s && s !== 'global') {
    process.stderr.write(`Warning: invalid location '${s}', defaulting to 'global'.\n`);
  }
  return 'global';
}

function resolveDestinations(opts: SkillsCliOpts): ResolvedDest[] {
  if (opts.dir) {
    return [{ id: 'dir', displayName: 'Custom directory', skillsDir: resolveHome(opts.dir) }];
  }
  const loc = parseLocation(opts.location);
  const spec = (opts.target ?? 'auto').toLowerCase();
  let targets: SkillTarget[];
  if (spec === 'all') {
    targets = SKILL_TARGETS;
  } else if (spec === 'auto') {
    targets = SKILL_TARGETS.filter(t => t.markers(loc).some(m => fs.existsSync(m)));
    if (targets.length === 0) {
      process.stderr.write(`No agents detected; falling back to '${SKILL_TARGETS[0].id}'.\n`);
      targets = [SKILL_TARGETS[0]];
    }
  } else {
    targets = [];
    for (const id of spec.split(',').map(s => s.trim()).filter(Boolean)) {
      const t = SKILL_TARGETS.find(x => x.id === id);
      if (t) {
        targets.push(t);
      } else {
        process.stderr.write(`Warning: unknown target '${id}', skipping. Known: ${SKILL_TARGETS.map(x => x.id).join(', ')}.\n`);
      }
    }
  }
  return targets.map(t => ({ id: t.id, displayName: t.displayName, skillsDir: t.skillsDir(loc) }));
}

function installInto(skillsDir: string, sourceDir: string, dryRun: boolean): InstallAction[] {
  const destDir = path.join(skillsDir, SKILL_NAME);
  if (fs.existsSync(path.join(destDir, 'SKILL.md')) && !isOurSkill(destDir)) {
    throw new Error(`${destDir} holds a different skill (SKILL.md is not name: ${SKILL_NAME}); refusing to overwrite.`);
  }
  return listFiles(sourceDir).map(rel => {
    const dest = path.join(destDir, rel);
    const content = fs.readFileSync(path.join(sourceDir, rel), 'utf-8');
    return { path: dest, action: writeWholeFile(dest, content, dryRun) };
  });
}

function uninstallFrom(skillsDir: string, dryRun: boolean): InstallAction[] {
  const destDir = path.join(skillsDir, SKILL_NAME);
  if (!fs.existsSync(destDir)) {
    return [{ path: destDir, action: 'unchanged', detail: 'not installed' }];
  }
  if (!isOurSkill(destDir)) {
    return [{ path: destDir, action: 'unchanged', detail: `not the ${SKILL_NAME} skill; left alone` }];
  }
  if (!dryRun) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  return [{ path: destDir, action: 'removed' }];
}

function statusOf(skillsDir: string, sourceDir: string): InstallAction[] {
  const destDir = path.join(skillsDir, SKILL_NAME);
  if (!isOurSkill(destDir)) {
    return [{ path: destDir, action: 'unchanged', detail: 'not installed' }];
  }
  const stale = listFiles(sourceDir).some(rel => {
    const dest = path.join(destDir, rel);
    return !fs.existsSync(dest) || fs.readFileSync(dest, 'utf-8') !== fs.readFileSync(path.join(sourceDir, rel), 'utf-8');
  });
  return [{ path: destDir, action: 'unchanged', detail: stale ? 'installed (stale; re-run skills install)' : 'installed' }];
}

const SYMBOLS: Record<string, string> = { created: '+', updated: '~', removed: '-', unchanged: '=' };

function report(dest: ResolvedDest, actions: InstallAction[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ target: dest.id, displayName: dest.displayName, skillsDir: dest.skillsDir, actions }) + '\n');
    return;
  }
  process.stdout.write(`\n${dest.displayName}:\n`);
  for (const a of actions) {
    process.stdout.write(`  [${SYMBOLS[a.action] ?? '?'}] ${a.action.padEnd(10)} ${a.path}${a.detail ? `  — ${a.detail}` : ''}\n`);
  }
}

export function runSkills(mode: 'install' | 'uninstall' | 'status', opts: SkillsCliOpts): void {
  const json = Boolean(opts.json);
  const sourceDir = findBundledSkillDir();
  const dests = resolveDestinations(opts);
  if (dests.length === 0) {
    process.stdout.write('No targets selected. Nothing to do.\n');
    return;
  }
  if (opts.dryRun && mode !== 'status' && !json) {
    process.stdout.write('Dry run — no files will be written.\n');
  }
  let failed = false;
  for (const dest of dests) {
    try {
      const actions = mode === 'install'
        ? installInto(dest.skillsDir, sourceDir, Boolean(opts.dryRun))
        : mode === 'uninstall'
          ? uninstallFrom(dest.skillsDir, Boolean(opts.dryRun))
          : statusOf(dest.skillsDir, sourceDir);
      report(dest, actions, json);
    } catch (e) {
      failed = true;
      process.stderr.write(`Error (${dest.id}): ${(e as Error).message}\n`);
    }
  }
  if (mode === 'install' && !opts.dryRun && !json && !failed) {
    process.stdout.write('\nDone. Restart your agent (or start a new session) so it picks up the skill.\n');
  }
  if (failed) {
    process.exitCode = 1;
  }
}
