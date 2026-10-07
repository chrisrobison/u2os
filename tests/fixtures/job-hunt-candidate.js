export const RESUME = {
  basics: { name: 'Pat Example', label: 'Engineer', summary: 'Engineering leader and hands-on architect with three decades of experience.', email: 'pat@example.com', phone: '(555) 010-0000', location: { city: 'San Francisco', region: 'CA' }, profiles: [{ network: 'GitHub', username: 'patexample', url: 'https://github.com/patexample' }] },
  work: [
    { company: 'D. Harris Tours, Inc.', position: 'CTO', period: 'March, 2020 - Present', summary: '<ul><li>Designed an end-to-end transportation platform: CRM, scheduling, dispatch, GPS, invoicing</li><li>Grew the fleet from 2 to 14 vehicles</li></ul>' },
    { company: 'Conversant, Inc.', position: 'Manager, Software Engineering', period: 'July, 2010 - March, 2020', summary: '<ul><li>Owned the iOS and Android MRAID SDK; IAB MRAID 2.0 standards work</li></ul>' },
  ],
  skills: [{ name: 'Programming Languages', keywords: ['Python', 'JavaScript', 'Go', 'Rust', 'Swift'] }],
  education: [{ institution: 'CSU Chico', area: 'Computer Science' }],
  references: [{ name: 'Someone', reference: 'private reference text' }],
};

export const REPOS = [
  { name: 'u2os', url: 'https://github.com/patexample/u2os', description: 'Personal agent OS: deterministic orchestration, MCP tools, policy outside the model, durable action queue', language: 'JavaScript', topics: ['agents', 'mcp'], stars: 5, pushedAt: '2026-10-01T00:00:00Z', readme: 'Agent runtime with approval and audit trails' },
  { name: 'mindgraph', url: 'https://github.com/patexample/mindgraph', description: 'Graph notes', language: 'JavaScript', topics: [], stars: 1, pushedAt: '2026-09-01T00:00:00Z', readme: '' },
  { name: 'dotfiles', url: 'https://github.com/patexample/dotfiles', description: 'My config', language: 'Shell', topics: [], stars: 0, pushedAt: '2025-01-01T00:00:00Z', readme: '' },
];

export const PREFS = {
  minimum_score: 82, locations: ['San Francisco', 'Bay Area hybrid', 'Remote US'],
  home: { city: 'San Francisco', region: 'CA', country: 'US', areas: ['san francisco', 'sf', 'bay area', 'oakland'] },
  minimum_salary: 170000, preferred_roles: ['staff engineer', 'cto'], avoid: [], interests: ['AI agents'], narratives: {},
};

export function job(overrides = {}) {
  return {
    id: 'job_test', company: 'Tahoma AI', role: 'Founding Engineer', locations: ['San Francisco, CA'], remote: false, salary: { min: 180000, max: 240000, currency: 'USD', raw: '$180k - $240k' },
    equity: null, visa: null, technologies: ['TypeScript', 'Python'], description: 'We build deterministic orchestration around LLM agents.', contactEmails: [], applicationUrls: [], companyUrl: null, status: 'discovered', ...overrides,
  };
}

/** A scripted model: `reply` is an object or a function of the prompt. */
export function fakeLlm(reply, { id = 'fake-model' } = {}) {
  const calls = [];
  return {
    calls,
    provider: { id, complete: async (system, user) => { calls.push({ system, user }); const value = typeof reply === 'function' ? reply({ system, user }) : reply; if (value instanceof Error) throw value; return typeof value === 'string' ? value : JSON.stringify(value); } },
  };
}

export const modelAnswer = (points = {}, extra = {}) => ({
  dimensions: Object.fromEntries(['experience', 'seniority', 'technical', 'projects', 'company', 'interest'].map((key) => [key, { points: points[key] ?? 0, reason: `${key} reason` }])),
  confidence: 0.85, concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], ...extra,
});
