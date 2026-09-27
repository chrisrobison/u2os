# Job Hunter (reference package)

A deliberately small package that demonstrates how U2OS composes **capabilities → skills → automations** ([plugin architecture](../../docs/plugin-architecture.md)). Everything it touches is mock data. It never contacts a job board, never sends real email, and never submits an application.

```text
schedule (weekdays 08:00) · manual · event job.search.requested
    ↓
capability:mock.job-search          fixture job board (read)
    ↓  filter: skip ids already in automation state
skill:normalize-job   (per posting)
    ↓
skill:score-job       (per job; deterministic, 0-100)
    ↓  filter: score >= settings.candidateScore
skill:company-research (per candidate) = capability:mock.company-profile + capability:mock.job-search
    ↓
emit job.candidate    (per candidate)
    ↓
capability:mock.email-send  (per candidate, policy notifyCandidate, simulated)
    ↓
state: remember seen ids, run and candidate counts
```

## What it contains

| Kind | Id | Notes |
|---|---|---|
| Capability | `mock.job-search` | `fixture` implementation over `fixtures/jobs.json`. Read. Needs `network`. |
| Capability | `mock.company-profile` | `fixture` over `fixtures/companies.json`, keyed by company. Read. Needs `network`. |
| Capability | `mock.email-send` | `static` implementation that only echoes what it would send. **Write**, so it is policy-gated and audited. Needs `notifications.send`. |
| Skill | `normalize-job` | One `transform` step. |
| Skill | `score-job` | `filter` + `transform` steps; the score is arithmetic over your settings. |
| Skill | `company-research` | Reusable: two capabilities and a `filter`. Other packages can depend on it with `requires.skills: { company-research: ^1.0 }`. |
| Automation | `job-hunter` | Schedule, manual and event triggers; persistent state; single concurrency. |
| Policy | `notifyCandidate` | Automatic only when `input.score >= settings.autoNotifyScore`. |

No package code runs: every implementation is declarative (`fixture`, `static`, workflows), so the package never needs the `code.execute` permission.

## Walkthrough

With the U2OS server stopped (the CLI is offline, like the other `npm run` commands):

```sh
npm run u2 -- package install ./packages/job-hunter
```

```text
Job Hunter (reference) 0.1.0 (com.u2os.job-hunter)

Job Hunter (reference) wants permission to:
  ✓ access the network
  ✓ send you notifications

Automatic actions (package policies; your policies.yaml still applies):
  ✓ Email me automatically about very strong matches

Automations (installed disabled):
  - job-hunter: schedule, manual, event

Installed com.u2os.job-hunter 0.1.0. Automations are disabled until you enable them.
No permissions granted yet: npm run u2 -- package grant com.u2os.job-hunter --all
```

Grant, adjust settings (stored in U2OS, never in the package files), enable and run:

```sh
npm run u2 -- package grant com.u2os.job-hunter --all
npm run u2 -- package config com.u2os.job-hunter minimumSalary=180000 'allowedLocations=["Remote"]'
npm run u2 -- automation enable job-hunter
npm run u2 -- automation run job-hunter
npm run u2 -- automation inspect job-hunter
npm run u2 -- audit --automation job-hunter
```

While the server runs, the same operations are in the browser under **Packages** (`#/packages`) and in the owner API (`/api/packages`, `/api/automations`).

### What you will see

With the default settings, three of the five mock postings become candidates (scores 100, 80 and 90) and are announced as `job.candidate` events. Two of them clear `autoNotifyScore` (85), so the package policy allows emailing you about them automatically; the third is **skipped by policy** and recorded as a blocked action with rule `package-policy:notifyCandidate`.

Whether the two permitted emails go out without asking is still **your** decision in `policies.yaml`. U2OS has no rule for `mock.email-send`, so it asks by default: the run waits durably for your approval (in Operations), survives restarts while waiting, and continues when you approve. To delegate, add to your vault `policies.yaml`:

```yaml
mock:
  email-send: autonomous
```

To tighten instead, override the package policy without editing the package:

```sh
npm run u2 -- package config com.u2os.job-hunter --policy notifyCandidate=never
```

Run it again and nothing is new: the automation's persistent state remembers which postings it has seen.

## Permissions and policies at a glance

- **Permission** (can it ever do this?): declared in `u2os.yaml`, granted by you, enforced when the capability is invoked and again when a queued action executes.
- **Package policy** (may this specific action happen without asking?): `notifyCandidate`, evaluated by U2OS code over the step's structured input. It can only make `policies.yaml` stricter.
- **policies.yaml** (your delegated authority): the ceiling for everything.

## Tests

`tests/job-hunter-package.test.js` installs this directory and proves the composition: scheduled trigger, per-item policy, approval across a restart, events, audit attribution through child skill runs, durable de-duplication, event trigger inputs and owner policy overrides.
