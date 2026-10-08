// Realistic (trimmed) responses from the public job APIs, for tests/job-sources.test.js.
const esc = (html) => html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const GREENHOUSE = { jobs: [
  { id: 4461450008, title: 'Staff Software Engineer, Agent Platform', company_name: 'Acme AI', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/4461450008', first_published: '2026-09-20T10:00:00-04:00', location: { name: 'San Francisco, CA' }, offices: [{ name: 'San Francisco, CA' }],
    content: esc('<div class="content-intro"><h2>About Acme</h2><p>We build agent orchestration with deterministic control around LLMs. Stack: Python, TypeScript, Kubernetes.</p><p>Remote-friendly within the US.</p></div>'),
    pay_input_ranges: [{ min_cents: 22000000, max_cents: 28000000, currency_type: 'USD', title: 'US' }] },
  { id: 4461450009, title: 'Account Executive, Enterprise', company_name: 'Acme AI', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/4461450009', location: { name: 'New York, NY' }, content: esc('<p>Sell things.</p>') },
  { id: 4461450010, title: 'Senior Backend Engineer', company_name: 'Acme AI', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/4461450010', location: { name: 'Berlin, Germany' }, content: esc('<p>Onsite in Berlin.</p>') },
  { id: 4461450011, title: 'Junior Software Engineer', company_name: 'Acme AI', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/4461450011', location: { name: 'Remote - US' }, content: esc('<p>Entry level.</p>') },
], meta: { total: 4 } };

export const LEVER = [
  { id: 'abc-123', text: 'Engineering Manager, Dispatch', workplaceType: 'remote', createdAt: 1790000000000, hostedUrl: 'https://jobs.lever.co/globex/abc-123', applyUrl: 'https://jobs.lever.co/globex/abc-123/apply',
    categories: { location: 'Remote - US', team: 'Platform', commitment: 'Full-time' }, descriptionPlain: 'Lead the team building routing and dispatch software for fleets. Go and Postgres.',
    lists: [{ text: 'You will', content: '<li>Run the team</li><li>Ship</li>' }], additionalPlain: 'Equity offered.', salaryRange: { min: 200000, max: 240000, currency: 'USD', interval: 'per-year-salary' } },
  { id: 'abc-124', text: 'Product Designer', workplaceType: 'hybrid', hostedUrl: 'https://jobs.lever.co/globex/abc-124', categories: { location: 'London' }, descriptionPlain: 'Design.' },
];

export const ASHBY = { apiVersion: '1', jobs: [
  { id: 'a1b2', title: 'Founding Engineer', location: 'San Francisco', secondaryLocations: [{ location: 'Remote - US' }], isListed: true, isRemote: false, workplaceType: 'Hybrid', publishedAt: '2026-10-01T00:00:00.000+00:00',
    jobUrl: 'https://jobs.ashbyhq.com/tahoma/a1b2', applyUrl: 'https://jobs.ashbyhq.com/tahoma/a1b2/application', descriptionHtml: '<p>Own the core platform end to end. TypeScript, Playwright, Postgres.</p>', compensation: { compensationTierSummary: '$180K – $240K • Offers Equity' } },
  { id: 'a1b3', title: 'Hidden Role', isListed: false, jobUrl: 'https://jobs.ashbyhq.com/tahoma/a1b3', descriptionHtml: '<p>x</p>' },
] };

export const HN_JOB_IDS = [9101, 9102, 9103];
export const HN_JOB_ITEMS = {
  9101: { id: 9101, type: 'job', by: 'sarah74', time: 1791046812, title: 'RetailReady (YC W24) Is Hiring', url: 'https://www.ycombinator.com/companies/retailready/jobs/bFcgIe4-implementations' },
  9102: { id: 9102, type: 'job', by: 'pg', time: 1791000000, title: 'Quill (YC S21) is hiring a Staff Platform Engineer', text: 'Build the platform. Remote US. Email founders@quill.example', url: 'https://example.test/quill' },
  9103: { id: 9103, type: 'job', dead: true, title: 'Dead is hiring' },
};
export const YC_PAGE = '<html><head><title>Implementations Engineer at RetailReady | Y Combinator</title><meta name="description" content="Own customer implementations for retail AI."></head><body><script>var x=1</script><h1>Implementations Engineer</h1><p>San Francisco or remote in the US. $150K - $190K.</p></body></html>';

export const REMOTEOK = [
  { last_updated: 1791388805, legal: 'API Terms of Service: Please link back' },
  { slug: 'remote-staff-engineer-orbit-1', id: '1137001', date: '2026-10-06T19:35:42+00:00', company: 'Orbit', position: 'Staff Backend Engineer', tags: ['golang', 'distributed'], description: '<p>Build distributed systems in Go.</p>', location: 'Worldwide', apply_url: 'https://remoteOK.com/remote-jobs/remote-staff-engineer-orbit-1137001', url: 'https://remoteOK.com/remote-jobs/remote-staff-engineer-orbit-1137001', salary_min: 160000, salary_max: 210000 },
  { slug: 'remote-pm-spiralyze-2', id: '1137002', date: '2026-10-06T19:35:42+00:00', company: 'Spiralyze', position: 'Project Manager', tags: ['exec'], description: '<p>Manage.</p>', location: 'Worldwide', url: 'https://remoteOK.com/remote-jobs/remote-project-manager-spiralyze-1137002', salary_min: 0, salary_max: 0 },
];

export const WWR_RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>WWR</title>
<item><title>Dremio: Software Engineer - Developer Experience</title><region>Anywhere in the World</region><category>Full-Stack Programming</category>
<description>&lt;p&gt;&lt;strong&gt;Headquarters:&lt;/strong&gt; Portugal - Remote&lt;/p&gt;&lt;p&gt;Build developer tools with Java and SQL. $140,000 - $180,000&lt;/p&gt;</description>
<pubDate>Tue, 06 Oct 2026 12:00:00 +0000</pubDate><link>https://weworkremotely.com/remote-jobs/dremio-software-engineer-developer-experience</link></item>
<item><title><![CDATA[Zed: Head of Sales]]></title><region>USA Only</region><description><![CDATA[<p>Sell.</p>]]></description><link>https://weworkremotely.com/remote-jobs/zed-head-of-sales</link></item>
</channel></rss>`;

/** A fetch that serves the fixtures above (and records calls); `fail` lists URL fragments to answer 500. */
export function sourcesFetch({ fail = [], missing = [] } = {}) {
  const calls = [];
  const json = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
  const text = (value) => ({ ok: true, status: 200, text: async () => value });
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (fail.some((fragment) => u.includes(fragment))) return { ok: false, status: 500, text: async () => 'boom' };
    if (missing.some((fragment) => u.includes(fragment))) return { ok: false, status: 404, text: async () => '' };
    if (u.includes('boards-api.greenhouse.io/v1/boards/acme/')) return json(GREENHOUSE);
    if (u.includes('api.lever.co/v0/postings/globex')) return json(LEVER);
    if (u.includes('api.ashbyhq.com/posting-api/job-board/tahoma')) return json(ASHBY);
    if (u.endsWith('/jobstories.json')) return json(HN_JOB_IDS);
    const item = u.match(/\/item\/(\d+)\.json$/);
    if (item) return json(HN_JOB_ITEMS[item[1]] ?? null);
    if (u.includes('ycombinator.com/companies/retailready')) return text(YC_PAGE);
    if (u.includes('example.test/quill')) return text('<title>Quill</title>');
    if (u.startsWith('https://remoteok.com/api')) return json(REMOTEOK);
    if (u.includes('weworkremotely.com/categories/remote-programming-jobs.rss')) return text(WWR_RSS);
    if (u.includes('weworkremotely.com/categories/')) return text('<rss><channel></channel></rss>');
    return { ok: false, status: 404, text: async () => '' };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
