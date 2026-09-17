// MOCK provider: no real network call. Returns clearly-labeled canned
// results, per docs/tools.md ("explicitly allowed to return canned/labeled
// -mock results since there is no real web to search"). Extracted verbatim
// from the logic that used to live inline in web-tools.js so the tool can be
// routed through provider-registry.js like every other domain.
export const id = 'mock-web-search';

export function search({ query }) {
  return {
    query,
    mock: true,
    results: [
      {
        title: `Mock result for "${query}"`,
        url: 'https://example.invalid/1',
        snippet: 'This is a labeled mock search result. Phase 1 has no real web access.',
      },
      {
        title: `Another mock result for "${query}"`,
        url: 'https://example.invalid/2',
        snippet: 'web.search is a mocked tool in Phase 1 -- see docs/tools.md.',
      },
    ],
  };
}
