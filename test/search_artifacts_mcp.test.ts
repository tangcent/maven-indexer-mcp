import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (args: unknown) => Promise<any>>(),
  indexer: {
    index: vi.fn().mockResolvedValue(undefined),
    startSchedule: vi.fn(),
    startWatch: vi.fn().mockResolvedValue(undefined),
    searchClass: vi.fn(),
    search: vi.fn(),
    explainMissingVersion: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(name: string, _config: unknown, handler: (args: unknown) => Promise<any>) {
      mocks.handlers.set(name, handler);
    }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('@maven-indexer/engine', async importOriginal => ({
  ...await importOriginal<typeof import('@maven-indexer/engine')>(),
  Indexer: { getInstance: () => mocks.indexer },
  DB: { checkHealth: () => null },
}));

describe('search_artifacts MCP query routing', () => {
  const artifact = {
    id: 1, groupId: 'com.example', artifactId: 'calc', version: '1.0.0', abspath: '', hasSource: false,
  };
  const signalListeners = {
    SIGINT: process.listeners('SIGINT'),
    SIGTERM: process.listeners('SIGTERM'),
  };

  beforeAll(async () => {
    vi.stubEnv('MAVEN_INDEXER_MCP_TOOLS', 'search_artifacts');
    await import('../packages/mcp/src/index.js');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListeners[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.indexer.searchClass.mockReturnValue([{ className: 'com.example.Calc', artifacts: [artifact] }]);
    mocks.indexer.search.mockReturnValue([artifact]);
  });

  it.each(['regex:.*Calc', 'regex:^(?:com\\.example\\.)?Calc$'])('preserves regex class query %s', async query => {
    const result = await mocks.handlers.get('search_artifacts')!({ query });
    expect(mocks.indexer.searchClass).toHaveBeenCalledWith(query);
    expect(mocks.indexer.search).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('via class search');
    expect(result.content[0].text).toContain('com.example:calc:1.0.0');
  });

  it.each(['com.example:calc', 'com.example:calc:1.0.0'])('routes coordinate %s directly to artifact search', async query => {
    const result = await mocks.handlers.get('search_artifacts')!({ query });
    expect(mocks.indexer.searchClass).not.toHaveBeenCalled();
    expect(mocks.indexer.search).toHaveBeenCalledWith(query, Number.POSITIVE_INFINITY);
    expect(result.content[0].text).toContain('via artifact search');
  });
});
