import { Tool } from './tool.js';

// MOCK: no real network call. Returns clearly-labeled canned results, per
// docs/tools.md ("explicitly allowed to return canned/labeled-mock results
// since there is no real web to search").
export class WebSearchTool extends Tool {
  get name() { return 'web.search'; }
  get domain() { return 'web'; }
  get category() { return 'read'; }
  get schema() {
    return { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  }
  async execute(args) {
    return {
      query: args.query,
      mock: true,
      results: [
        {
          title: `Mock result for "${args.query}"`,
          url: 'https://example.invalid/1',
          snippet: 'This is a labeled mock search result. Phase 1 has no real web access.',
        },
        {
          title: `Another mock result for "${args.query}"`,
          url: 'https://example.invalid/2',
          snippet: 'web.search is a mocked tool in Phase 1 -- see docs/tools.md.',
        },
      ],
    };
  }
}
