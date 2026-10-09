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

**Prefilter.** Scoring a few hundred listings with a model takes a while, so `job score` first computes the rule-based estimate and sends only jobs at or above `--prefilter` (default 55) to the model. Against jobs the model had already scored, 55 kept every one it rated 70 or higher while skipping about a quarter of the calls. A screened-out job keeps its rule score, is marked degraded (so it can never auto-qualify and `job materials` refuses it) and says why in its concerns; `job score --rescore --screened --prefilter 0` sends exactly those through the model later. `--prefilter 0` turns screening off.

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

## The Job hunt page and sending from the running server

**Job hunt** in the app (Memory & automation) lists scored jobs, best first: the score and why, concerns, the recommended narrative, the approach, the materials and the draft email (recipient, subject, body, attachment names). Filters: *Ready to send*, *Needs you* (the listing asked for something your facts do not cover), *Contacted*, *Strong (80+)* and *All scored*.

The buttons propose the email through the running server's own approval gate; nothing is sent until you approve it in **Approvals**:

| Button | Tool | Needs |
|---|---|---|
| Send with Mail | `apple_mail.send` | the Apple add-on enabled (macOS), see [the add-on](../addons/apple/README.md#sending-mail-with-attachments-apple_mail) |
| Send with Gmail | `email.send` | a connected Gmail (or SMTP) account |
| Save draft in Mail | `apple_mail.draft` | the Apple add-on; saves a draft for you to review, sends nothing |

A route whose tool is not available is disabled, and the API says why; there is never a silent fallback to a different route. The duplicate rules are the same whichever route you use (one application email per job and recipient), and a draft never marks a job contacted. A job scored below `minimum_score` shows *Send ... anyway*, which is your explicit choice.

Outcomes are reconciled as soon as an action completes, fails or is rejected, and again whenever the page loads, so approved sends move jobs to `contacted` (with a follow-up date) without stopping the server. The same is available over the owner API: `GET /api/job-hunt/jobs[/<id>]`, `POST /api/job-hunt/jobs/<id>/send` with `{ "via": "gmail" | "apple_mail" | "apple_mail_draft", "force": false }`, and `POST /api/job-hunt/reconcile`. `job send` and `job reconcile` on the command line remain for the Gmail route when the server is stopped.

## Emails you send yourself, and drafts for all matches

**Contact addresses are scraped conservatively.** A plain address in a listing is kept; an obfuscated one ("name [at] example [dot] com") is believed only when it ends in a real top-level domain and looks deliberate, so prose such as "be at home. We" never becomes an address. `npm run u2 -- job reparse` re-extracts every stored job's contacts from its original text.

**Sent it yourself?** Click *I sent this myself* on the card, or run `npm run u2 -- job mark <job-id> sent [--to <address>]`. U2OS records it under the same idempotency key a gated send uses, marks the job contacted and sets the follow-up date, so the job is never proposed again.

**Drafts for every ready job.** *Save Mail drafts for all ready jobs* (or `POST /api/job-hunt/drafts`) proposes an `apple_mail.draft` for each job that has materials, a contact address and no input needed, whatever its score. Nothing is sent: each draft still passes the gate, you review it in Mail, and send it from there. A job that is already contacted, or already has a draft, is skipped. To skip the approval click for drafts only, you can allow them in `policies.yaml` (`apple_mail: { draft: autonomous }`); sends stay confirm.

## More sources: company boards, HN's jobs feed and remote boards

```bash
npm run u2 -- job discover boards [--board greenhouse:acme,lever:globex] [--all] [--dry-run]
npm run u2 -- job discover hn-jobs      # HN's own jobs feed (YC companies)
npm run u2 -- job discover remote       # RemoteOK and We Work Remotely
npm run u2 -- job discover all          # the HN thread plus all of the above
```

Everything lands in the same store as the monthly HN thread and goes through the same scoring, materials and sending. The same job seen through several sources (an HN comment, the company's Greenhouse board, a remote aggregator) is one opportunity, recognised by its application link or ATS job id, or by company and role. Re-running never duplicates.

**Company boards** are read from the public job-board APIs of Greenhouse, Lever and Ashby, which exist for exactly this. List the ones you want in `job-hunt/boards.yaml`:

```yaml
boards:
  - greenhouse:anthropic
  - lever:palantir
  - ashby:ramp
derive: true      # also read boards named by application links already in your store (the default)
```

With `derive: true` (the default) every board linked from a listing you have already seen is added, so the HN threads seed the list. Pass `--board` to read only specific boards.

**Relevance filter.** A large board lists hundreds of jobs, most of them irrelevant, so discovery stores only listings that look like engineering roles at your level (no sales, support, design, recruiting, junior or intern titles), and whose location is workable (not on-site in another country, not remote-only outside the US). Hardware, mechanical, optical and similar titles are skipped unless the title also says software (firmware, embedded, autonomy software and so on), and GTM, growth and community titles unless they name engineering work. The CLI reports how many were skipped and why; `--all` keeps everything. `npm run u2 -- job refilter [--dry-run]` applies the current filter to jobs already stored: unscored jobs that came only from boards or aggregators and fail it are marked skipped (with the reason in their history); HN-thread jobs, scored jobs and anything acted on are never touched. The filter only decides what is worth scoring; it never decides what to apply to.

**Attribution.** RemoteOK's terms require crediting and linking back to the listing; every RemoteOK record keeps its credit and its link. LinkedIn and Indeed are not sources: their terms forbid automated applications.

**Scoring a big batch.** `job score --limit N` ranks every pending job by the rule estimate and sends the most promising N to the model first, after the prefilter drops hopeless ones, so a run can be stopped any time with the best candidates already done. A failing source or board is reported and never stops the others. Listings from boards have no contact email, so their approach is the application form (not yet automated); the Job hunt page shows them with their apply link.

## Applying through forms

```bash
npm run u2 -- job plan <job-id> [--url <form-url>]   # read the form (read-only) and plan every answer
npm run u2 -- job submit <job-id> [--dry-run]        # fill the planned form; submit unless --dry-run
```

The applicant works in two steps so that what is reviewed is what is sent.

**Plan** (`job plan`, nothing is submitted). A headless browser opens the application link and reads the form, including boards that render no `<form>` tag (Ashby) and Yes/No questions built from buttons. Every field then gets a value or an explicit reason it has none:

| Field | Value comes from |
|---|---|
| name, email, phone, location, LinkedIn, GitHub, website, current company | your `resume.json` |
| resume and cover letter uploads | the tailored PDFs from `job materials` (pinned by SHA-256) |
| "desired work location" | your location |
| work authorization, sponsorship, relocation, in-office, 18+, salary expectation, start date | **only** `job-hunt/answers.yaml` |
| "how did you hear about us" | where the job was found (Hacker News, RemoteOK, the company's site, ...) |
| gender, race, veteran, disability, orientation, pronouns | *decline to self-identify* when the form offers it |
| privacy / data-processing consent boxes | accepted by default (`accept_privacy_notices`) |
| "I certify the above is true" attestations | **refused** unless you set `accept_truthfulness_attestations: true` |
| open questions ("Why do you want to work here?") | drafted by the model from your approved facts only, through the same claim guard as letters; an answer the facts cannot support is left unresolved, never improvised |
| salary history, SSN, date of birth, citizenship, criminal history, clearance, references | **never** filled: unresolved |

A plan with any unresolved required field (or an unanswered standard question, even one the board does not flag as required) is `needs_input` and cannot be submitted. A CAPTCHA, a login wall or a page with no form is `manual_required`; U2OS never solves or evades a CAPTCHA. An invisible reCAPTCHA badge, which is a passive score the board computes on its own and not a challenge, is not treated as one. `job-hunt/answers.yaml` (a commented template is created for you) is where you answer the standard questions once.

**Submit** (`job submit`). The form is re-read and must still ask the same questions as when it was planned; the uploaded files must still be the exact files the plan was made with; every required field must end up filled. Then intent is recorded **before** the click, the form is submitted, and the board's own confirmation is looked for. Outcomes: `submitted` (job becomes `applied`), `unconfirmed` (no confirmation appeared: job becomes `uncertain`), `failed` (the board showed validation errors: nothing was sent, the plan can be fixed), `manual_required`, `needs_input` (the form changed, a file changed, or a field would not fill). A crash or kill after the click leaves the application `submitting`, which is turned into `uncertain` after ten minutes and is **never retried**: check the company's confirmation email. One application exists per job and form link, so a second plan or submit for the same job is refused whatever the first one's outcome.

## The review agent

```bash
npm run u2 -- job review <job-id> [--form]
```

Nothing is sent or submitted on its own authority. Every application, whether an email or a form, first goes to the **review agent**, and only an approval for the exact content in question lets it proceed.

**Deterministic checks decide first, and no model can override them.** Any failure rejects the job without asking a model: a job scored by a model (not rules) at or above your `minimum_score`; not already contacted, applied, uncertain or skipped; no relocation or below-minimum-salary flag (unless `allow` in `autopilot.yaml` says so); not already emailed or applied (including a proposed or uncertain attempt); under the daily limits; no application to the same company inside `per_company_days`; not a staffing/agency, commission-only or unpaid posting, and not on your blocklist; for email, a plausible recipient that appears in the poster's own text (not just in stored data), a resume attached that still verifies by hash, and no unanswered input; for forms, a plan that is ready, with no blockers, whose model-written answers are all supported by your facts; and every sentence of the cover letter and email still supported by your facts (this catches a file someone edited afterwards).

**Then a model gives a second opinion.** It reads the posting (as untrusted data inside delimiters it is told never to obey), your facts, the resume, the letter or email and, for forms, the planned answers, and returns approve or reject with concerns marked blocking or minor. It can only tighten: a rejection, a blocking concern, confidence below 0.6, a malformed answer or no model at all means *not approved*. A posting that tries to instruct the AI ("ignore previous instructions...") is recorded as a note, treated as data, and judged on its merits.

**An approval is bound to its content.** It covers a hash of the posting text, the resume and letter files, the email and the plan; changing any of them invalidates it. Decisions, checks and the reviewer's notes are stored (`reviews` table) and appear in the job's history.

`job-hunt/autopilot.yaml` holds the limits and allowances the checks use, with safe defaults (nothing is enabled, and the mode is `dry_run`):

```yaml
enabled: false
mode: dry_run            # dry_run does everything except send or submit; live acts
interval_seconds: 300
limits: { applications_per_day: 8, emails_per_day: 10, per_company_days: 30 }
allow: { relocation: false, below_salary_minimum: false }
blocklist: { companies: [], domains: [], keywords: [] }
```

## Autopilot: finding and applying continuously

```bash
npm run u2 -- job autopilot setup [--autonomous]   # one-time wiring
npm run u2 -- job autopilot on | off | live | dry-run | status
```

The autopilot is a loop inside the U2OS server. Every cycle (default five minutes) it runs, in this order and one cycle at a time: **discover** (the HN thread every cycle; HN's jobs feed and the remote boards every 30 minutes; company boards hourly), **score** the most promising new jobs (best-first, after the prefilter), **prepare** materials and form plans for jobs at or above your threshold, **review** each prepared job with the review agent, then **act** on the approved ones. Each step is isolated (a failing source or job never stops the others) and bounded per cycle (`per_cycle` in `autopilot.yaml`); nothing is reviewed twice for unchanged content and nothing is proposed twice for one approval. Jobs that need you (the listing asked for something your facts do not cover, an unanswered standard question, a CAPTCHA, a review that said no) are collected under **Needs you** on the Job hunt page instead of being retried.

**Two switches, both yours, and the default is the safe one.** `job-hunt/autopilot.yaml` says whether the loop is `enabled` and whether it is `live`. The default is off, and `dry_run` does everything except send or submit: it records what it *would* do, once per approval, so you can watch it for a day before trusting it. The Job hunt page has the same switches (going live takes a deliberate second click), and shows what the last cycle did, what needs you, and, from your policy, whether each tool "runs without asking" or "waits for your approval".

**Autonomy without opening everything up.** The loop does not call `email.send` or any form tool. It calls two narrow tools of the jobs tool server, `jobs.send_application` and `jobs.submit_application`, and their only argument is a job id: the recipient, subject, body, attachments, form link and answers all come from the job hunt's own records, never from the caller. Each tool refuses unless the review agent approved the job's *current* content (the approval is bound to a hash), re-runs the deterministic checks at that moment (limits and duplicates may have changed since the review), records its intent in the ledger before acting, never retries an uncertain outcome, and in dry-run mode only records. Because of that, making these two tools autonomous grants far less than making `email.send` autonomous would, and nothing a posting says can send a different email or apply somewhere else.

`job autopilot setup` registers the tool server in `mcp.yaml` with only those two tools. Adding `--autonomous` also sets, in `policies.yaml`, `jobs: { send_application: autonomous, submit_application: autonomous }`, which is the one place where your consent to "act without asking" is written; every other action keeps its own policy, and `job autopilot revoke` puts the two back to needing approval. Restart U2OS after setup so the tools load. Emails go out through the Mail app on this Mac (the Apple add-on's sender), from `mail_sender` in `autopilot.yaml` or Mail's default account. Forms are filled in headless Chromium and never get past a visible CAPTCHA or login wall.

`autopilot.yaml` (every key optional):

```yaml
enabled: true
mode: dry_run              # live to act
interval_seconds: 300
sources: [hn, hn-jobs, remote, boards]
boards_every_minutes: 60
limits: { applications_per_day: 8, emails_per_day: 10, per_company_days: 30 }
per_cycle: { score: 6, prepare: 3, act: 3 }
allow: { relocation: false, below_salary_minimum: false }
blocklist: { companies: [], domains: [], keywords: [] }
mail_sender: ""
```

The owner API: `GET /api/job-hunt/autopilot` (status), `PUT /api/job-hunt/autopilot` with `{ "enabled": true, "mode": "live" }` (only those two keys can be changed this way), `POST /api/job-hunt/autopilot/run` (start a cycle now).

## A local model for the high-volume work

Most of the autopilot's model calls are scoring, the most mechanical judgement. Writing a resume, a letter or an email, and reviewing an application before it is sent, are where quality matters. So the work can be split between two tiers:

- **fast** (local, free): a model on your own machine served by LM Studio scores everything.
- **quality** (your cloud connections, in the order you set on the Model page, for example Claude then Codex): confirms scores near your threshold and does all writing, form-question drafting and review.

```bash
npm run u2 -- job models set-local --model qwen/qwen3.5-9b --key-file ./lmstudio.key   # key is read from the file, stored encrypted; delete the file
npm run u2 -- job models status
```

This writes `job-hunt/models.yaml` (no secrets):

```yaml
fast:
  provider: lmstudio
  base_url: http://127.0.0.1:1234
  model: qwen/qwen3.5-9b
  reasoning: 'off'          # answer directly: much faster than letting a thinking model reason first
local_bias: 12            # the local model scores about this many points higher than the quality model
confirm_margin: 10
quality: planner
```

The local model is called through LM Studio's native chat API with reasoning off. **Its score is a first opinion, never a decision.** A job whose local score, corrected by `local_bias`, is within `confirm_margin` of your threshold (so a local score of at least threshold - margin + bias) is re-scored by the quality tier before anything is written for it (`per_cycle.confirm` per cycle), and a job with only a local score is not eligible for materials. If the local server is down, fast scoring is **skipped for that cycle**: it never silently moves to the cloud. With no `fast:` section, nothing changes and the quality model does the scoring.

**Measured, not guessed.** `local_bias` and the cutoff come from scoring 40 of your jobs with both models (qwen3.5-9b, reasoning off, against Claude's scores): the two agree well (correlation 0.88) but the local model runs hot, about 12-14 points higher on average, so an uncorrected cutoff would send nearly everything to the cloud. Keeping only jobs with a local score of at least 75 kept every job Claude rated 70 or higher (and 95% of those at 65 or higher) while skipping about a third of the cloud work. It is a small sample, so treat the numbers as a starting point: it takes about 30 seconds per job on a 9B model, which is why the local budget is `per_cycle.score_fast` (default 6).

The Job hunt page shows how many model calls the last cycle made, local and cloud separately.


## Visible-browser submits (`headed`)

Some boards' passive bot scoring treats a headless browser differently. Two Ashby applications submitted headless in the first live run were not accepted (no confirmation, the form still on screen, no confirmation email); the same kind of form submitted from a normal, visible Chromium window on this Mac was accepted and showed the board's own "successfully submitted" confirmation. Nothing is spoofed or hidden: it is the same browser, with its window shown.

```bash
npm run u2 -- job submit <job-id> --headed       # one submit in a visible window
```

or for the autopilot, in `autopilot.yaml`:

```yaml
browser:
  headed: true       # form submits open a visible browser window on this Mac (default false)
  driver: playwright # which form driver reads and fills forms (default playwright)
routes:
  form: true         # the forms route is off by default
```

A window opens briefly for each form submit. The forms route stays off by default (and form-only jobs just wait for you) until you turn it on; a CAPTCHA challenge or a login wall still stops an application and hands it to you.


## One PDF when there is no cover-letter field, and memorable file names

**Cover letter and resume as one file.** When an application form has no upload field for a cover letter, the autopilot uploads a single PDF in the resume slot: the cover letter first, then the resume. (A cover-letter text box, if there is one, still gets the letter's text.) A form that does have a cover-letter upload gets two separate files. The combined file is built with the other materials whenever a letter exists (`resume-with-cover-letter.pdf`); for materials made earlier it is rebuilt from the stored resume and letter when a plan needs it, with no model call. If a form has no cover-letter field and there is no letter yet, the plan says it wants one, and the autopilot writes the letter and plans the form again. The review agent's approval already covers the letter, the resume and the plan, so what is reviewed is what is uploaded.

**File names.** What a recruiter sees in an attachment list is not `resume.pdf`. Names are chosen per job, stable across the email attachment and the form upload for the same company, personalised with the company where that reads naturally, plain ASCII, and always a light joke about the candidate rather than a claim: `Hire_Christopher_Robison_Rare_Opportunity.pdf`, `Why_Tahoma_Should_Hire_Christopher_Robison.pdf`, `A_Letter_To_Tahoma_From_Christopher_Robison.pdf`, `Christopher_Robison_Has_Entered_The_Chat_Letter_First.pdf`, and so on. If you would rather have sober names, set `file_names: plain` in `autopilot.yaml` (`Christopher_Robison_Resume.pdf`, `..._Cover_Letter.pdf`, `..._Resume_and_Cover_Letter.pdf`).

## Quality loop (#523)

- **Part-time / token-pay check.** The review agent now rejects postings that read as part-time, hourly-per-week or equity-plus-discretionary-cash roles (`not_part_time_or_token_pay_unless_allowed`). Opt in with `allow.part_time: true` in `autopilot.yaml`.
- **Answers are never cut off.** When an open form answer exceeds the field's length limit, the model is asked again for a shorter, complete answer. If it still does not fit, the question stays unresolved (the job goes to `needs_input`) rather than submitting a truncated sentence.
- **One repair pass.** When the review agent rejects a prepared job with a *blocking concern from the model* (not a failed deterministic rule), the autopilot's `revise` step rewrites the materials once with the reviewer's objections as feedback (still through the claim guard), and the new content is reviewed again. At most two revisions per job (`per_cycle.revise`, default 3 per cycle; set 0 to disable). Jobs that keep failing are left for the owner.

## Form drivers

Reading and filling an application form goes through a `FormDriver` (`mcp/jobs/hunt/applications/form/driver.js`). Playwright is the built-in implementation; the `browser.driver` key in `autopilot.yaml` picks one by name (default `playwright`). An unknown name fails loudly when the config is loaded, listing the drivers that exist.

```js
inspect({ url })  // -> schema   read-only: open the page and report its form
execute({ plan, files, submit, headed, beforeSubmit, screenshotDir })
                  // -> { status, reason?, errors?, missing?, failed?, screenshots? }
```

Everything else (planning, the plan and file checks' stored hashes, the `submitting` / `uncertain` bookkeeping, the job state changes) stays in `submit.js` and is the same for every driver. A driver must keep these guarantees:

1. A CAPTCHA, login wall or missing form returns `manual_required`; it is never worked around.
2. If the form's fields no longer hash to `plan.schemaHash` (`schemaHash()` in `schema.js`), return `schema_changed` before filling anything.
3. If an uploaded file's SHA-256 differs from the plan's, return `files_changed`.
4. Every required field must end up filled, or return `fill_incomplete`.
5. `await beforeSubmit()` immediately before the submit action, after all the checks above, and never on a dry run (`submit: false`, which returns `dry_run`). The caller records intent there, so a crash afterwards is `uncertain`.
6. An outcome that cannot be proven is `unconfirmed`, not `submitted`. Any status the caller does not recognise is treated as `uncertain`. An uncertain or unconfirmed application is never retried.

Another driver registers itself with `registerDriver(name, driver)`; `tests/job-form-driver.test.js` shows the contract against a fake driver. `planApplication` and `submitApplication` take a `driver` (object or registered name); the older `inspect` and `execute` function parameters still work and override the driver.

## Browser extension channel

A browser extension (the filling itself is a later piece; this is the channel it will use) can fetch reviewed application plans from U2OS and report what happened. It is a new trust boundary, so it is deliberately narrow.

**Pairing.** The owner, signed in, calls (a UI button is a later piece) `POST /api/extension/pairing-codes` (localhost only) and gets a one-time code, valid five minutes. The extension sends it to `POST /api/extension/v1/pair` and receives a long-lived bearer token, bound to the extension's `chrome-extension://<id>` origin. Only SHA-256 hashes of codes and tokens are stored (`<U2OS_HOME>/credentials/extension-pairings.json`, mode 0600); the token is shown once. `GET /api/extension/pairings` lists pairings and `DELETE /api/extension/pairings/:id` revokes one immediately. Ten wrong codes in a minute lock pairing for the minute.

**Endpoints** (all under `/api/extension/v1/`, `Authorization: Bearer <token>`):

| Endpoint | Purpose |
| --- | --- |
| `GET applications` | planned applications awaiting the owner (job, company, role, URL) |
| `GET jobs/:id/plan` | the reviewed plan: fields and values, file list with SHA-256, `autoSubmit` (true only in `live` mode) |
| `GET jobs/:id/files/:kind` | a reviewed PDF; sent only if its bytes still hash to the plan's SHA-256 |
| `POST jobs/:id/submitting` | records intent *before* the extension clicks submit (live mode only) |
| `POST jobs/:id/result` | `{status: filled \| submitted \| failed, planHash, reason?}` |

A plan or file is served only through `act.js` `prepare()`: a review approval bound to the current content hash, plus the deterministic checks run just now; unreviewed, rejected or edited-since-review jobs get 403. The stored plan must also still hash to the approved `planHash`.

**Results go into the same ledger as every other driver.** `filled` is recorded on the still-planned application. After `submitting`, `submitted` marks the application and job applied, and `failed` is recorded as **uncertain** (the click may have happened) and is never retried. A `failed` before `submitting` is safe to retry. A result is accepted only for the exact plan that was served under a valid approval. `submitted` without a prior `submitting` is accepted as the owner pressing submit themselves in their own browser.

**Threat model.**

| Threat | Control |
| --- | --- |
| A page on the web calls the channel | Needs a bearer token (never a cookie); CORS echoes only the paired extension origin; an `Origin` that is not that extension is refused even with a valid token |
| DNS rebinding (`evil.example` resolving to 127.0.0.1) | `Host` must be `localhost`, `127.0.0.1` or `[::1]`; otherwise 403 |
| Another machine or a proxy reaches the port (`U2OS_BIND`, tunnels, reverse proxy) | Peer address must be loopback, independent of `U2OS_BIND`; forwarding headers are ignored. Note a same-host reverse proxy or tunnel connects from loopback, so do not forward `/api/extension/` through one |
| Token theft from disk | Only a hash is stored (0600); tokens are 256-bit random, compared in constant time, never logged (the request log records method and route template only), and never accepted in a URL |
| Guessing a pairing code | 50-bit one-time codes, five-minute expiry, consumed on first use, rate limited |
| A compromised or malicious extension | It can only read plans the owner already approved and report results for them; it cannot change a plan, see unreviewed jobs, or send email. Revoke it with `DELETE /api/extension/pairings/:id` |
| Cookie/CSRF scheme | Unchanged. Extension routes never read the session, and owner routes (`pairing-codes`, `pairings`) keep cookie + CSRF |

Plans contain the owner's contact details and answers; they are served only over the loopback interface to the paired extension.

**Follow-up (not in this change).** An `extension` entry in the form driver registry (#526) needs `execute()` to queue the plan and then await a result reported over this channel, with timeouts and the uncertain-outcome rules; that is a separate piece of work. Until then the extension is driven by the owner, not by the autopilot.
