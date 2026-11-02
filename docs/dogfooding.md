# Dogfooding: evidence record, learning-loop measures and triage

This document says how the owner's daily use of U2OS is recorded, how to tell whether continued use makes U2OS more useful, and how verified blockers become GitHub issues. It adds no code and no telemetry. Serves Milestone B ([PLAN.md](../PLAN.md)).

**Status: the process is defined; no use is recorded or claimed here.** The repository holds no owner-recorded live use. Anything not recorded is `unknown`, never success.

Evidence levels used below, informally: implemented, fixture-tested, CI-validated (the suite in `.github/workflows/test.yml`), live-validated (observed in the owner's real use and recorded), incomplete, planned.

## 1. The record

A Markdown file the owner keeps **in their own vault**, for example `dogfooding/YYYY-MM.md`. It is local, editable and never committed to this public repository. One dated entry per workflow run worth noting; not every use needs an entry.

Fields:

| Field | Meaning |
|---|---|
| date | `YYYY-MM-DD` |
| workflow | an anonymous label, such as `morning-brief` or `job-hunt-review` |
| intended outcome | what you wanted, stated before or at the start |
| completed | `yes`, `no`, `partial` or `unknown`. **Default `unknown`.** Use `yes` only for an outcome you checked |
| owner intervention | what you had to do beyond an expected approval (clarify, correct, reconnect, recover by hand), or `none` |
| workaround | what you did instead, if anything |
| failure or friction | what went wrong or was slow or confusing, in your words |
| time saved | only if you measured it; otherwise omit. Never estimate silently |
| follow-up issue | issue number, or `none` |

Never record message bodies, recipients, credentials, provider responses, answers to application questions or personal facts. Use labels and IDs; look the detail up in U2OS by ID when needed.

Example (fictional placeholder data):

```markdown
## 2026-01-15 · workflow-a
- intended outcome: a short brief of today's calendar before 08:00
- completed: partial
- owner intervention: corrected one wrong meeting time
- workaround: checked the calendar by hand
- failure or friction: the brief listed an event twice
- time saved: unknown
- follow-up issue: #000 (placeholder)

## 2026-01-16 · workflow-b
- intended outcome: review three new leads
- completed: unknown
- owner intervention: unknown
- workaround: none
- failure or friction: none noticed
- time saved: unknown
- follow-up issue: none
```

## 2. Learning-loop measures

Each measure maps to evidence that already exists. **Observed** means counted from a stored record. **Inferred** means a judgement or estimate; label it as such when reporting.

| Measure | Existing evidence | Label |
|---|---|---|
| Knowledge improvement: does U2OS know more and more correctly over time | `memory.fact_recorded`, `memory.fact_corrected`, `memory.fact_deleted`, `memory.fact_reclassified` and `agent.memory_candidate.proposed` / `.rejected` in the journal ([vault](vault.md#the-journal)); `config.changed` for `job-hunt/answers.yaml` (key names only); job-hunt evidence answers in `job-hunt/evidence/` ([job hunt](job-hunt.md#evidence-resolution)) | Counts of corrections and additions are observed. Whether knowledge is now *better* is inferred |
| Intervention frequency: how often you must step in | `agent.action.proposed`, `.approved`, `.rejected` (approvals are expected, not failures); `GET /api/actions/pending`, `GET /api/actions/operations`; your record's *owner intervention* field | Approval and rejection counts are observed. Which interventions were avoidable is your judgement (inferred) |
| Task reliability: did work finish correctly | `agent.action.completed` and `.failed`, `routine.completed` and `.failed` (with reason codes) in the journal; `GET /api/actions/:id/explain`; your record's *completed* field | Completion and failure counts are observed. "Correct" is only known if you checked it and recorded `yes` |
| Repeated friction: the same problem recurring | Your record's *failure or friction* and *follow-up issue* fields across entries; repeated `routine.failed` / `agent.action.failed` with the same reason code | Recurrence of recorded entries is observed; grouping them as "the same problem" is inferred |
| Proactivity: useful work started without being asked | `routine.fired` (with `trigger` and `slot`), `notification.sent`, `task.created`, `commitment.made`, `agent.action.proposed` from routines or the autopilot (`GET /api/job-hunt/operations`) | That something fired is observed. That it was *useful* or wanted is inferred (record it) |
| Trust: how much you let it do | `config.changed` entries for `policies.yaml` (keys and old/new values, channel `api`/`cli`/`external`); approve versus reject ratio; job-hunt autopilot mode (`job-hunt/autopilot.yaml`) | Policy and mode changes are observed. Trust itself is inferred; a self-rating in your record is your own judgement |

**Not currently measurable:**

- Time saved. U2OS records no baseline for the manual alternative; only your own measured entry counts.
- Whether a completion claim was true. The journal records that U2OS finished, not that the result was right.
- Usefulness or relevance of a notification or proposal.
- Who made an external config edit (the journal says only that it was not U2OS).
- Quality of model output. The journal never holds model or provider text, by design.
- Monetary cost. Usage coverage is partial and missing usage is unknown, not free ([acceptance](personal-acceptance.md#two-week-private-scorecard)).
- Anything about use that happened before an entry was written.

## 3. Triage: from record to issue

Not every observation becomes an issue. File one only when the blocker is **verified** (you reproduced it or can point to a stored record) and **not already tracked**.

Priority order:

1. Security, privacy or integrity (wrong-account effect, leak, duplicate external effect, false completion claim)
2. A broken essential workflow
3. Repeated owner intervention
4. Unreliable or unexplained outcomes
5. Usability
6. Enhancements

Steps:

1. Confirm the entry is verified, not a one-off misunderstanding.
2. **Search for duplicates** first: `gh issue list --search "<keywords>" --state all`, plus [PLAN.md](../PLAN.md)'s "Later" section. Comment on an existing issue instead of filing a second.
3. Keep two priorities apart in the issue: **owner-confirmed priority** (what you decided) and **suggested priority** (anything a model or this table proposed). A suggestion is never recorded as confirmed.
4. File using the template below. Say which milestone it serves ([AGENTS.md](../AGENTS.md)).
5. Write the issue number into the entry's *follow-up issue* field.

Issue template (reference the entry by anonymous label only):

```markdown
## Problem
What went wrong, in redacted terms. Record entry: `workflow-a` on 2026-01-15.

## Evidence
Journal/audit IDs (not contents), or reproduction steps with fixture data.

## Priority
Owner-confirmed: <level, or "not yet confirmed">
Suggested: <level and why>

## Goal / Acceptance criteria
- [ ] ...

## Milestone served
```

## 4. Worked evaluation: job hunt

Source: this repository only (tests, docs, merged work). **Live validation is PENDING: no owner-recorded live use of job hunt exists in the repo.**

What the repository shows, by evidence level:

- Implemented and documented: search of Greenhouse and Lever boards, scoring, evidence resolution, owner approve-and-submit, autopilot modes, read-only Agent Operations ([job hunt](job-hunt.md)).
- Fixture-tested and CI-validated: `tests/job-hunt-*.test.js`, `tests/job-autopilot.test.js`, `tests/job-owner-submit.test.js`, `tests/job-answers-api.test.js`, `tests/jobs-mcp.test.js` and related, run by the suite in CI.
- Live-validated: none recorded.
- Incomplete: company research is not attached to jobs (the Company tab shows an empty state), and the posting is not split into requirements ([job hunt](job-hunt.md), Limitations).

What each measure would need to be evaluated live:

| Measure | Needed |
|---|---|
| Knowledge improvement | Entries over weeks; counts of evidence answers and `custom:` answer keys added, and whether later applications needed fewer questions answered |
| Intervention frequency | A record entry per review or submit session, with avoidable interventions separated from the expected approval |
| Task reliability | Outcome of each application (submitted, unconfirmed, failed) checked against the company's own confirmation, recorded as `yes` only when verified |
| Repeated friction | Several entries naming the same form, board or question type |
| Proactivity | Which autopilot cycles ran and whether any lead it surfaced was one you wanted |
| Trust | Autopilot mode and `policies.yaml` changes over time, with your own reason in the record |

Current result for every measure: `unknown`.

## Related

- [Personal acceptance and two-week scorecard](personal-acceptance.md)
- [Progress record](personal-agent-progress.md)
- [The vault and its journal](vault.md#the-journal)
