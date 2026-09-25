import { newId } from '../db/ids.js';
import { getAgentAction, updateAgentAction } from '../policy/policy-engine.js';
import {
  beginActionAttempt,
  completeActionAttempt,
  failActionAttempt,
  getQueuedActionByActionId,
  leaseActionByActionId,
  leaseNextAction,
  listActionAttempts,
  renewActionLease,
  stopLeasedAction,
} from './action-queue-store.js';
import { classifyActionError } from './action-error-classifier.js';
import { getProviderForBinding } from '../integrations/provider-registry.js';
import { accountDomainForAction, assertCalendarTarget, assertSmtpIdentity } from './account-binding.js';
import { findRunByAction, isCancellationRequested } from './run-store.js';

export class ActionQueueWorker {
  constructor({ actionEvaluator, actionExecutor, eventBus, workerId, maxActionAgeMs = 24 * 60 * 60 * 1000, leaseMs = 30_000 }) {
    this.actionEvaluator = actionEvaluator;
    this.actionExecutor = actionExecutor;
    this.eventBus = eventBus;
    this.workerId = workerId || newId('worker');
    this.maxActionAgeMs = maxActionAgeMs;
    this.leaseMs = leaseMs;
  }

  async processAction(actionId) {
    const item = leaseActionByActionId(actionId, { leaseOwner: this.workerId, leaseMs: this.leaseMs });
    return item ? this._executeLeased(item) : this._currentOutcome(actionId);
  }

  async processNext() {
    const item = leaseNextAction({ leaseOwner: this.workerId, leaseMs: this.leaseMs });
    return item ? this._executeLeased(item) : null;
  }

  async _executeLeased(item) {
    const action = getAgentAction(item.action_id);
    if (!action) return this._stop(item, 'cancelled', 'Authoritative action record is missing', 'non_retryable');
    if (action.status === 'rejected' || action.rejected_at) {
      return this._stop(item, 'cancelled', 'Owner approval was rejected or revoked', 'owner_attention_required', action);
    }
    if (action.status === 'executed') {
      const attempt = beginActionAttempt({ queueId: item.id, leaseOwner: this.workerId });
      const completed = completeActionAttempt(attempt.id, { leaseOwner: this.workerId });
      this._publishQueueStatus(completed);
      return this._currentOutcome(action.id);
    }
    const runId = findRunByAction(action.id);
    if (runId && isCancellationRequested(runId)) {
      if (item.attempt_count > 0) {
        return this._stop(item, 'failed', 'Run cancelled after a prior attempt; outcome needs owner review', 'owner_attention_required', action);
      }
      updateAgentAction(action.id, { status: 'cancelled', result: { error: 'Run cancelled before attempt' } });
      return this._stop(item, 'cancelled', 'Run cancelled before attempt', 'non_retryable', action);
    }

    let tool;
    let evaluation;
    try {
      tool = this.actionEvaluator.resolve(item.tool);
      evaluation = this.actionEvaluator.evaluate({ tool, arguments: item.arguments });
    } catch (error) {
      return this._stop(item, 'failed', error.message, 'non_retryable', action);
    }

    if (evaluation.blocked) {
      updateAgentAction(action.id, { status: 'blocked', result: { error: evaluation.reason } });
      return this._stop(item, 'cancelled', evaluation.reason, 'non_retryable', action);
    }
    const createdAt = Date.parse(action.created_at);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > this.maxActionAgeMs) {
      updateAgentAction(action.id, { status: 'failed', result: { error: 'Action is stale and requires owner review' } });
      return this._stop(item, 'failed', 'Action is stale and requires owner review', 'owner_attention_required', action);
    }
    if (evaluation.requiresApproval && !action.approved_at) {
      updateAgentAction(action.id, { status: 'pending' });
      return this._stop(item, 'failed', 'Current policy requires owner approval', 'owner_attention_required', action);
    }
    const accountDomain = accountDomainForAction(item.tool);
    if (accountDomain) {
      try {
        getProviderForBinding(accountDomain, action.accountBinding);
        if (item.tool === 'email.send') assertSmtpIdentity(action.accountBinding);
        if (item.tool === 'calendar.reschedule') assertCalendarTarget(action.accountBinding, item.arguments.eventId);
      }
      catch (error) {
        updateAgentAction(action.id, { status: 'failed', result: { error: error.message } });
        return this._stop(item, 'failed', error.message, 'owner_attention_required', action);
      }
    }
    if (JSON.stringify(item.arguments) !== JSON.stringify(action.arguments)) {
      updateAgentAction(action.id, { status: 'failed', result: { error: 'Queued payload differs from the approved proposal' } });
      return this._stop(item, 'failed', 'Queued payload differs from the approved proposal', 'owner_attention_required', action);
    }

    const priorAttempts = listActionAttempts(item.id);
    const recoveredUncertainAttempt = priorAttempts.at(-1)?.error === 'lease expired';
    if (recoveredUncertainAttempt && tool.supportsIdempotency !== true) {
      updateAgentAction(action.id, { status: 'failed', result: { error: 'Prior external outcome is uncertain; owner review required' } });
      return this._stop(item, 'failed', 'Prior external outcome is uncertain; owner review required', 'owner_attention_required', action);
    }

    const attempt = beginActionAttempt({ queueId: item.id, leaseOwner: this.workerId });
    const heartbeat = setInterval(() => {
      renewActionLease(item.id, { leaseOwner: this.workerId, leaseMs: this.leaseMs });
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    let outcome;
    try {
      outcome = await this.actionExecutor.execute(action.id, tool, item.arguments, {
        correlationId: item.correlation_id,
        actor: item.actor || { type: 'agent', id: action.requested_by },
        idempotencyKey: item.idempotency_key,
        accountBinding: action.accountBinding,
        rethrow: true,
      });
    } catch (error) {
      clearInterval(heartbeat);
      let errorClass = classifyActionError(error);
      if (errorClass === 'retryable' && tool.supportsIdempotency !== true && error.safeToRetry !== true) {
        errorClass = 'owner_attention_required';
      }
      const queue = failActionAttempt(attempt.id, { leaseOwner: this.workerId, error, errorClass });
      this._publishQueueStatus(queue);
      return { id: action.id, status: queue.status, tool: action.tool, error: error.message, errorClass };
    }
    clearInterval(heartbeat);
    const completed = completeActionAttempt(attempt.id, { leaseOwner: this.workerId });
    this._publishQueueStatus(completed);
    return outcome;
  }

  _stop(item, status, message, errorClass, action = null) {
    const stopped = stopLeasedAction(item.id, { leaseOwner: this.workerId, status, error: message, errorClass });
    this._publishQueueStatus(stopped);
    return { id: item.action_id, status, tool: action?.tool || item.tool, error: message, errorClass };
  }

  _publishQueueStatus(queue) {
    this.eventBus.publish({
      type: 'agent.action.queue_updated',
      source: 'action-queue',
      actor: { type: 'system', id: this.workerId },
      subject: { type: 'agent_action', id: queue.action_id },
      data: { status: queue.status, attemptCount: queue.attempt_count, errorClass: queue.error_class },
      metadata: { correlationId: queue.correlation_id, provenance: 'action-queue:transition' },
    });
  }

  _currentOutcome(actionId) {
    const action = getAgentAction(actionId);
    const queue = getQueuedActionByActionId(actionId);
    if (!action) return null;
    return {
      id: action.id,
      status: queue?.status === 'completed' ? 'executed' : queue?.status || action.status,
      tool: action.tool,
      arguments: action.arguments,
      result: action.result,
    };
  }
}
