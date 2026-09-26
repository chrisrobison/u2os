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
  updated_at TEXT NOT NULL,
  -- Data-processing privacy policy (issue #2), same axis/default as
  -- facts.classification below: public | personal | private | sensitive.
  classification TEXT NOT NULL DEFAULT 'personal',
  deleted_at TEXT
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
  -- Data-processing privacy policy (PLAN.md Phase 6), separate from tool
  -- authorization: public | personal | private | sensitive. Governs whether
  -- this fact may be included in context sent to a remote model provider --
  -- see server/policy/data-processing-policy.js.
  classification TEXT NOT NULL DEFAULT 'personal',
  status TEXT NOT NULL DEFAULT 'current',
  supersedes_fact_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);

CREATE TABLE IF NOT EXISTS fact_revisions (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fact_revisions_fact ON fact_revisions(fact_id, created_at);

-- Semantic memory retrieval (PLAN.md Phase 5): a small local embedding
-- index/access mechanism OVER the structured entities/facts/relationships
-- above, never a replacement for them. One row per (subject, model) --
-- re-embedding with a different model does not overwrite an older model's
-- vector. `vector` is stored as a JSON array (plain SQLite, no vector
-- extension) since cosine similarity is computed application-side over a
-- personal-scale dataset -- see server/memory/embedding-store.js.
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  model TEXT NOT NULL,
  vector TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(subject_type, subject_id, model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_subject ON embeddings(subject_type, subject_id);

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
  created_at TEXT NOT NULL,
  -- Data-processing privacy policy (issue #2), same axis/default as
  -- facts.classification above.
  classification TEXT NOT NULL DEFAULT 'personal',
  status TEXT NOT NULL DEFAULT 'active',
  deleted_at TEXT
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
  -- Policy-engine sub-category (business/interviews/personal) used for
  -- calendar.reschedule autonomy decisions. Distinct from, and NOT to be
  -- conflated with, the `classification` column below.
  category TEXT NOT NULL DEFAULT 'personal',
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'mock-calendar',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Data-processing privacy policy (issue #2), same axis/default as
  -- facts.classification above -- a separate axis from `category` above.
  classification TEXT NOT NULL DEFAULT 'personal'
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
  correlation_id TEXT,
  -- Data-processing privacy policy (issue #2), same axis/default as
  -- facts.classification above.
  classification TEXT NOT NULL DEFAULT 'personal'
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
  updated_at TEXT NOT NULL,
  -- Data-processing privacy policy (issue #2), same axis/default as
  -- facts.classification above.
  classification TEXT NOT NULL DEFAULT 'personal'
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
  rejected_by TEXT,
  rejected_at TEXT,
  result TEXT,
  correlation_id TEXT,
  -- Explainability (PLAN.md Phase 9): retrieved memory item ids
  -- (facts/entities/relationships/events) that actually informed this
  -- proposed action's plan, after the data-processing privacy filter --
  -- see server/agent/explain.js.
  context_provenance TEXT,
  account_binding TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Objective/run progress is distinct from the authorization audit above and
-- from durable action delivery below. No run row is itself an execution claim.
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  conversation_id TEXT,
  goal_id TEXT,
  goal_revision INTEGER,
  status TEXT NOT NULL,
  objective_status TEXT NOT NULL DEFAULT 'unverified',
  model_call_count INTEGER NOT NULL DEFAULT 0,
  token_limit INTEGER NOT NULL DEFAULT 20000,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  metered_model_calls INTEGER NOT NULL DEFAULT 0,
  voice_confidence REAL,
  continuation_after_step INTEGER,
  continuation_claimed INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  cancelled_by TEXT,
  step_limit INTEGER NOT NULL DEFAULT 16,
  step_count INTEGER NOT NULL DEFAULT 0,
  elapsed_limit_ms INTEGER NOT NULL DEFAULT 86400000,
  deadline_at TEXT,
  budget_stop_reason TEXT,
  output_classification TEXT NOT NULL DEFAULT 'sensitive',
  reasoning_summary TEXT,
  response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_goal ON agent_runs(goal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  step_index INTEGER NOT NULL,
  tool TEXT NOT NULL,
  arguments TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  context_provenance TEXT,
  account_context TEXT,
  model_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  action_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step_index)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_action ON agent_run_steps(action_id);

-- Durable execution state is intentionally separate from agent_actions:
-- agent_actions remains the immutable-ish authorization/audit record, while
-- this table owns operational delivery state, leases, and retry scheduling.
CREATE TABLE IF NOT EXISTS action_queue (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE REFERENCES agent_actions(id),
  correlation_id TEXT,
  tool TEXT NOT NULL,
  arguments TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  error_class TEXT,
  approval_reference TEXT,
  policy_decision_reference TEXT,
  actor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_queue_runnable
  ON action_queue(status, next_attempt_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS action_attempts (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES action_queue(id),
  attempt_number INTEGER NOT NULL,
  lease_owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'executing',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  error_class TEXT,
  UNIQUE(queue_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_action_attempts_queue
  ON action_attempts(queue_id, attempt_number);

CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  entity_id TEXT REFERENCES entities(id),
  passphrase_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  scrypt_params TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);

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
  lease_owner TEXT,
  lease_expires_at TEXT,
  source TEXT NOT NULL DEFAULT 'system',  -- 'system' (seeded) | 'user' (created via API)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_kind ON triggers(kind);
CREATE INDEX IF NOT EXISTS idx_triggers_due_lease ON triggers(enabled, kind, next_check_at, lease_expires_at);

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

CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  confidence TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  correlation_id TEXT,
  proposed_by TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  promoted_fact_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status, created_at);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_id, updated_at DESC);

-- Owner-authored goals launch bounded reads explicitly or via selected wakes.
-- Wake consumption and individual run delivery are not completion claims.
CREATE TABLE IF NOT EXISTS goal_wakes (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  goal_revision INTEGER NOT NULL,
  trigger_id TEXT NOT NULL UNIQUE,
  fire_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT UNIQUE,
  blocker TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_wake_pending ON goal_wakes(goal_id) WHERE status = 'pending';

-- Finite owner-selected web research, checkpointed via ordinary goal wakes.
CREATE TABLE IF NOT EXISTS goal_research_schedules (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  goal_revision INTEGER NOT NULL,
  interval_hours INTEGER NOT NULL,
  max_passes INTEGER NOT NULL,
  scheduled_passes INTEGER NOT NULL DEFAULT 1,
  successful_passes INTEGER NOT NULL DEFAULT 0,
  wake_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  blocker TEXT,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_research_active ON goal_research_schedules(goal_id) WHERE status = 'active';

-- Derived search evidence and explicit owner review, never established facts.
CREATE TABLE IF NOT EXISTS goal_findings (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  review_goal_revision INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(goal_id, url)
);
CREATE TABLE IF NOT EXISTS goal_finding_sources (
  finding_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  goal_revision INTEGER,
  observed_at TEXT NOT NULL,
  account TEXT,
  mock INTEGER NOT NULL DEFAULT 0,
  classification TEXT NOT NULL DEFAULT 'sensitive',
  PRIMARY KEY(finding_id, action_id)
);
CREATE TABLE IF NOT EXISTS goal_finding_index (
  action_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_findings_seen ON goal_findings(goal_id, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  completion_criteria TEXT NOT NULL,
  constraints TEXT NOT NULL DEFAULT '[]',
  permitted_scope TEXT NOT NULL DEFAULT '{}',
  budgets TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_owner ON goals(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'private',
  correlation_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session ON conversation_messages(session_id, created_at DESC);

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

-- Device/capability subsystem, Phase 1 (docs/devices.md): the persisted half
-- of the device registry -- one row per device any registered DeviceAdapter
-- has discovered, mirroring the `triggers` table's pattern (persisted,
-- adapter-populated rows; the adapters themselves and the capability
-- registry stay in-memory/code, same split as ToolRegistry vs `triggers`).
-- `capabilities` is the JSON array of capability ids this device currently
-- advertises (server/devices/capability-registry.js defines what a
-- capability id actually means) -- never a source of truth for what a
-- capability DOES, only which devices claim to support it.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  owner TEXT,
  location TEXT,
  -- 'online' | 'offline'. Presence, not authorization.
  status TEXT NOT NULL DEFAULT 'offline',
  -- Trust lifecycle (PLAN.md-style phased -- pairing/revocation flow is
  -- future work): 'untrusted' | 'paired' | 'trusted' | 'revoked'. A
  -- resolver MUST treat 'revoked' as ineligible for every capability,
  -- always -- see server/devices/device-registry.js.
  trust TEXT NOT NULL DEFAULT 'untrusted',
  capabilities TEXT NOT NULL DEFAULT '[]',
  -- Adapter-specific extra data (e.g. a browser device's display/input
  -- capability flags). Deliberately unconstrained -- see docs/devices.md's
  -- adapter-authoring section.
  metadata TEXT NOT NULL DEFAULT '{}',
  -- Which registered DeviceAdapter (by its `.id`) owns this device -- how
  -- DeviceRegistry routes an invoke()/getStream() call to the right
  -- adapter instance. Not an end-user-facing field.
  adapter TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(type);
CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);

-- Multiple account instances per connector (issue #163, PR 1 of 5): a
-- connector (e.g. 'google', 'imap') may have N separately configured,
-- separately credentialed instances (e.g. two IMAP mailboxes), each with its
-- own vault_key into server/security/vault.js's encrypted file storage
-- (vault_key is an arbitrary string key, not necessarily connector_id --
-- server/integrations/connection-instances.js writes it as
-- '<connectorId>__<instanceId>'). `metadata` is a JSON text blob for
-- NON-SECRET display/provenance data only (e.g. { migratedFrom:
-- 'legacy-single-file' } for a row created by the one-time legacy
-- *.enc.json migration) -- credentials themselves live only in the vault,
-- never here. Later PRs in #163's sequence add API routes/OAuth/provider
-- routing on top of this table; this PR only adds the table and the
-- migration that populates it from any pre-existing single-account
-- credential files.
CREATE TABLE IF NOT EXISTS connection_instances (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  vault_key TEXT NOT NULL UNIQUE,
  metadata TEXT,
  last_error TEXT,
  last_sync_at TEXT,
  credential_revision INTEGER NOT NULL DEFAULT 0,
  smtp_instance_id TEXT,
  smtp_pair_initialized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_connection_instances_connector ON connection_instances(connector_id, deleted_at);

-- Google instances may sync Calendar, Gmail, and Contacts independently.
-- A per-instance, per-domain row prevents one service or account from
-- overwriting another's freshness/error state.
CREATE TABLE IF NOT EXISTS connection_sync_state (
  instance_id TEXT NOT NULL REFERENCES connection_instances(id),
  domain TEXT NOT NULL,
  last_sync_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, domain)
);
