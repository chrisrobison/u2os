// OpenAI Codex CLI adapter (docs/coding-agents.md).
//
// U2OS launches `codex exec` and nothing else. Sign-in (ChatGPT subscription
// or otherwise) belongs to Codex: it finds its own state under CODEX_HOME /
// ~/.codex, and U2OS neither reads it nor needs OPENAI_API_KEY.
import { CliCodingAgentProvider } from '../cli-provider.js';
import { permissionPreamble } from '../preamble.js';

const ID = 'codex';
const SANDBOX = { none: 'read-only', read: 'read-only', project: 'workspace-write', unrestricted: 'danger-full-access' };

export class CodexProvider extends CliCodingAgentProvider {
  get id() { return ID; }
  get name() { return 'OpenAI Codex CLI'; }
  get defaultExecutable() { return 'codex'; }
  get envPassthrough() { return ['CODEX_HOME']; }

  async capabilities() {
    return {
      filesystem: ['none', 'read', 'project', 'unrestricted'],
      shell: false, network: true, git: false, streaming: true, resume: false, cancel: true,
      enforcement: {
        filesystem: 'enforced by the Codex sandbox (read-only / workspace-write / danger-full-access); "none" is treated as read-only',
        network: 'enforced for workspace-write via sandbox_workspace_write.network_access; read-only sandbox has no network',
        shell: 'NOT enforced: Codex can run sandboxed commands; the restriction is stated in the prompt only',
        git: 'NOT enforced separately from the shell; stated in the prompt only',
      },
    };
  }

  buildInvocation(task, { model }) {
    const { permissions } = task;
    const sandbox = SANDBOX[permissions.filesystem];
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', task.cwd, '-s', sandbox];
    if (sandbox === 'workspace-write') args.push('-c', `sandbox_workspace_write.network_access=${permissions.network}`);
    if (model) args.push('-m', model);
    // "-" makes Codex read the instructions from stdin, so the task text is
    // never an argument (and cannot be mistaken for an option).
    args.push('-');
    return { args, stdin: permissionPreamble(permissions) + task.task };
  }

  parseLine(stream, line, state) {
    if (stream !== 'stdout') return line;
    let event;
    try { event = JSON.parse(line); } catch { return line; }
    if (!event || typeof event !== 'object') return line;
    switch (event.type) {
      case 'thread.started': state.threadId = event.thread_id; return null;
      case 'turn.completed': state.usage = event.usage; return null;
      case 'turn.started': return null;
      case 'turn.failed': case 'error': {
        const message = event.error?.message || event.message || 'Codex reported an error';
        (state.errors ||= []).push(message);
        return `error: ${message}`;
      }
      case 'item.completed': return this.describeItem(event.item, state);
      default: return null;
    }
  }

  describeItem(item, state) {
    if (!item) return null;
    if (item.type === 'agent_message' && typeof item.text === 'string') { state.lastMessage = item.text; return item.text; }
    if (item.type === 'command_execution') return `$ ${item.command}${item.exit_code ? ` (exit ${item.exit_code})` : ''}`;
    if (item.type === 'file_change') return `changed: ${(item.changes || []).map((change) => change.path).join(', ')}`;
    return null;
  }

  finalize({ state, result }) {
    const metadata = { threadId: state.threadId, usage: state.usage };
    if (state.errors?.length && result.exitCode === 0) return { status: 'failed', error: state.errors.at(-1), summary: state.lastMessage, metadata };
    return { summary: state.lastMessage, error: state.errors?.at(-1), metadata };
  }
}

