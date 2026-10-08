// `npm run u2 -- job <command>` (docs/job-hunt.md).
//
//   discover hn [--month "October 2026"] [--limit n] [--dry-run]
//   status [--json]
//
// The hunt store lives in the owner's vault (job-hunt/state/hunt.sqlite), not
// in U2OS_HOME, so these commands do not need the server stopped.
import path from 'node:path';
import { getVaultDir } from '../vault/vault-dir.js';
import { openStore, huntDbPath } from '../../mcp/jobs/hunt/storage/store.js';
import { discover } from '../../mcp/jobs/hunt/discover.js';
import { importResume, loadPreferences, loadResume } from '../../mcp/jobs/hunt/candidate/profile.js';
import { fetchRepos, loadRepos, saveRepos } from '../../mcp/jobs/hunt/candidate/github.js';
import { DEFAULT_PREFILTER, scoreJobs } from '../../mcp/jobs/hunt/score-run.js';
import { generateMaterials } from '../../mcp/jobs/hunt/applications/materials.js';
import { loadFacts } from '../../mcp/jobs/hunt/candidate/facts.js';
import { candidateDigest } from '../../mcp/jobs/hunt/candidate/profile.js';
import { createJobLlm } from './llm.js';
import { stageAttachment } from '../tools/email-attachments.js';
import { reviewJob } from '../../mcp/jobs/hunt/review/agent.js';
import { loadAutopilotConfig } from '../../mcp/jobs/hunt/autopilot/config.js';
import { resolveAttachments } from '../tools/email-attachments.js';
import { planApplication, submitApplication } from '../../mcp/jobs/hunt/applications/form/submit.js';
import { loadAnswers } from '../../mcp/jobs/hunt/candidate/answers.js';
import { refilterStored } from '../../mcp/jobs/hunt/jobs/relevance.js';
import { discoverSources, SOURCES } from '../../mcp/jobs/hunt/discover-sources.js';
import { resolveBoards } from '../../mcp/jobs/hunt/sources/boards.js';
import { CONTACT_SOURCES } from '../../mcp/jobs/hunt/sources/common.js';
import { extractEmails } from '../../mcp/jobs/hunt/jobs/parser.js';
import { proposeApplicationEmail, reconcileEmails, recordManualSend } from '../../mcp/jobs/hunt/applications/send.js';
import { withOfflineHome } from '../runtime/offline-home.js';

export const USAGE = `Usage: npm run u2 -- job <command>

  discover hn [--month "October 2026"] [--limit <n>] [--dry-run]
  discover boards [--board greenhouse:acme ...] [--all] [--dry-run]   company boards (job-hunt/boards.yaml and boards seen in links)
  discover hn-jobs | remote | all [--all] [--dry-run]            HN's jobs feed, RemoteOK + We Work Remotely, everything
  profile import <resume.json> | show
  github refresh [<username>]
  score [--limit <n>] [--rescore] [--company <text>] [--role <text>] [--prefilter <n>] [--screened] [--no-model]
  materials <job-id> [--force] [--no-pdf] [--cover-letter | --no-cover-letter]
  send <job-id> [--force]       propose the application email through the approval gate
  reconcile                     update jobs from the outcome of approved sends
  plan <job-id> [--url <form-url>]      read the job's application form and plan every answer (submits nothing)
  submit <job-id> [--dry-run]           fill the planned form (and submit unless --dry-run)
  review <job-id> [--form]              the review agent: approve or reject the email (or the form plan) for sending
  mark <job-id> sent [--to <address>]   record an email you sent yourself (for example from Mail)
  reparse                       re-extract contact emails from each job's original text
  refilter [--dry-run]          skip stored, unscored board/aggregator jobs that fail the relevance filter
  list [--min-score <n>] [--limit <n>] [--json]
  show <job-id>
  status [--json]`;

function parseFlags(args, valueFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      if (valueFlags.includes(name)) {
        const value = inline ?? args[(i += 1)];
        if (value === undefined) throw new Error(`--${name} needs a value`);
        flags[name] = value;
      } else flags[name] = true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

export async function main(argv, out = console, { vaultDir = getVaultDir(), fetch: fetchImpl = fetch, now = new Date(), llm: llmOverride, send: sendOverride, reconcile: reconcileOverride } = {}) {
  const [verb, ...rest] = argv;
  if (!verb || verb === 'help' || verb === '--help') { out.log(USAGE); return 0; }
  const store = openStore(huntDbPath(vaultDir));
  try {
    switch (verb) {
      case 'discover': {
        const { flags, positional } = parseFlags(rest, ['month', 'limit', 'board']);
        if (positional[0] && positional[0] !== 'hn') {
          const preferences = loadPreferences(vaultDir);
          const source = positional[0];
          if (![...SOURCES, 'all'].includes(source)) { out.log(`Unknown source "${source}" (supported: ${SOURCES.join(', ')}, all)`); return 1; }
          const only = flags.board ? String(flags.board).split(',') : [];
          const summaries = await discoverSources({
            store, source, preferences, all: flags.all === true, dryRun: flags['dry-run'] === true, fetch: fetchImpl, now,
            month: flags.month ?? null, limit: flags.limit ? Number.parseInt(flags.limit, 10) : null,
            boards: ['all', 'boards'].includes(source) ? resolveBoards({ vaultDir, store, only }) : [],
          });
          let failed = false;
          for (const summary of summaries) {
            if (summary.source === 'hn') { out.log(`hn: ${summary.thread?.title}: ${summary.listings} records; new ${summary.created}, merged ${summary.merged}, already seen ${summary.alreadyKnown}`); continue; }
            const skipped = Object.entries(summary.skipped ?? {}).map(([reason, n]) => `${n} ${reason}`).join('; ');
            out.log(`${summary.source}${summary.boards !== undefined ? ` (${summary.boards} boards)` : ''}: fetched ${summary.fetched}, kept ${summary.kept}${skipped ? ` [skipped: ${skipped}]` : ''}${summary.dryRun ? ' (dry run: nothing stored)' : `; new ${summary.created}, merged ${summary.merged}, already seen ${summary.alreadyKnown}`}`);
            for (const entry of (summary.perBoard ?? []).slice(0, 8)) out.log(`    ${entry.board}: ${entry.kept} of ${entry.fetched}`);
            for (const failure of summary.errors ?? []) { failed = true; out.log(`    error: ${failure.source}: ${failure.error}`); }
          }
          return failed && summaries.every((summary) => (summary.errors ?? []).length && !summary.fetched) ? 1 : 0;
        }
        const summary = await discover({
          store, source: positional[0] || 'hn', fetch: fetchImpl, now, dryRun: flags['dry-run'] === true,
          month: flags.month ?? null, limit: flags.limit ? Number.parseInt(flags.limit, 10) : null,
        });
        out.log(`Thread: ${summary.thread.title} (item ${summary.thread.id})`);
        out.log(`${summary.comments} comments, ${summary.listings} job records parsed, ${summary.skipped.length} comments skipped`);
        out.log(summary.dryRun ? 'Dry run: nothing stored.' : `New: ${summary.created}  Merged into known jobs: ${summary.merged}  Already seen: ${summary.alreadyKnown}`);
        return 0;
      }
      case 'profile': {
        if (rest[0] === 'import' && rest[1]) {
          const result = importResume(vaultDir, rest[1]);
          out.log(`Imported ${result.name}'s resume (${result.jobs} positions) to ${result.target}`);
          return 0;
        }
        if (rest[0] === 'show') {
          const resume = loadResume(vaultDir);
          const preferences = loadPreferences(vaultDir);
          out.log(`${resume.basics.name}: ${resume.work.length} positions, ${(resume.skills ?? []).length} skill groups`);
          out.log(`Autonomous threshold: ${preferences.minimum_score}; locations: ${preferences.locations.join('; ')}`);
          out.log(`GitHub cache: ${loadRepos(vaultDir)?.repos.length ?? 0} repositories`);
          return 0;
        }
        out.log(USAGE);
        return 1;
      }
      case 'github': {
        const resume = loadResume(vaultDir);
        const fromResume = resume.basics.profiles?.find((profile) => /github/i.test(profile.network))?.username;
        const user = rest[1] || fromResume;
        if (rest[0] !== 'refresh' || !user) { out.log('Usage: job github refresh [<username>] (the username defaults to the GitHub profile in resume.json)'); return 1; }
        const data = await fetchRepos(user, { fetch: fetchImpl, now });
        saveRepos(vaultDir, data);
        out.log(`${data.repos.length} public repositories cached for ${user}`);
        return 0;
      }
      case 'score': {
        const { flags } = parseFlags(rest, ['limit', 'company', 'role', 'prefilter']);
        const resume = loadResume(vaultDir);
        const preferences = loadPreferences(vaultDir);
        const llm = flags['no-model'] ? null : (llmOverride ?? createJobLlm());
        if (!llm?.available) out.log(flags['no-model'] ? 'Scoring by rules only (--no-model).' : 'No model available: scoring by rules only. Scores are marked degraded and cannot reach the autonomous threshold.');
        else out.log(`Scoring with ${llm.providers.join(' then ')}`);
        const summary = await scoreJobs({
          store, resume, preferences, repos: loadRepos(vaultDir)?.repos ?? [], llm, now, rescore: flags.rescore === true,
          limit: flags.limit ? Number.parseInt(flags.limit, 10) : null, company: flags.company ?? null, role: flags.role ?? null,
          prefilter: flags.prefilter !== undefined ? Number(flags.prefilter) : DEFAULT_PREFILTER, onlyDegraded: flags.screened === true,
          onProgress: ({ job, result, done, total }) => out.log(`[${done}/${total}] ${String(result.score).padStart(3)} ${result.label.padEnd(11)} ${job.company} - ${job.role ?? '(no role)'}${result.degraded ? ' (rules)' : ''}`),
        });
        out.log(`Scored ${summary.scored} of ${summary.examined} (${summary.screened} screened out by rules, ${summary.degraded} rule-scored in all). ${Object.entries(summary.byLabel).map(([label, n]) => `${label}: ${n}`).join(', ')}`);
        for (const failure of summary.errors) out.log(`Error: ${failure.company}: ${failure.error}`);
        return summary.errors.length ? 1 : 0;
      }
      case 'materials': {
        const { flags, positional } = parseFlags(rest);
        const job = store.getJob(positional[0]);
        if (!job) { out.log(`Unknown job ${positional[0] ?? ''}`); return 1; }
        const resume = loadResume(vaultDir);
        const preferences = loadPreferences(vaultDir);
        const llm = llmOverride ?? createJobLlm();
        const candidate = { resume, preferences, facts: loadFacts(vaultDir), repos: loadRepos(vaultDir)?.repos ?? [], digest: candidateDigest(resume, preferences) };
        const result = await generateMaterials({
          store, vaultDir, job, candidate, llm, stage: stageAttachment, force: flags.force === true, pdf: flags['no-pdf'] !== true, now,
          minimumScore: preferences.minimum_score, coverLetter: flags['cover-letter'] ? true : flags['no-cover-letter'] ? false : null,
        });
        out.log(`${result.reused ? 'Materials already exist (use --force to regenerate)' : 'Materials written'}: ${result.dir}`);
        for (const [kind, artifact] of Object.entries(result.artifacts)) out.log(`  ${kind.padEnd(18)} ${artifact.path.split('/').pop()}`);
        if (result.strategy) out.log(`Strategy: ${result.strategy.strategy} - ${result.strategy.reason}`);
        for (const ask of result.needsInput ?? []) out.log(`NEEDS YOUR INPUT: the listing asks for "${ask}". Add what is true to job-hunt/facts.md, then rerun with --force. Nothing will be sent until then.`);
        return 0;
      }
      case 'send': {
        const { positional } = parseFlags(rest);
        const job = store.getJob(positional[0]);
        if (!job) { out.log(`Unknown job ${positional[0] ?? ''}`); return 1; }
        const preferences = loadPreferences(vaultDir);
        const resume = loadResume(vaultDir);
        // Proposing is an action on the owner's behalf, so it goes through the agent's gate like any other:
        // policy decides whether it needs approval, and the approval is made in the U2OS UI.
        const result = await (sendOverride ?? withGate)(async (propose) => proposeApplicationEmail({
          store, job, candidateEmail: resume.basics.email, minimumScore: preferences.minimum_score, propose, force: parseFlags(rest).flags.force === true, now,
        }));
        out.log(`${job.company} - ${job.role ?? ''}: ${result.outcome.status === 'pending' ? 'waiting for your approval in U2OS (Approvals), action ' + result.outcome.id : result.outcome.status}`);
        out.log(`To: ${result.email.to}\nSubject: ${result.email.subject}\nAttachments: ${result.email.attachments.map((ref) => ref.split('/').pop()).join(', ')}`);
        return result.outcome.status === 'failed' || result.outcome.status === 'blocked' ? 1 : 0;
      }
      case 'plan': {
        const { flags, positional } = parseFlags(rest, ['url']);
        const job = store.getJob(positional[0]);
        if (!job) { out.log(`Unknown job ${positional[0] ?? ''}`); return 1; }
        const resume = loadResume(vaultDir);
        const preferences = loadPreferences(vaultDir);
        const candidate = { resume, preferences, answers: loadAnswers(vaultDir), facts: loadFacts(vaultDir), repos: loadRepos(vaultDir)?.repos ?? [], digest: candidateDigest(resume, preferences) };
        const application = await planApplication({ store, job, candidate, llm: llmOverride ?? createJobLlm(), url: flags.url ?? null, now });
        const { plan } = application;
        out.log(`${job.company} - ${job.role ?? ''}: plan ${application.status}  (${plan.fields.length} fields, ${plan.unresolved.length} unresolved)  ${application.url}`);
        for (const field of plan.fields) out.log(`  ${field.origin.padEnd(12)} ${String(field.label).slice(0, 48).padEnd(48)} ${field.file ? `[${field.file} file]` : String(field.value).replace(/\s+/g, ' ').slice(0, 60)}`);
        for (const entry of plan.unresolved) out.log(`  ${entry.required ? 'NEEDS' : 'optional'}      ${String(entry.label).slice(0, 48).padEnd(48)} ${entry.reason}`);
        for (const blocker of plan.blockers) out.log(`  BLOCKED: ${blocker}`);
        return application.status === 'planned' ? 0 : 1;
      }
      case 'submit': {
        const { flags, positional } = parseFlags(rest);
        const job = store.getJob(positional[0]);
        if (!job) { out.log(`Unknown job ${positional[0] ?? ''}`); return 1; }
        const artifacts = store.getArtifacts(job.id);
        const files = { ...(artifacts.resume_pdf ? { resume: { path: artifacts.resume_pdf.path } } : {}), ...(artifacts.cover_letter_pdf ? { cover_letter: { path: artifacts.cover_letter_pdf.path } } : {}) };
        const { result, application } = await submitApplication({ store, job, files, submit: flags['dry-run'] !== true, screenshotDir: path.join(vaultDir, 'job-hunt', 'state', 'screens', job.id), now });
        out.log(`${job.company}: ${result.status}${result.reason ? ` (${result.reason})` : ''}${result.errors ? `: ${result.errors.join('; ')}` : ''}${result.missing?.length ? ` missing: ${result.missing.join(', ')}` : ''}`);
        for (const file of result.screenshots ?? []) out.log(`  screenshot: ${file}`);
        return ['submitted', 'dry_run'].includes(result.status) ? 0 : 1;
      }
      case 'review': {
        const { flags, positional } = parseFlags(rest);
        const job = store.getJob(positional[0]);
        if (!job) { out.log(`Unknown job ${positional[0] ?? ''}`); return 1; }
        const resume = loadResume(vaultDir);
        const preferences = loadPreferences(vaultDir);
        const candidate = { resume, preferences, answers: loadAnswers(vaultDir), facts: loadFacts(vaultDir), repos: loadRepos(vaultDir)?.repos ?? [], digest: candidateDigest(resume, preferences) };
        const kind = flags.form === true ? 'form' : 'email';
        const result = await reviewJob({ store, job, kind, candidate, preferences, config: loadAutopilotConfig(vaultDir), llm: llmOverride ?? createJobLlm(), now, verifyAttachments: (refs) => resolveAttachments(vaultDir, refs) });
        out.log(`${job.company} - ${job.role ?? ''} [${kind}]: ${result.decision.toUpperCase()}${result.model ? ` (${result.model})` : ''}`);
        for (const entry of result.checks) if (!entry.pass || entry.informational) out.log(`  ${entry.pass ? 'note ' : 'FAIL '} ${entry.name}${entry.detail ? `: ${entry.detail}` : ''}`);
        for (const concern of result.concerns) out.log(`  ${concern.severity === 'blocking' ? 'BLOCKING' : 'minor   '} ${concern.text}`);
        if (result.notes) out.log(`  ${result.notes}`);
        return result.decision === 'approve' ? 0 : 1;
      }
      case 'mark': {
        const { flags, positional } = parseFlags(rest, ['to']);
        const job = store.getJob(positional[0]);
        if (!job) { out.log(`Unknown job ${positional[0] ?? ''}`); return 1; }
        if (positional[1] !== 'sent') { out.log('Usage: job mark <job-id> sent [--to <address>]'); return 1; }
        const email = recordManualSend({ store, job, candidateEmail: loadResume(vaultDir).basics.email, to: flags.to, now });
        out.log(`${job.company}: recorded as emailed to ${email.to}; follow-up after ${email.detail.followUpAfter}`);
        return 0;
      }
      case 'refilter': {
        const { flags } = parseFlags(rest);
        const result = refilterStored({ store, preferences: loadPreferences(vaultDir), dryRun: flags['dry-run'] === true, now });
        out.log(`${result.examined} unscored board/aggregator jobs examined; ${result.changed} ${flags['dry-run'] ? 'would be' : ''} skipped${Object.keys(result.skipped).length ? ` [${Object.entries(result.skipped).map(([reason, n]) => `${n} ${reason}`).join('; ')}]` : ''}.`);
        return 0;
      }
      case 'reparse': {
        let changed = 0;
        for (const job of store.listJobs({ limit: 5000 })) {
          const text = store.listSources(job.id).filter((source) => CONTACT_SOURCES.has(source.source)).map((source) => source.rawText).join('\n');
          const emails = extractEmails(text);
          if (JSON.stringify(emails) !== JSON.stringify(job.contactEmails)) { store.setContactEmails(job.id, emails, now); changed += 1; out.log(`${job.company}: ${job.contactEmails.join(', ') || '-'} -> ${emails.join(', ') || '-'}`); }
        }
        out.log(`${changed} job(s) updated.`);
        return 0;
      }
      case 'reconcile': {
        const changes = await (reconcileOverride ?? withLookup)((lookup) => reconcileEmails({ store, lookup, now }));
        for (const change of changes) out.log(`${change.email.to}: ${change.to}`);
        if (!changes.length) out.log('Nothing changed.');
        return 0;
      }
      case 'list': {
        const { flags } = parseFlags(rest, ['min-score', 'limit']);
        const entries = store.listScored({ minScore: flags['min-score'] ? Number(flags['min-score']) : null, limit: flags.limit ? Number.parseInt(flags.limit, 10) : 50 });
        if (flags.json) { out.log(JSON.stringify(entries)); return 0; }
        for (const { job, score } of entries) out.log(`${job.id}  ${String(score.score).padStart(3)} ${score.label.padEnd(11)} ${job.company} - ${job.role ?? '(no role)'}  [${score.recommendedNarrative}]`);
        if (!entries.length) out.log('No scored jobs. Run: npm run u2 -- job score');
        return 0;
      }
      case 'show': {
        const job = store.getJob(rest[0]);
        if (!job) { out.log(`Unknown job ${rest[0] ?? ''}`); return 1; }
        const score = store.getScore(job.id);
        out.log(`${job.company} - ${job.role ?? '(no role)'}  [${job.status}]`);
        out.log(`Locations: ${job.locations.join('; ') || '-'}  Remote: ${job.remote ?? 'unknown'}  Salary: ${job.salary?.raw ?? '-'}`);
        out.log(`Contacts: ${job.contactEmails.join(', ') || '-'}  Apply: ${job.applicationUrls.join(' ') || '-'}`);
        if (score) {
          out.log(`Score ${score.score} (${score.label}, confidence ${score.confidence})${score.degraded ? ' DEGRADED: scored by rules' : ''}  Narrative: ${score.recommendedNarrative}`);
          for (const [key, dim] of Object.entries(score.dimensions)) out.log(`  ${key.padEnd(13)} ${dim.points}/${dim.max}  ${dim.reason}`);
          for (const concern of score.concerns) out.log(`  concern: ${concern}`);
          for (const project of score.projects) out.log(`  project: ${project.name} - ${project.why}`);
        }
        return 0;
      }
      case 'status': {
        const { flags } = parseFlags(rest);
        const counts = store.counts();
        if (flags.json) out.log(JSON.stringify({ counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }));
        else {
          const entries = Object.entries(counts);
          out.log(entries.length ? entries.map(([status, n]) => `${status.padEnd(20)} ${n}`).join('\n') : 'No jobs yet. Run: npm run u2 -- job discover hn');
        }
        return 0;
      }
      default:
        out.log(USAGE);
        return 1;
    }
  } finally {
    store.close();
  }
}

// Runs `operation(propose)` with a real agent gate in an offline U2OS home (the server must be stopped:
// the home is single-owner). Pending approvals persist in the database for the UI to show on restart.
async function withGate(operation) {
  const [{ getDb }, { EventBus }, { PolicyEngine }, { createToolRegistry }, { Agent }, { newId }] = await Promise.all([
    import('../db/connection.js'), import('../events/event-bus.js'), import('../policy/policy-engine.js'),
    import('../tools/register-all.js'), import('../agent/agent.js'), import('../db/ids.js'),
  ]);
  let result;
  await withOfflineHome(async () => {
    const eventBus = new EventBus(getDb());
    const agent = new Agent({ policyEngine: new PolicyEngine(), toolRegistry: createToolRegistry(), eventBus });
    result = await operation((proposal) => agent.evaluateAndMaybeExecute({
      tool: proposal.tool, arguments: proposal.arguments, requestedBy: 'owner-cli', requestText: proposal.requestText,
      reasoningSummary: proposal.reasoning, correlationId: newId('corr'), actor: { type: 'user', id: 'owner' },
    }));
  });
  return result;
}

async function withLookup(operation) {
  const [{ getAgentAction }] = await Promise.all([import('../policy/policy-engine.js')]);
  let result;
  await withOfflineHome(async () => { result = operation((id) => getAgentAction(id)); });
  return result;
}
