-- U2OS Phase 1 schema. Every statement is idempotent (IF NOT EXISTS) so this
-- file can be executed on every startup without harm.

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  causation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  inferred INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  last_confirmed_at TEXT,
  provenance TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL REFERENCES entities(id),
  relation TEXT NOT NULL,
  to_entity_id TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  inferred INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relationships(to_entity_id);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  location TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT 'personal',
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'mock-calendar',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  body TEXT,
  folder TEXT DEFAULT 'inbox',
  is_read INTEGER DEFAULT 0,
  received_at TEXT,
  created_at TEXT NOT NULL,
  -- Phase 7: set on email.draft, carried through so a later email.send
  -- sharing the same request-scoped correlation_id can be compared against
  -- it for auto-detected-edit feedback (docs/feedback.md). NULL for emails
  -- that predate Phase 7 or were never drafted through this path (e.g.
  -- seeded/received mail). Pre-existing installs get this column added by
  -- server/db/connection.js's additive migration, run before this file.
  correlation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_emails_correlation ON emails(correlation_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  due_at TEXT,
  related_entity_id TEXT REFERENCES entities(id),
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  request_text TEXT,
  model TEXT,
  tool TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '{}',
  reasoning_summary TEXT,
  policy_domain TEXT,
  policy_rule TEXT,
  autonomy_level INTEGER,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  approved_at TEXT,
  result TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Phase 6 / PROMPT.md §9: Task/Trigger Engine + Proactive Agent additions.
-- See docs/automation.md for the full design contract this mirrors exactly.
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'timer' | 'schedule' | 'event_rule' | 'condition_watch'
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',   -- JSON, shape depends on `kind`
  last_fired_at TEXT,
  next_check_at TEXT,              -- for timer/schedule; NULL for event_rule/condition_watch (not next_check_at-scheduled)
  source TEXT NOT NULL DEFAULT 'system',  -- 'system' (seeded) | 'user' (created via API)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_kind ON triggers(kind);

-- Dedupe log for condition_watch built-in checks (calendar_approaching,
-- task_overdue, birthday_approaching) so the same underlying object never
-- double-fires the same trigger. object_id encodes whatever makes the
-- object unique per firing (birthday_approaching includes the year so it
-- naturally fires again next year).
CREATE TABLE IF NOT EXISTS trigger_fired_log (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers(id),
  object_id TEXT NOT NULL,
  fired_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_fired_unique ON trigger_fired_log(trigger_id, object_id);

-- agent.evaluateEvent()'s 'recommend'/'prepare' decisions: a lightweight,
-- dismissible suggestion distinct from a pending agent_actions approval --
-- it is never auto-executed and never blocks on approval. Optionally carries
-- a dashboard schema (the before-meeting briefing for calendar.event_approaching).
CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  decision TEXT NOT NULL,          -- 'recommend' | 'prepare'
  event_type TEXT,
  event_id TEXT,
  tool TEXT,
  arguments TEXT,
  reasoning_summary TEXT,
  dashboard TEXT,                  -- JSON dashboard schema, or NULL
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'accepted' | 'dismissed'
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  correlation_id TEXT,
  created_at TEXT NOT NULL
);

-- Phase 7 / PROMPT.md's feedback loop, per docs/feedback.md's schema exactly.
-- Feedback is data like everything else in U2OS: it may only ever influence
-- *prioritization* (what gets surfaced, how urgently, in what order) --
-- nothing in this table is ever read by server/policy/policy-engine.js, and
-- nothing that reads this table may write to policies.yaml or construct a
-- PolicyEngine differently. See server/feedback/prioritizer.js.
CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,     -- 'agent_action' | 'recommendation' | 'dashboard_card' | 'notification'
  subject_id TEXT NOT NULL,
  outcome TEXT NOT NULL,          -- 'accepted' | 'rejected' | 'edited' | 'ignored' | 'postponed' | 'dismissed' | 'marked_useful'
  detail TEXT NOT NULL DEFAULT '{}',  -- JSON, e.g. { editedFields: [...] } for an 'edited' outcome
  correlation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_subject ON feedback_events(subject_type, subject_id);
