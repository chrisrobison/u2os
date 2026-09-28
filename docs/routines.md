# Routines: standing instructions U2OS carries out for you

A routine is a vault file in `routines/` that says **when** and **what**, in your own words. U2OS runs it unattended, without a chat, through the same path as everything else it does: the planner proposes actions, the policy engine decides, consequential actions wait for your approval, and every step is audited ([ADR 0007](adr/0007-owned-vault-is-the-digital-self.md), [policies](policies.md)).

```markdown
---
name: Morning brief
when:
  daily: "07:00"
  days: [mon, tue, wed, thu, fri]
---
Brief me on today's meetings, who I'm meeting and what I promised them,
and anything urgent in my inbox. Send it to me as a notification.
```

```markdown
---
when:
  event: email.received
  if:
    path: data.after.from
    contains: talent
---
A recruiter emailed me. Read the message, and draft a polite reply using the
job preferences in my vault. Don't send it.
```

## Triggers

`when:` contains exactly one of the following:

| Trigger | Runs |
|---|---|
| `daily: "HH:MM"` | Once a day at that local server time. Optional `days: [mon, …]` limits it to certain weekdays. It fires only within 60 minutes after its time, so a server that starts at noon does not replay the 07:00 brief. |
| `every_minutes: N` | Once per N-minute window. N is at least 15. |
| `event: <type>` | Once per matching event ([events](events.md)). Connector sync publishes `email.received` and `calendar.event_added` / `calendar.event_changed`. `calendar.event_approaching`, `task.overdue` and `contact.birthday_approaching` are published only while a matching condition-watch trigger exists ([automation](automation.md)); personal homes do not create one automatically. An optional `if:` holds `path` plus exactly one of `equals` (exact text) or `contains` (case-insensitive). There are no regular expressions. |

Other frontmatter:

- `name`: a display name. It falls back to the first `# Heading`, then the file name.
- `enabled: false`: pauses the routine.
- `skills: [job-hunting, tone]`: vault skills to use, up to 5 (see below).

## Skills

A skill is a vault file in `skills/` that says **how you want something done**: criteria, tone, what to report, what never to do. Routines name the skills they use, and their instructions are given to the planner right after the routine's own instruction:

```markdown
<!-- skills/job-hunting.md -->
---
description: How I evaluate job postings and what to tell me about them.
---
A strong match fits a target role, pays at least my minimum, ...
Never apply or contact employers.
```

- The skill's name is its file name (`skills/job-hunting.md` → `job-hunting`): lowercase letters, digits, `-` or `_`.
- A skill has up to 8,000 characters of instructions, and a routine's skills total at most 16,000 characters.
- If a routine names a skill that is missing or invalid, the routine is reported as invalid and never runs with only part of its instructions.
- Skills are your own instructions: they reach the configured planner like the routine text itself. Put facts about you in `me.md` (which the planner always receives in full, subject to its privacy classifications), and put how to use them in the skill.

The [example vault](../examples/vault/README.md) builds Job Hunter this way, and [skills vs packages](skills-vs-packages.md) compares it with the package workflow ([ADR 0009](adr/0009-extension-model-mcp-tools-vault-skills-routines.md)).

## Starter routines

Four ready-to-copy examples live under `examples/vault/`: **Morning brief**
(`routines/morning-brief.md`, a daily digest of today's meetings,
commitments due soon and urgent email), **Meeting prep**
(`routines/meeting-prep.md`, an `event: calendar.event_approaching`
routine that briefs you on who's in a meeting and your history with them),
**Commitment follow-up** (`routines/commitment-follow-up.md`, a daily
routine that drafts follow-ups for open commitments due or overdue) and
**Job hunter** (above). Copy a routine's file, and its skill's file if it
has one, into your vault's `routines/` and `skills/` to try it, or install
one programmatically with `installStarterContent()` in
`server/vault/starter-content.js`, which never overwrites a file you
already have at that path.

The body is the instruction, up to 4,000 characters. A routine with an invalid trigger or an empty body is reported and never runs.

## How a routine runs

1. Every minute (`U2OS_ROUTINE_TICK_MS`), U2OS checks scheduled routines. Every published event is checked against event routines.
2. Before any model call, U2OS atomically claims the routine's slot in `routine_runs`: the day, the N-minute window, or the event ID. A claimed slot never runs again, including after a restart or a crash mid-run.
3. The instruction becomes the objective of an ordinary agent run on your behalf. The run is labelled with the routine's name and trigger. For event routines, only the event's **type and identifiers** are included, never its content. The planner reads the email or other item through a normal read tool, whose result passes the data-processing policy like any other observation.
4. Every proposed action goes through the policy engine. With the default policy, sending email or rescheduling asks for your approval, exactly as it does in chat. **A routine never has more authority than you have delegated in policy.**
5. `routine.fired`, then `routine.completed` or `routine.failed`, are recorded as events. The run appears in Activity and Operations, and pending approvals appear where they always do.

## Safeguards

- **No recursion:** routines cannot react to `routine.*`, `agent.*`, `action.*`, `run.*` or `vault.*` events.
- **Runaway guard:** at most 30 routine runs start per rolling hour across all routines. Further runs are recorded as `throttled`. A manual run is always allowed.
- **Private error text:** failures store only a short error code, never model or provider text.
- **Owner account required:** nothing runs before an owner account exists.
- **Model required:** personal mode needs a configured model. Otherwise runs fail with an error code, and nothing is substituted.

## In the app

The **Routines** view lists every routine with its schedule, skills, any error and its last run, and runs one on request (**Run now**). Routines are still edited as files.

## API

Owner-only:

- `GET /api/routines` lists each routine's parsed trigger, readable schedule, errors and last run: status, the run ID to inspect, and `awaiting_approval` when an action is waiting for you.
- `POST /api/routines/run` with `{"path": "routines/morning-brief.md"}` runs a routine now.

Routines are edited as files; there is no create or update API.

## Not yet supported

- Per-routine authority. Your vault `policies.yaml` ([policies](policies.md#where-the-policy-lives)) applies to routines exactly as to chat; scoping it by routine or counterpart is PLAN.md Milestone C.
- A Routines page in the browser; use the API or Activity view for now.
- Catch-up of missed daily runs after long downtime.
