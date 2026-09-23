import { AgentTarget } from '../types.js';
import { claudeTarget } from './claude.js';
import { cursorTarget } from './cursor.js';
import { codexTarget } from './codex.js';
import { opencodeTarget } from './opencode.js';
import { geminiTarget } from './gemini.js';
import { windsurfTarget } from './windsurf.js';

/**
 * The target registry (Module 7 Req 1 AC2).
 *
 * Adding a client = create `targets/<id>.ts` implementing `AgentTarget` +
 * append one line here. The orchestrator iterates this array to resolve
 * `--target=auto|all|<csv>`.
 */
export const ALL_TARGETS: AgentTarget[] = [
  claudeTarget,
  cursorTarget,
  codexTarget,
  opencodeTarget,
  geminiTarget,
  windsurfTarget,
];

/** Finds a target by id (case-insensitive). Returns undefined if not found. */
export function findTarget(id: string): AgentTarget | undefined {
  const lower = id.toLowerCase();
  return ALL_TARGETS.find(t => t.id === lower);
}
