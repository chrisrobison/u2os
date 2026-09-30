// Stand-in for the real `codex` / `claude` executables. Copied to a temp dir
// under the name of the CLI it imitates; behaviour follows that name. It
// emits the same JSON line formats as the real tools and reports how it was
// invoked (argv, stdin, selected env vars) inside its final message so tests
// can assert on the translation. It never touches a network or credentials.
import path from 'node:path';

const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO || 'ok';
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => main());

const out = (value) => console.log(JSON.stringify(value));

function main() {
  if (args[0] === '--version') { console.log(name === 'codex' ? 'codex-cli 9.9.9' : '9.9.9 (Claude Code)'); return; }
  const report = JSON.stringify({ argv: args, stdin, cwd: process.cwd(), codexHome: process.env.CODEX_HOME || null, hasOpenAiKey: 'OPENAI_API_KEY' in process.env, hasAnthropicKey: 'ANTHROPIC_API_KEY' in process.env });
  if (name === 'codex') codex(report); else claude(report);
}

function codex(report) {
  out({ type: 'thread.started', thread_id: 'thread-1' });
  out({ type: 'turn.started' });
  out({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'npm test', exit_code: 0 } });
  out({ type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'a.js' }] } });
  if (scenario === 'turn-failed') { out({ type: 'turn.failed', error: { message: 'model exploded' } }); return; }
  if (scenario === 'exit2') { console.error('codex: fatal'); process.exit(2); }
  console.log('not json, shown raw');
  out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: report } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } });
}

function claude(report) {
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  out({ type: 'system', subtype: 'hook_started', session_id: 'sess-1' });
  out({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test\nsecond line' } }] } });
  out({ type: 'user', session_id: 'sess-1', message: { content: [{ type: 'tool_result', content: 'ignored' }] } });
  const base = { type: 'result', subtype: 'success', is_error: false, result: report, session_id: 'sess-1', total_cost_usd: 0.01, num_turns: 2, terminal_reason: 'completed', permission_denials: [] };
  if (scenario === 'denied') out({ ...base, permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Bash' }, { tool_name: 'Edit' }] });
  else if (scenario === 'error') out({ ...base, is_error: true, subtype: 'error_during_execution', result: 'login required' });
  else if (scenario === 'exit2') { console.error('claude: fatal'); process.exit(2); }
  else if (scenario === 'no-result') return;
  else out(base);
}
