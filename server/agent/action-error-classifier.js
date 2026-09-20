import { ACTION_ERROR_CLASSES } from './action-queue-store.js';

const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN']);
const AUTH_CODES = new Set(['EAUTH', 'UNAUTHENTICATED', 'INVALID_CREDENTIALS']);

/** Deterministic infrastructure classification; model output is never consulted. */
export function classifyActionError(error) {
  if (ACTION_ERROR_CLASSES.includes(error?.actionErrorClass)) return error.actionErrorClass;
  if (error?.ownerAttentionRequired === true) return 'owner_attention_required';
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (AUTH_CODES.has(code) || status === 401 || status === 403) return 'authentication_required';
  if (RETRYABLE_CODES.has(code) || status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'non_retryable';
}
