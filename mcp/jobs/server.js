#!/usr/bin/env node
// U2OS job-hunt MCP server (docs/job-hunt.md). Declared in the owner's vault
// mcp.yaml; every call reaches it through U2OS's action gate.
//
//   node mcp/jobs/server.js --vault /path/to/vault

import path from 'node:path';
import { serveStdio } from '../lib/stdio-server.js';
import { endpoints, fetchBoard, fetchQuestions, matches, parseJobId } from './boards.js';
import { loadProfile } from './profile.js';
import { FINAL, listRecords, readRecord, writeRecord } from './ledger.js';
import { applyToJob } from './apply.js';

const vaultFlag = process.argv.indexOf('--vault');
const vaultDir = path.resolve(vaultFlag >= 0 ? process.argv[vaultFlag + 1] : process.cwd());
const BOARD = /^(greenhouse|lever):[A-Za-z0-9_.-]{1,80}$/;
const strings = (value, max = 20) => (Array.isArray(value) ? value : value ? [value] : []).slice(0, max).map((item) => String(item).slice(0, 100));

async function searchJobs(args) {
  const profile = loadProfile(vaultDir);
  const boards = strings(args.boards, 50);
  const bad = boards.find((board) => !BOARD.test(board));
  if (bad) throw new Error(`boards: "${bad}" must look like greenhouse:<board> or lever:<company>`);
  const sources = boards.length ? boards : profile.boards;
  if (!sources.length) throw new Error('No boards to search: list them under boards: in job-hunt/profile.md');
  const limit = Math.min(Math.max(Number.parseInt(args.limit ?? 10, 10) || 10, 1), 25);
  const criteria = { keywords: strings(args.keywords), locations: strings(args.locations), remote: args.remote === true };
  const urls = endpoints();
  const errors = [];
  const postings = (await Promise.all(sources.map((board) => fetchBoard(board, { urls }).catch((error) => { errors.push({ board, error: error.message }); return []; })))).flat();
  const found = [];
  for (const posting of postings.filter((item) => matches(item, criteria)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))) {
    const record = readRecord(vaultDir, posting.job_id);
    if (record && FINAL.has(record.status) && args.include_recorded !== true) continue;
    found.push({ ...posting, application_status: record?.status || null, ...(record?.status === 'needs_answers' ? { open_questions: record.open_questions } : {}) });
    if (found.length >= limit) break;
  }
  await Promise.all(found.map(async (posting) => {
    posting.questions = await fetchQuestions(posting.job_id, { urls }).catch(() => null);
  }));
  return { searched: sources, total_open: postings.length, results: found, ...(errors.length ? { errors } : {}) };
}

function listApplications(args) {
  const status = typeof args.status === 'string' ? args.status : null;
  const records = listRecords(vaultDir).filter((record) => !status || record.status === status)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 50);
  return { applications: records.map(({ job_id, company, title, status: recordStatus, applied_at, updated_at, url }) => ({ job_id, company, title, status: recordStatus, applied_at: applied_at || null, updated_at, url })) };
}

function skipJob(args) {
  parseJobId(args.job_id);
  const record = readRecord(vaultDir, args.job_id);
  if (record && FINAL.has(record.status)) return { job_id: args.job_id, status: record.status, message: 'Already recorded; unchanged.' };
  writeRecord(vaultDir, { job_id: args.job_id, status: 'skipped', reason: String(args.reason || '').slice(0, 300) || null });
  return { job_id: args.job_id, status: 'skipped' };
}

serveStdio({
  name: 'u2os-jobs',
  tools: {
    search_jobs: {
      description: 'Search open jobs on the Greenhouse and Lever boards listed in the owner\'s job-hunt profile (or the boards given). Matches job titles against keywords and locations. Jobs already applied to, skipped or awaiting the owner are left out. Greenhouse results include the application questions.',
      inputSchema: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: 'Words any of which must appear in the job title, e.g. ["engineer", "developer"]' },
          locations: { type: 'array', items: { type: 'string' }, description: 'Location fragments, e.g. ["Portland", "Seattle"]' },
          remote: { type: 'boolean', description: 'Also include remote jobs when locations are given' },
          boards: { type: 'array', items: { type: 'string' }, description: 'Override the profile boards, e.g. ["greenhouse:acme", "lever:globex"]' },
          limit: { type: 'integer', description: 'Maximum results, 1-25 (default 10)' },
          include_recorded: { type: 'boolean', description: 'Include jobs already applied to or skipped' },
        },
      },
      handler: searchJobs,
    },
    list_applications: {
      description: 'List the job applications recorded in the owner\'s vault ledger, newest first.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'applied, unconfirmed, needs_answers, needs_owner, dry_run, failed or skipped' } } },
      handler: listApplications,
    },
    apply: {
      description: 'Apply to one job from search_jobs on the board\'s own form, in the owner\'s name. The owner\'s identity and resume are filled in automatically; provide answers to the application questions keyed by question name, and optionally a cover letter. Returns needs_answers with the open questions if required ones are unanswered. Never applies twice to the same job.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'job_id from search_jobs, e.g. greenhouse:acme:12345' },
          answers: { type: 'object', description: 'Answers keyed by question name (e.g. {"question_123": "Yes"}); use option labels for choices' },
          cover_letter: { type: 'string', description: 'Optional cover letter text tailored to this job' },
        },
        required: ['job_id'],
      },
      handler: (args) => applyToJob({ vaultDir, jobId: args.job_id, answers: args.answers && typeof args.answers === 'object' && !Array.isArray(args.answers) ? args.answers : {}, coverLetter: typeof args.cover_letter === 'string' ? args.cover_letter : null }),
    },
    skip_job: {
      description: 'Record that the owner is not interested in a job, so searches stop returning it.',
      inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, reason: { type: 'string' } }, required: ['job_id'] },
      handler: skipJob,
    },
  },
});
