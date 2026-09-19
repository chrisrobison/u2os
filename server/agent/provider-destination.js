// Classifies a ModelProvider's network destination for the data-processing
// privacy policy (server/policy/data-processing-policy.js): 'local_model'
// (never leaves the machine/LAN) vs 'configured_remote_model' (a hosted
// third-party or cloud endpoint). This is a separate question from tool
// authorization, and separate from whether the provider itself is "the
// OpenAI-compatible one" or "the Anthropic one" -- an Ollama server and a
// hosted OpenAI-compatible API use the exact same provider code but have
// very different privacy implications.
//
// SECURITY: this classification is derived from the provider's OWN
// configured baseUrl (owner-provided server config), never from model
// output or request arguments -- same "authoritative context only" rule
// policy-engine.js and data-processing-policy.js both already follow.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export function classifyProviderDestination(baseUrl, explicitOverride) {
  if (explicitOverride) return explicitOverride;
  if (!baseUrl) return 'configured_remote_model';
  try {
    const { hostname } = new URL(baseUrl);
    if (LOCAL_HOSTNAMES.has(hostname) || isPrivateIPv4(hostname)) return 'local_model';
    return 'configured_remote_model';
  } catch {
    return 'configured_remote_model';
  }
}

function isPrivateIPv4(hostname) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
