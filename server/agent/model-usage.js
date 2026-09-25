const MAX_REPORTED_TOKENS = 10_000_000;

/** Missing usage is honest unknown. A present but malformed usage envelope
 * fails closed so a provider cannot silently bypass metering. */
export function parseReportedUsage(usage, inputField, outputField) {
  if (usage === undefined || usage === null) return null;
  const inputTokens = usage?.[inputField];
  const outputTokens = usage?.[outputField];
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) ||
      inputTokens < 0 || outputTokens < 0 ||
      inputTokens > MAX_REPORTED_TOKENS || outputTokens > MAX_REPORTED_TOKENS) {
    const error = new Error('Model provider returned invalid usage metadata');
    error.code = 'MODEL_USAGE_INVALID';
    throw error;
  }
  return { inputTokens, outputTokens };
}
