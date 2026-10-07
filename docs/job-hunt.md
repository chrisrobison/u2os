# Job hunting on your behalf

U2OS can search job boards and apply for you, unattended, within the limits you set. It is built from the parts every U2OS extension uses ([ADR 0009](adr/0009-extension-model-mcp-tools-vault-skills-routines.md)):

- a **routine** that says when to run and what to do (`routines/job-hunter.md`)
- a **skill** that says how you judge postings and how to answer for you (`skills/job-hunting.md`)
- the **job-hunt MCP server** (`mcp/jobs/`), which searches boards and fills in applications in a real, headless Chromium
- your **policy**, which decides whether an application needs your approval

## What it can and cannot do

It searches the public job boards of the companies you list, on **Greenhouse** and **Lever**, two of the most common applicant-tracking systems. It applies on the boards' own hosted application forms.

It does not use LinkedIn, Indeed or other sites whose terms prohibit automated applications or that require logging in. It never tries to solve or evade a CAPTCHA: when one appears, the application is handed to you.

## Setup

1. **Browser.** In the U2OS folder, run `npm install` and `npx playwright install chromium`. To use a Chromium you already have, set `JOBS_BROWSER_PATH` under the server's `env:` in `mcp.yaml`.
2. **Copy the example** from [`examples/vault`](../examples/vault/README.md) into your vault:
   - `mcp.yaml`
   - `policies.yaml` (or merge its `jobs:` section into yours)
   - `routines/job-hunter.md`
   - `skills/job-hunting.md`
   - `job-hunt/profile.md`
3. **Your preferences** go in `me.md`: target roles, minimum salary, locations and industries to avoid. The skill uses only what you state there.
4. **Your applicant profile** is `job-hunt/profile.md`, and everything in it may be sent to employers you apply to:
   - name, email, phone, location, current company and links
   - `resume:` a file next to the profile, such as `resume.pdf`
   - `boards:` the companies to search, such as `greenhouse:acme` for `job-boards.greenhouse.io/acme` and `lever:globex` for `jobs.lever.co/globex`
   - `answers:` your standard answers, matched by words in a question (`authorized to work: "Yes"`)
   - `max_applications_per_day:` default 5
   - `submit:` `false` fills forms without submitting them
   - the body: a default cover letter
5. **A model.** The routine needs a configured planning model; the built-in demo planner does not understand it.
6. Restart U2OS (or `POST /api/vault/mcp/restart`), check `GET /api/vault` shows the `jobs` server running, and set `enabled: true` in the routine.

Start with `submit: false`. Each run then fills real forms and saves screenshots in `job-hunt/applications/` without sending anything. When the forms look right, set `submit: true`.

## How a run goes

1. The routine searches your boards (`jobs.search_jobs`). Jobs you already applied to or skipped are left out. Greenhouse results include each application's questions.
2. The planner scores each posting with your skill. It proposes `jobs.apply` for strong matches, with answers and a short cover letter, and `jobs.skip_job` for the rest.
3. `jobs.apply` requires your approval unless your policy says otherwise. Approve it in the U2OS approvals view; the application is submitted then.
4. The server opens the form and fills your identity and resume from your profile. It fills the answers, submits, and waits for the board's confirmation.
5. You get one notification summarising the run.

To let U2OS apply without asking, set this in your vault `policies.yaml`:

```yaml
jobs:
  apply: autonomous
```

The daily limit and the ledger still apply.

## The ledger: `job-hunt/applications/`

The **Applications** view in the app lists the ledger with filters by status. It shows what was sent (answers and cover letter), the questions waiting for your answers, and the form and result screenshots.

Every attempt is a Markdown file in your vault. It records the company, title, form address, status, the answers given, the cover letter and screenshots. It is your record of what was sent in your name, and it is what makes applying exactly-once.

| Status | Meaning | Applied again? |
|---|---|---|
| `applied` | Submitted and confirmed by the board | Never |
| `unconfirmed` | Submitted, but no confirmation appeared | Never; check it yourself |
| `needs_owner` | A CAPTCHA or challenge appeared | Never; finish it yourself |
| `needs_answers` | Required questions were unanswered; nothing was sent | Yes, once answered |
| `dry_run` | Filled but not submitted (`submit: false`) | Yes |
| `failed` | The board rejected the form; nothing was sent | Yes |
| `skipped` | You (or the routine) passed on it | Never |

To re-open a job, edit its status or delete its file.

## Safety and privacy

- **Identity comes from your files, not the model.** The model only picks jobs and writes answers and cover letters. It cannot change your name, email, phone, links or resume.
- **Demographic questions** (gender, race, veteran status, disability and similar) are only ever answered from your own profile `answers`, never by the model.
- **The model never supplies a web address.** Form addresses are built from board and job ids, so the browser only goes to Greenhouse and Lever application pages.
- **Unanswerable questions stop the application** before anything is sent.
- **Submission is recorded before the click.** A crash can never cause a second application.
- **Server and board data stay local**, except what the forms send to the employer. Search results and application outcomes reach your planning model at the classification set in `mcp.yaml` (`personal` in the example), under your [data-processing policy](policies.md).

## Limits

- Only companies on Greenhouse or Lever, listed by you. Discovering new companies is up to you (or a future tool).
- Hosted forms vary. Unusual custom widgets may be reported as `needs_answers` or `failed`; the screenshots show why.
- Lever's application questions are discovered when the form is first opened. The first attempt at a Lever job therefore often returns `needs_answers`, and the next run answers them.

## Hacker News "Who is hiring?" discovery

The pipeline in [`job-hunt2.md`](job-hunt2.md) is built in phases on top of the same server and vault. Phase 1 discovers listings.

```bash
npm run u2 -- job discover hn                       # newest "Ask HN: Who is hiring?" thread
npm run u2 -- job discover hn --month "October 2026"
npm run u2 -- job discover hn --dry-run             # parse and report, store nothing
npm run u2 -- job status
```

The thread is found by searching for the title (never a fixed item id). Each top-level comment becomes one record per role, with the original text and author kept. The parser is deterministic and treats the text strictly as data: it extracts the company, roles, locations, remote, salary, equity, visa stance, technologies, contact emails and URLs, and nothing in a listing can trigger an action.

Records are stored in `job-hunt/state/hunt.sqlite` in your vault: `jobs`, `job_sources` (every sighting, with its raw text) and `application_events`. One opportunity seen through several sources (an HN comment, a Greenhouse posting, a careers page, next month's repost) is merged into one job, recognised by application URL, ATS job id, or normalised company and role. Re-running discovery never creates duplicates.

Code lives in `mcp/jobs/hunt/` (`sources/`, `jobs/`, `storage/`); the command is `server/jobhunt/cli.js`.

## Scoring jobs against you

```bash
npm run u2 -- job profile import "resume.json"    # JSON Resume; copied to job-hunt/resume.json
npm run u2 -- job github refresh                  # public repos, cached in job-hunt/state/github.json
npm run u2 -- job score [--limit 20] [--rescore] [--company foo] [--role staff] [--no-model]
npm run u2 -- job list [--min-score 80]
npm run u2 -- job show <job-id>
```

`job-hunt/preferences.yaml` (optional) sets `minimum_score` (the autonomous-application threshold, default 82), `locations`, `home.areas`, `minimum_salary`, `preferred_roles`, `avoid` and `interests`.

**Who decides what.** The model judges experience and domain match (transferable experience, not keyword counts), seniority fit, technical overlap, project overlap, company and stage, and personal interest. Code owns everything else: the weights (experience 25, seniority 20, technical 15, projects 15, location 10, company 5, compensation 5, interest 5), clamping every model number to its maximum, location and compensation from the structured facts, the total, the thresholds (90 exceptional, 80 strong, 70 plausible, 60 weak, below that skip) and the allowed narratives. A junior title caps seniority however the model scores it. Roles outside engineering are triaged without a model call. Each score stores its dimensions, confidence, reasons, concerns, recommended narrative (one of six: engineering leadership, staff/principal, developer platform, AI/agent systems, operational software, adtech/analytics), up to four relevant GitHub projects, and flags such as `relocation_required` and `salary_below_threshold` for the policy engine.

**The model** is your configured U2OS connections in your order (for example Claude first, Codex as the backup). Only CLI connections can complete plain text today. If none answers, a rule-based estimate is used, labelled degraded and capped at 79, so it can never reach the autonomous threshold. The model receives a digest of your resume (no phone, email or references) and the listing, delimited and declared untrusted data; its answer must pass schema validation or it is rejected.

## Tailored materials

```bash
npm run u2 -- job materials <job-id> [--force] [--no-pdf] [--cover-letter | --no-cover-letter]
```

Writes `job-hunt/materials/<company>/<role>/` with `resume.json` (kept so it can be regenerated), `resume.txt`, `resume.pdf` (one to two pages, rendered by headless Chromium), a cover letter (`cover-letter.txt` and `.pdf`) when the job warrants one, and `email.json` (recipient, subject, text, attachments) when the listing names an address. Each file is recorded with its SHA-256 in the `artifacts` table and the job moves to `materials_generated`. Materials are reused unless `--force`. Jobs scored by rules (no model) are refused.

**What the model can and cannot change.** Name, contact details, titles, companies, dates, locations, education and the choice of which positions to show come from your canonical `resume.json`; the model picks emphasis and wording. Its text may only claim what your sources support: `resume.json`, `job-hunt/facts.md` (facts, bullets and `## Project: Name` sections you approve, for example lifted from résumés you already sent), and your public repositories. A claim guard checks every generated sentence: each number, link, email address, technology and proper noun must appear in those sources (or, for the summary, letter and email, in the listing itself). A violation is rejected and the model is asked again with the reason; it is never silently repaired. Letters must be 250-450 words, name the company and avoid stock openers; emails are 40-170 words and the system, not the model, writes the greeting, sign-off and links. `job-hunt/voice.md` holds samples of your own writing for tone.

**Approach (strategy)** is chosen from the listing's facts, not by the model: an email address gives `DIRECT_EMAIL`, an application link `FORM_APPLICATION`, both `FORM_AND_EMAIL`, neither `MANUAL_REQUIRED`, and a score below `minimum_score` `SKIP`. Nothing is sent or submitted by `job materials`.

## Sending application emails

```bash
npm run u2 -- job send <job-id> [--force]   # propose the email through the approval gate
npm run u2 -- job reconcile                 # after approving: mark jobs contacted
```

`job send` proposes the job's `email.json` as an `email.send` action (with the staged resume and cover letter attached, see [tools](tools.md#email-attachments)). It goes through the same gate as everything else, so your policy decides whether it needs approval; by default it waits in **Approvals** in the U2OS UI, where you see the recipient, subject, body and attachment names, and approve or reject. Like the other offline commands it needs the U2OS server stopped while it runs; the pending approval is in the database when the server restarts.

Refused, whatever else: the draft still needs your input (`needs_input`), the job is unscored or scored without a model, a send is already proposed, sent or uncertain, or the job is already contacted/applied. A score below `minimum_score` is refused unless you pass `--force` (your explicit decision to go below the threshold). Intent is recorded in the `emails` table under an idempotency key (candidate, company, role, job, action and recipient) before anything is proposed, so a crash cannot cause a second send; a proposal that failed before queueing, or one you rejected, can be proposed again. `job reconcile` reads the outcome of each approved action: executed sends mark the job `contacted` with a follow-up date (`follow_up_days`, default 5 days); a failure whose outcome is uncertain marks the job `uncertain` and blocks any further send until you check Sent mail.
