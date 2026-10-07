// The candidate's legitimate professional narratives (docs/job-hunt2.md).
// A narrative is a positioning choice for a role; it never adds facts.
// The ids are the only values a model may return as `recommendedNarrative`.

export const NARRATIVES = {
  'engineering-leadership': {
    label: 'Engineering leadership',
    roles: ['CTO', 'VP Engineering', 'Director of Engineering', 'Engineering Manager', 'Head of Engineering', 'Founding Engineer with leadership scope'],
    emphasize: ['technical leadership', 'managing engineering teams', 'hands-on architecture', 'product development', 'business strategy', 'operating and startup experience', 'building teams and process', 'moving between executive and implementation work'],
  },
  'staff-principal': {
    label: 'Staff / Principal engineer',
    roles: ['Staff Software Engineer', 'Principal Engineer', 'Senior Staff Engineer', 'Software Architect', 'Founding Engineer'],
    emphasize: ['30+ years of software engineering', 'architecture', 'distributed systems', 'APIs', 'real-time systems', 'many languages', 'hands-on development', 'mentoring', 'full-stack range'],
  },
  'developer-platform': {
    label: 'Developer platform / SDK / DX',
    roles: ['Developer Experience', 'SDK Engineer', 'Platform Engineer', 'Developer Infrastructure', 'API Engineering'],
    emphasize: ['iOS and Android MRAID SDK ownership', 'IAB MRAID 2.0 standards participation', 'API design', 'millions of daily ad interactions', 'developer tooling', 'compatibility', 'documentation', 'CI/CD', 'integration design'],
  },
  'ai-agent-systems': {
    label: 'AI / agent systems',
    roles: ['AI Engineer', 'Agent Infrastructure', 'Applied AI', 'AI Platform', 'Founding AI Engineer'],
    emphasize: ['deterministic orchestration around LLMs', 'agent tool use and MCP', 'policy enforcement outside the model', 'durable action queues', 'routines and automation', 'human approval and audit trails', 'browser automation', 'structured memory'],
  },
  'operational-software': {
    label: 'Operational / logistics software',
    roles: ['logistics', 'transportation', 'operations software', 'scheduling and optimization', 'field operations', 'forward-deployed engineering', 'vertical SaaS'],
    emphasize: ['D. Harris Tours end-to-end transportation platform', 'CRM, scheduling, dispatch, GPS, notifications, invoicing, payments, routing', 'operational automation', 'fleet growth from 2 to 14 vehicles', 'about 30% daily revenue increase from optimization'],
  },
  'adtech-analytics': {
    label: 'Adtech / analytics / high-scale systems',
    roles: ['advertising', 'measurement', 'analytics', 'experimentation', 'event pipelines', 'high-scale distributed services'],
    emphasize: ['about ten years at Conversant in ad technology', 'millions of daily ads and 20M+ users a day', 'REST APIs and SDKs', 'mobile and web runtimes', 'non-blocking telemetry', 'measurement infrastructure', 'standards work'],
  },
};

export const NARRATIVE_IDS = Object.keys(NARRATIVES);
