import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { runSkills, findBundledSkillDir } from '../packages/cli/src/commands/install/skills.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_SKILL = path.resolve(__dirname, '../skills/maven-indexer/SKILL.md');

describe('maven-indexer-cli skills', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-skills-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves the repo-root skill when running from source', () => {
    expect(path.join(findBundledSkillDir(), 'SKILL.md')).toBe(REPO_SKILL);
    expect(fs.readFileSync(REPO_SKILL, 'utf-8')).toMatch(/^---\nname: maven-indexer\ndescription: .+\n---\n/);
  });

  it('installs, is idempotent, and uninstalls', () => {
    const dest = path.join(tmp, 'maven-indexer', 'SKILL.md');

    runSkills('install', { dir: tmp, dryRun: true });
    expect(fs.existsSync(dest)).toBe(false);

    runSkills('install', { dir: tmp });
    expect(fs.readFileSync(dest, 'utf-8')).toBe(fs.readFileSync(REPO_SKILL, 'utf-8'));
    const mtime = fs.statSync(dest).mtimeMs;

    runSkills('install', { dir: tmp });
    expect(fs.statSync(dest).mtimeMs).toBe(mtime);

    runSkills('uninstall', { dir: tmp });
    expect(fs.existsSync(path.dirname(dest))).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('never overwrites or deletes a different skill with the same directory name', () => {
    const foreign = path.join(tmp, 'maven-indexer', 'SKILL.md');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, '---\nname: something-else\n---\n');

    runSkills('install', { dir: tmp });
    expect(process.exitCode).toBe(1);
    runSkills('uninstall', { dir: tmp });
    expect(fs.readFileSync(foreign, 'utf-8')).toBe('---\nname: something-else\n---\n');
  });
});
