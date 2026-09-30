// Anthropic Claude Code adapter (docs/coding-agents.md).
//
// U2OS launches `claude -p` (print / non-interactive mode) and nothing else.
// Sign-in (Claude Pro/Max subscription or otherwise) belongs to Claude Code:
// it uses its own stored login, and U2OS neither reads it nor needs
// ANTHROPIC_API_KEY. (The child environment deliberately omits that variable,
// which would otherwise switch Claude Code to metered API billing.)
import { CliCodingAgentProvider } from '../cli-provider.js';
import { permissionPreamble } from '../preamble.js';

const ID = 'claude-code';
const MAX_DETAIL = 200;

export class ClaudeCodeProvider extends CliCodingAgentProvider {
  get id() { return ID; }
  get name() { return 'Claude Code'; }
  get defaultExecutable() { return 'claude'; }
  get envPassthrough() { return ['CLAUDE_CONFIG_DIR']; }

  async capabilities() {
    return {
      filesystem: ['none', 'read', 'project'],
      shell: true, network: true, git: true, streaming: true, resume: false, cancel: true,
      enforcement: {
        filesystem: 'read/none: plan permission mode (no edits); project: acceptEdits, which Claude Code confines to the working directory; "none" also denies the read tools; "unrestricted" is treated as project',
        shell: 'enforced by denying or allowing the Bash tool',
        git: 'enforced by denying Bash(git *); commands run through other tools are not covered',
        network: 'enforced for WebFetch/WebSearch only; network use from inside Bash is NOT enforced (prompt only)',
      },
    };
  }

  buildInvocation(task, { model }) {
    const { permissions } = task;
    const writes = permissions.filesystem === 'project' || permissions.filesystem === 'unrestricted';
    const allow = [];
    const deny = [];
    if (permissions.filesystem === 'none') deny.push('Read', 'Glob', 'Grep', 'LS', 'Edit', 'Write', 'NotebookEdit');
    if (!permissions.shell) deny.push('Bash');
    else {
      // Non-interactive mode cannot ask, so a shell the owner allowed must be pre-approved.
      if (writes) allow.push('Bash');
      if (!permissions.git) deny.push('Bash(git *)');
    }
    if (permissions.network) { if (writes) allow.push('WebFetch', 'WebSearch'); } else deny.push('WebFetch', 'WebSearch');

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', writes ? 'acceptEdits' : 'plan'];
    if (allow.length) args.push('--allowedTools', allow.join(','));
    if (deny.length) args.push('--disallowedTools', deny.join(','));
    if (model) args.push('--model', model);
    // No prompt argument: with -p, Claude Code reads the task from stdin, so
    // the text is never an option or a shell word.
    return { args, stdin: permissionPreamble(permissions) + task.task };
  }

  parseLine(stream, line, state) {
    if (stream !== 'stdout') return line;
    let event;
    try { event = JSON.parse(line); } catch { return line; }
    if (!event || typeof event !== 'object') return line;
    if (event.session_id) state.sessionId = event.session_id;
    if (event.type === 'result') { state.result = event; return null; }
    if (event.type !== 'assistant') return null; // system/hook/user events are bookkeeping
    const shown = [];
    for (const block of event.message?.content || []) {
      if (block.type === 'text' && block.text) shown.push(block.text);
      else if (block.type === 'tool_use') shown.push(`→ ${block.name}${detail(block.input)}`);
    }
    return shown.length ? shown.join('\n') : null;
  }

  finalize({ state }) {
    const result = state.result;
    if (!result) return { error: 'Claude Code ended without a result', status: 'failed', metadata: { sessionId: state.sessionId } };
    const denied = [...new Set((result.permission_denials || []).map((denial) => denial.tool_name).filter(Boolean))];
    const metadata = { sessionId: state.sessionId || result.session_id, costUsd: result.total_cost_usd, turns: result.num_turns, terminalReason: result.terminal_reason, permissionDenials: denied.length ? denied : undefined };
    const summary = typeof result.result === 'string' ? result.result : undefined;
    if (result.is_error) return { status: 'failed', error: summary || 'Claude Code reported an error', summary, metadata };
    // The agent wanted a tool the permissions did not allow and could not ask.
    if (denied.length) return { status: 'needs_input', error: `Permission needed for: ${denied.join(', ')}`, summary, metadata };
    return { summary, metadata };
  }
}

function detail(input) {
  const value = input?.command ?? input?.file_path ?? input?.pattern ?? input?.path ?? input?.url ?? null;
  return typeof value === 'string' ? `: ${value.split('\n')[0].slice(0, MAX_DETAIL)}` : '';
}
