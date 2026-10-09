import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { JOB_HUNT_DIR } from '../../profile.js';

// job-hunt/models.yaml: which model does which job-hunt work. No secrets here
// (the LM Studio key lives in U2OS's encrypted vault).
//
//   fast:                          # the local first pass: scores everything, free
//     provider: lmstudio
//     base_url: http://127.0.0.1:1234
//     model: qwen/qwen3.5-9b
//     reasoning: off               # answer directly (fast); "on" lets it think first
//   local_bias: 12                 # how many points higher the local model tends to score than the quality model
//   confirm_margin: 10             # a job whose fast score, minus that bias, is within this many points of
//                                  # your threshold is confirmed by the quality tier
//   quality: planner               # the model connections you ordered on the Model page
//
// Without a `fast` tier everything uses the quality tier, exactly as before.

export const modelsPath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'models.yaml');
export const LMSTUDIO_SECRET = 'job-hunt-lmstudio';

export function loadModelsConfig(vaultDir) {
  let data = {};
  try {
    const stat = fs.lstatSync(modelsPath(vaultDir));
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('models.yaml must be a regular file under 64 KiB');
    data = yaml.load(fs.readFileSync(modelsPath(vaultDir), 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('models.yaml must be a mapping');
  let fast = null;
  if (data.fast !== undefined && data.fast !== null) {
    const f = data.fast;
    if (typeof f !== 'object' || f.provider !== 'lmstudio') throw new Error('models.yaml: fast.provider must be lmstudio');
    if (typeof f.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,120}$/.test(f.model)) throw new Error('models.yaml: fast.model must be a model name');
    let origin;
    try { origin = new URL(f.base_url ?? 'http://127.0.0.1:1234'); } catch { throw new Error('models.yaml: fast.base_url must be a URL'); }
    if (!/^https?:$/.test(origin.protocol)) throw new Error('models.yaml: fast.base_url must be http(s)');
    if (f.reasoning !== undefined && !['on', 'off'].includes(String(f.reasoning))) throw new Error('models.yaml: fast.reasoning must be on or off');
    fast = { provider: 'lmstudio', base_url: origin.origin, model: f.model, reasoning: String(f.reasoning ?? 'off'), max_output_tokens: Number.isInteger(f.max_output_tokens) ? Math.min(Math.max(f.max_output_tokens, 64), 4096) : 2048, timeout_seconds: Number.isInteger(f.timeout_seconds) ? Math.min(Math.max(f.timeout_seconds, 10), 600) : 120 };
  }
  const margin = data.confirm_margin === undefined ? 10 : data.confirm_margin;
  if (!Number.isInteger(margin) || margin < 0 || margin > 40) throw new Error('models.yaml: confirm_margin must be a whole number from 0 to 40');
  const bias = data.local_bias === undefined ? 12 : data.local_bias;
  if (!Number.isInteger(bias) || bias < -20 || bias > 40) throw new Error('models.yaml: local_bias must be a whole number from -20 to 40');
  if (data.quality !== undefined && data.quality !== 'planner') throw new Error('models.yaml: quality must be "planner" (the connections on the Model page)');
  return { fast, quality: 'planner', confirm_margin: margin, local_bias: bias };
}

export function setFastModel(vaultDir, { base_url, model, reasoning = 'off' }) {
  let data = {};
  try { data = yaml.load(fs.readFileSync(modelsPath(vaultDir), 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {}; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  data.fast = { provider: 'lmstudio', base_url, model, reasoning };
  fs.mkdirSync(path.dirname(modelsPath(vaultDir)), { recursive: true });
  fs.writeFileSync(modelsPath(vaultDir), `# Which model does which job-hunt work (docs/job-hunt.md). No secrets: the key is in the encrypted vault.\n${yaml.dump(data, { lineWidth: 120 })}`, { mode: 0o600 });
  return loadModelsConfig(vaultDir);
}
