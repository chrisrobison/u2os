// Model access for the job hunter. The pipeline never talks to a vendor; it
// receives an `llm` object with one method:
//
//   llm.json({ system, user, validate }) -> validated object
//
// `validate` is the schema gate: whatever the model returns is parsed and
// validated before any code uses it, and one repair attempt is allowed. Job
// text is placed in the user message as data; the system message is ours.

export class ModelUnavailableError extends Error {
  constructor(message = 'No model is available') { super(message); this.code = 'MODEL_UNAVAILABLE'; }
}

export function extractJson(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1];
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/**
 * Wraps text completion functions (tried in order) into an `llm`. Each entry
 * is { id, complete(system, user) -> Promise<string> }. A failing or
 * invalid-output provider is skipped for the next one.
 */
export function createLlm(providers, { attempts = 2 } = {}) {
  return {
    available: providers.length > 0,
    providers: providers.map((provider) => provider.id),
    async json({ system, user, validate }) {
      if (!providers.length) throw new ModelUnavailableError();
      let lastError;
      for (const provider of providers) {
        let request = user;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            const text = await provider.complete(system, request);
            const value = validate(JSON.parse(extractJson(text)));
            return { value, model: provider.id };
          } catch (error) {
            lastError = error;
            // Retry once on bad output with the problem stated; a failed call moves on to the next provider.
            if (error instanceof SyntaxError || error.code === 'INVALID_OUTPUT') request = `${user}\n\nYour previous reply was rejected: ${String(error.message).slice(0, 300)}. Reply with only the corrected JSON object.`;
            else break;
          }
        }
      }
      throw new ModelUnavailableError(`No model produced a valid answer (${String(lastError?.message ?? 'unknown').slice(0, 200)})`);
    },
  };
}

export function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_OUTPUT';
  return error;
}
