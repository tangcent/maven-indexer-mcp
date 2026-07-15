import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Drift check: every tool registered in src/index.ts must have an entry in
 * README.md "Available Tools", and vice versa. Catches the "code shipped, docs
 * didn't" failure mode that left 8 of 13 tools invisible to agents.
 */
describe('doc-sync: MCP README vs packages/mcp/src/index.ts', () => {
  it('every registered tool has a README entry, and vice versa', () => {
    const indexSrc = readFileSync(path.resolve(__dirname, '../packages/mcp/src/index.ts'), 'utf-8');

    // Matches both `maybeRegister('X', ...)` (new design) and `server.registerTool("X", ...)` (legacy).
    const registered = new Set<string>();
    const toolRe = /(?:maybeRegister|server\s*\.\s*registerTool)\s*\(\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = toolRe.exec(indexSrc)) !== null) {
      registered.add(m[1]);
    }

    const readme = readFileSync(path.resolve(__dirname, '../README.md'), 'utf-8');

    // Scope to the "Available Tools" section: text between `## Available Tools`
    // and the next `## ` header (or end of file).
    const lines = readme.split('\n');
    let toolsStart = -1;
    let toolsEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Available Tools\s*$/.test(lines[i])) {
        toolsStart = i + 1;
      } else if (toolsStart >= 0 && /^##\s/.test(lines[i])) {
        toolsEnd = i;
        break;
      }
    }
    const toolsSection = toolsStart >= 0 ? lines.slice(toolsStart, toolsEnd).join('\n') : '';

    // Extract `* **\`X\`**` headers within the Available Tools section.
    const documented = new Set<string>();
    const headerRe = /^\*\s+\*\*`([^`]+)`\*\*/gm;
    while ((m = headerRe.exec(toolsSection)) !== null) {
      documented.add(m[1]);
    }

    const missingInReadme = [...registered].filter((c) => !documented.has(c));
    const extraInReadme = [...documented].filter((c) => !registered.has(c));

    expect(
      { missingInReadme, extraInReadme },
      'MCP README must document every tool registered in src/index.ts (and no extras)',
    ).toEqual({ missingInReadme: [], extraInReadme: [] });

    // Sanity: the registered set is non-empty.
    expect(registered.size).toBeGreaterThan(5);
  });
});
