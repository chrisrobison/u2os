// Environment policy for coding agent child processes (docs/coding-agents.md).
//
// The child does NOT inherit U2OS's environment. It gets an allow-list of
// what a developer tool legitimately needs (PATH, HOME, locale, proxy and
// certificate settings) plus the variables each official CLI documents for
// finding its own configuration. Everything else is dropped: U2OS_*
// settings, other tools' tokens, and in particular OPENAI_API_KEY /
// ANTHROPIC_API_KEY, which would silently switch a subscription-backed CLI
// to metered API billing. Sign-in state lives in the CLI's own files (under
// HOME or its config-dir variable) and is found, never read, by U2OS.
import { CodingAgentError } from './types.js';

const ALLOWED = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TMPDIR', 'TZ',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PROGRAMFILES',
]);
const ALLOWED_PREFIXES = ['LC_'];

// A caller may add variables for one run, but not ones that change what
// gets executed or escape this policy.
const FORBIDDEN_OVERRIDES = new Set(['PATH', 'HOME', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'SHELL', 'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'PERL5OPT']);
const FORBIDDEN_PREFIXES = ['U2OS_', 'LD_', 'DYLD_'];

/**
 * buildChildEnv({ passthrough, extra, source }) -> env object for spawn().
 *   passthrough: extra names the provider's CLI needs (e.g. CODEX_HOME)
 *   extra: the task's own `environment`, validated here
 *   source: the environment to filter (defaults to process.env)
 */
export function buildChildEnv({ passthrough = [], extra = {}, source = process.env } = {}) {
  const env = {};
  const allowed = new Set([...ALLOWED, ...passthrough]);
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allowed.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (FORBIDDEN_OVERRIDES.has(name) || FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new CodingAgentError(`environment.${name} may not be set for a coding agent run`, 'invalid_task');
    }
    env[name] = value;
  }
  return env;
}
