// ModelProvider backed by an official AI command-line tool (claude, codex,
// grok, or an owner-supplied command) instead of an HTTP API.
//
// The CLI owns authentication: it signs in through its own stored login (an
// OAuth subscription, typically) and U2OS neither reads nor stores that state.
// The child process gets the same scrubbed environment as coding agents
// (server/coding-agent/env.js), so U2OS settings and API keys such as
// ANTHROPIC_API_KEY / OPENAI_API_KEY are NOT passed on, which would silently
// switch a subscription login to metered billing.
//
// The CLI is used as a text-in/text-out model only. Each preset starts it in
// an empty scratch directory with its tools switched off or read-only, and the
// prompt goes in on stdin or a file, never on the command line. Whatever it
// prints is parsed as a plan and validated exactly like an API provider's
// output (plan-validator.js) before anything reaches the policy engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelProvider } from './model-provider.js';
import { validatePlanWithRepair } from './plan-validator.js';
import { PLANNER_SYSTEM_PROMPT, buildPlanRequestPayload } from './prompt-payload.js';
import { runProcess } from '../coding-agent/runner.js';
import { buildChildEnv } from '../coding-agent/env.js';

const SYSTEM_PROMPT = `${PLANNER_SYSTEM_PROMPT} Respond with raw JSON only -- no prose, no markdown code fences.`;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const NOT_SIGNED_IN = /not (?:signed|logged) in|log ?in required|please (?:log ?in|sign ?in)|unauthenticated|not authenticated|invalid api key/i;

// Placeholders usable in a custom command's args: {promptFile} (a file holding
// the prompt), {cwd} (the empty scratch directory), {model}.
export const CLI_PRESETS = {
  claude: {
    label: 'Claude Code (claude)',
    executable: 'claude',
    envPassthrough: ['CLAUDE_CONFIG_DIR'],
    // -p reads the prompt from stdin. --tools "" removes every built-in tool; the
    // system prompt replaces Claude Code's coding prompt. No MCP servers, no
    // session files.
    build: ({ model, systemPrompt }) => ({
      args: ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--system-prompt', systemPrompt, ...(model ? ['--model', model] : [])],
      input: 'stdin',
    }),
    parse: (stdout) => { const event = tryJson(stdout); if (event?.is_error) throw new Error('Model provider reported an error'); return typeof event?.result === 'string' ? event.result : stdout; },
  },
  codex: {
    label: 'OpenAI Codex CLI (codex)',
    executable: 'codex',
    envPassthrough: ['CODEX_HOME'],
    // "-" reads the prompt from stdin. The read-only sandbox in an empty scratch
    // directory; -o writes only the final message to a file.
    build: ({ model, cwd, outputFile }) => ({
      args: ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', cwd, '-o', outputFile, ...(model ? ['-m', model] : []), '-'],
      input: 'stdin', outputFile, systemInPrompt: true,
    }),
    parse: (stdout, { outputText }) => outputText ?? stdout,
  },
  grok: {
    label: 'Grok (grok)',
    executable: 'grok',
    envPassthrough: [],
    build: ({ model, cwd, promptFile }) => ({
      args: ['--prompt-file', promptFile, '--output-format', 'plain', '--permission-mode', 'plan', '--cwd', cwd, '--no-subagents', '--disable-web-search', ...(model ? ['--model', model] : [])],
      input: 'file', systemInPrompt: true,
    }),
    parse: (stdout) => stdout,
  },
  custom: {
    label: 'Custom command',
    executable: null,
    envPassthrough: [],
    build: ({ model, cwd, promptFile, args = [], input = 'stdin' }) => ({
      args: args.map((arg) => String(arg).replaceAll('{promptFile}', promptFile).replaceAll('{cwd}', cwd).replaceAll('{model}', model || '')),
      input: input === 'file' ? 'file' : 'stdin', systemInPrompt: true,
    }),
    parse: (stdout) => stdout,
  },
};

export class CliModelProvider extends ModelProvider {
  constructor({ preset = 'custom', executable, args, input, model = null, timeoutMs = 120_000, destination = null, envPassthrough = [], runProcessImpl = runProcess, source = process.env } = {}) {
    super();
    const spec = CLI_PRESETS[preset];
    if (!spec) throw new Error(`Unknown CLI model preset: ${preset}`);
    this.preset = preset;
    this.spec = spec;
    this.executable = executable || spec.executable;
    if (!this.executable) throw new Error('CLI model provider requires an executable');
    this.customArgs = args; this.customInput = input;
    this.model = model || null;
    this.timeoutMs = timeoutMs;
    this.envPassthrough = [...spec.envPassthrough, ...envPassthrough];
    this.runProcessImpl = runProcessImpl;
    this.source = source;
    this.id = `cli:${preset}${model ? `:${model}` : ''}`;
    // The tool talks to a hosted service unless the owner says otherwise.
    this.destination = destination === 'local_model' ? 'local_model' : 'configured_remote_model';
  }

  async plan(context, objective) {
    const text = await this._run(SYSTEM_PROMPT, JSON.stringify(buildPlanRequestPayload(context, objective)));
    let parsed;
    try { parsed = JSON.parse(extractJson(text)); } catch { throw new Error('Model provider returned invalid JSON'); }
    return validatePlanWithRepair(parsed, context.toolRegistry);
  }

  /**
   * Plain text completion: system and user text in, answer text out. For
   * callers that need a model's judgement but not a tool plan (the job
   * hunter's scoring). Same scratch directory, scrubbed environment, timeout
   * and output cap as plan().
   */
  async complete(systemPrompt, userContent) {
    return this._run(`${systemPrompt} Respond with raw JSON only -- no prose, no markdown code fences.`, userContent);
  }

  /** Sends a tiny prompt (one short round trip) to prove the tool is signed in and answering. */
  async ping() {
    const text = await this._run('Reply with exactly the single word: ok', 'ping');
    return { reply: text.trim().slice(0, 40) };
  }

  // One tool invocation: prompt in, answer text out, in a throwaway empty directory.
  async _run(systemPrompt, userContent) {
    const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'u2os-cli-model-'));
    try {
      const promptFile = path.join(scratch, 'prompt.txt');
      const outputFile = path.join(scratch, 'answer.txt');
      const plan = this.spec.build({ model: this.model, cwd: scratch, promptFile, outputFile, systemPrompt, args: this.customArgs, input: this.customInput });
      const prompt = plan.systemInPrompt ? `${systemPrompt}\n\nREQUEST:\n${userContent}\n` : userContent;
      if (plan.input === 'file') await fs.promises.writeFile(promptFile, prompt, { mode: 0o600 });
      const result = await this.runProcessImpl({
        executable: this.executable, args: plan.args, cwd: scratch,
        env: buildChildEnv({ passthrough: this.envPassthrough, source: this.source }),
        stdin: plan.input === 'stdin' ? prompt : null,
        timeoutMs: this.timeoutMs, maxCaptureBytes: MAX_OUTPUT_BYTES,
      });
      if (result.spawnError) {
        const error = new Error(`Model provider could not start (${result.spawnError.code || 'spawn error'})`);
        error.code = result.spawnError.code;
        throw error;
      }
      if (result.timedOut) throw new Error('Model provider timed out');
      if (result.exitCode !== 0) {
        // Only the fact is reported, never the tool's own text.
        if (NOT_SIGNED_IN.test(`${result.stderr || ''}\n${result.stdout || ''}`)) throw new Error('Model provider is not signed in');
        throw new Error(`Model provider command failed (exit ${result.exitCode ?? result.signal})`);
      }
      let outputText;
      if (plan.outputFile) { try { outputText = await fs.promises.readFile(plan.outputFile, 'utf8'); } catch { outputText = undefined; } }
      const text = this.spec.parse(result.stdout, { outputText });
      if (typeof text !== 'string' || !text.trim()) throw new Error('Model provider returned no plan content');
      return text;
    } finally {
      await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Does `<executable> --version` run? Says nothing about being signed in. */
  async probe() {
    const result = await this.runProcessImpl({
      executable: this.executable, args: ['--version'], cwd: os.tmpdir(),
      env: buildChildEnv({ passthrough: this.envPassthrough, source: this.source }),
      timeoutMs: PROBE_TIMEOUT_MS, maxCaptureBytes: 8 * 1024,
    });
    if (result.spawnError) return { available: false, reason: result.spawnError.code === 'ENOENT' ? `${this.executable} was not found (is it installed and on PATH?)` : `${this.executable} could not be started` };
    if (result.timedOut) return { available: false, reason: `${this.executable} --version did not respond` };
    if (result.exitCode !== 0) return { available: false, reason: `${this.executable} --version exited with ${result.exitCode ?? result.signal}` };
    const version = String(result.stdout || result.stderr).split('\n').map((l) => l.trim()).find(Boolean);
    return { available: true, ...(version ? { version: version.slice(0, 120) } : {}) };
  }
}

function tryJson(text) { try { return JSON.parse(text); } catch { return null; } }

// A CLI may wrap the JSON in a code fence or add a sentence around it. Strip one
// fence, else take the outermost braces; never evaluate or repair anything.
function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1];
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}
