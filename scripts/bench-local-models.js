#!/usr/bin/env node
// Compare local LM Studio models with the cloud scores already stored for your jobs (#596).
//   node scripts/bench-local-models.js --models qwen/qwen3.5-9b,qwen/qwen3.8-27b --n 20 [--reasoning on|off|low|medium|high] [--vault ~/.u2]
// Read-only: scores are computed and compared, never saved. The key comes from the encrypted vault (job-hunt-lmstudio).
import os from 'node:os';
import path from 'node:path';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { loadCandidate } from '../mcp/jobs/hunt/candidate/load.js';
import { scoreJob } from '../mcp/jobs/hunt/jobs/scorer.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { LMSTUDIO_SECRET } from '../mcp/jobs/hunt/llm/models.js';
import { LmStudioProvider } from '../server/agent/lmstudio-provider.js';
import { readEncryptedFile } from '../server/security/vault.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const home = (p) => p.replace(/^~/, os.homedir());
const vaultDir = home(arg('vault', '~/.u2'));
const dataDir = home(arg('data', '~/.u2os'));
const baseUrl = arg('base-url', 'http://127.0.0.1:1234');
const models = arg('models', 'qwen/qwen3.5-9b').split(',').map((m) => m.trim()).filter(Boolean);
const n = Math.min(Math.max(Number(arg('n', 20)) || 20, 1), 200);
const reasoning = ['on', 'low', 'medium', 'high'].includes(arg('reasoning', 'off')) ? arg('reasoning', 'off') : 'off';
const timeoutMs = (Number(arg('timeout', 300)) || 300) * 1000;

export function stats(pairs) {
  const k = pairs.length;
  if (!k) return { n: 0 };
  const mx = pairs.reduce((s, [a]) => s + a, 0) / k; const my = pairs.reduce((s, [, b]) => s + b, 0) / k;
  let sxy = 0; let sxx = 0; let syy = 0; let abs = 0;
  for (const [a, b] of pairs) { sxy += (a - mx) * (b - my); sxx += (a - mx) ** 2; syy += (b - my) ** 2; abs += Math.abs(a - b); }
  return { n: k, correlation: sxx && syy ? +(sxy / Math.sqrt(sxx * syy)).toFixed(2) : null, bias: +(mx - my).toFixed(1), mae: +(abs / k).toFixed(1) };
}

async function main() {
  const store = openStore(huntDbPath(vaultDir));
  const candidate = loadCandidate(vaultDir);
  let apiKey = null; try { apiKey = readEncryptedFile(LMSTUDIO_SECRET, dataDir)?.apiKey ?? null; } catch (e) { console.warn(`could not read ${LMSTUDIO_SECRET} from ${dataDir}: ${String(e.message).slice(0, 120)}`); }
  if (!apiKey) console.warn('no LM Studio API key found; requests are sent unauthenticated');
  const reference = store.listJobs({ limit: 5000 }).map((job) => ({ job, score: store.getScore(job.id) }))
    .filter(({ score }) => score && !score.degraded && !String(score.model ?? '').startsWith('lmstudio:')).slice(0, n);
  if (!reference.length) throw new Error('no jobs with a cloud score to compare against');
  console.log(`Comparing ${models.length} model(s) on ${reference.length} jobs scored by ${[...new Set(reference.map((r) => r.score.model))].join(', ')} (reasoning ${reasoning})\n`);
  for (const model of models) {
    const provider = new LmStudioProvider({ baseUrl, model, apiKey, reasoning, timeoutMs });
    const llm = createLlm([{ id: provider.id, complete: (s, u) => provider.complete(s, u) }]);
    const pairs = []; const times = []; let failed = 0; let firstError = null;
    for (const { job, score } of reference) {
      const t = Date.now();
      try {
        const result = await scoreJob({ job, source: store.listSources(job.id)[0] ?? null, candidate, llm });
        if (result.degraded) { failed += 1; firstError ??= `degraded: ${(result.concerns ?? []).find((c) => /^Model unavailable/.test(c)) ?? 'rule-based fallback (no model reason)'}`; continue; }
        pairs.push([result.score, score.score]); times.push(Date.now() - t);
      } catch (e) { failed += 1; firstError ??= String(e.message).slice(0, 200); }
    }
    const s = stats(pairs);
    const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length / 1000) : null;
    console.log(`${model.padEnd(48)} n=${s.n} failed=${failed} corr=${s.correlation} bias=${s.bias} mae=${s.mae} avg=${avg}s/job`);
    if (firstError) console.log(`  first failure: ${firstError}`);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String(e.message).slice(0, 300)); process.exit(1); });
