import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { withPersonalWorkflow } from './helpers/personal-workflow-fixture.js';
import { getDb } from '../server/db/connection.js';
import { getQueuedActionByActionId, listActionAttempts, requeueAction } from '../server/agent/action-queue-store.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
for (const existing of [false, true]) test(`${existing ? 'existing' : 'fresh'} personal home: SIGKILL during approved simulated send retains uncertainty without replay`, { timeout: 30_000 }, async (t) => {
  await withPersonalWorkflow({ existing, simulatedGmailSend: 'uncertain', modelPlan: (payload, fixture) => {
    assert.doesNotMatch(JSON.stringify(payload), /fixture-primary-gmail|fixture-primary-refresh|fixture-other-gmail/);
    if (!payload.tool_observations) return { reasoning_summary: 'Read selected account evidence', continue: true, actions: [
      { tool: 'email.search', arguments: { folder: 'inbox', query: 'from:recruiter@example.test role' } },
      { tool: 'calendar.list', arguments: { from: fixture.from, to: fixture.to } },
    ] };
    assert.equal(fixture.modelRequests.length, 2, 'interrupted effect must never resume planning');
    const mail = payload.tool_observations.find((item) => item.tool === 'email.search'), calendar = payload.tool_observations.find((item) => item.tool === 'calendar.list');
    const latest = mail.items.map((item, index) => ({ ...item, index })).sort((a, b) => Date.parse(b.data.received_at) - Date.parse(a.data.received_at))[0];
    assert.equal(latest.data.subject, 'Remote engineering role follow-up'); assert.equal(calendar.items[0].data.title, 'Fixture interview preparation');
    return { reasoning_summary: 'Propose a new evidence-grounded follow-up, not a threaded reply', continue: true, actions: [
      { tool: 'email.send', arguments: { to: 'placeholder', subject: 'Interrupted fixture follow-up', body: `Please suggest a time after ${calendar.items[0].data.end_at}.` },
        resultRefs: { to: { stepIndex: 0, itemIndex: latest.index, path: 'from_addr' } } },
      { tool: 'email.draft', arguments: { to: latest.data.from_addr, subject: 'Dependent fixture draft', body: 'Only after acknowledged delivery.' }, dependsOn: [0] },
    ] };
  } }, async (fixture) => {
    const entered = deferred(), errors = []; let child;
    // Native child transport really reaches this isolated HTTP server. The
    // parent fixture validates the exact original token/MIME, but no provider
    // acknowledgement is delivered to the runtime before process death.
    const provider = http.createServer(async (request, response) => {
      try {
        assert.equal(request.method, 'POST'); assert.equal(request.url, '/fixture-provider'); let body = '';
        for await (const chunk of request) body += chunk;
        const envelope = JSON.parse(body), url = new URL(envelope.url);
        assert.ok(['https://gmail.googleapis.com', 'https://www.googleapis.com'].includes(url.origin));
        const result = await globalThis.fetch(envelope.url, { method: envelope.method, headers: envelope.headers, ...(envelope.body === undefined ? {} : { body: envelope.body }) });
        if (envelope.method === 'POST') {
          assert.equal(url.href, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'); assert.equal(fixture.simulatedSends.length, 1);
          entered.resolve(); return; // Deliberately leave headers/body pending.
        }
        assert.equal(envelope.method, 'GET'); response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(await result.text());
      } catch (error) { errors.push(error); if (!response.destroyed) { response.writeHead(500); response.end('{"error":"fixture rejected request"}'); } }
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    try {
      await fixture.stop();
      child = fork(fileURLToPath(new URL('./helpers/personal-interruption-child.js', import.meta.url)), [], {
        env: { ...process.env, U2OS_HOME: fixture.home, U2OS_MDNS: '0', U2OS_ACTION_QUEUE_TICK_MS: '600000',
          U2OS_FIXTURE_MODEL_ORIGIN: fixture.modelOrigin, U2OS_FIXTURE_PROVIDER_ORIGIN: `http://127.0.0.1:${provider.address().port}` },
        execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.stdout.resume(); child.stderr.resume(); const [ready] = await once(child, 'message'); assert.equal(ready.kind, 'ready');
      const result = await fixture.apiAt(ready.port, '/api/agent/message', { text: 'Find the latest recruiter email, check availability and propose a new follow-up requiring approval. Draft another follow-up only after acknowledged delivery.' });
      const send = result.actions.find((action) => action.tool === 'email.send'); assert.equal(send.status, 'pending');
      fixture.expectedApprovedSend = { to: 'recruiter@example.test', subject: 'Interrupted fixture follow-up', body: `Please suggest a time after ${fixture.calendarEvent.end.dateTime}.` };
      assert.deepEqual(send.arguments, fixture.expectedApprovedSend); assert.equal(send.accountBinding.instanceId, fixture.primary.id);
      await fixture.apiAt(ready.port, '/api/connectors/email/active', { connectorId: 'google', instanceId: fixture.other.id, providerId: 'gmail' });
      const pending = fixture.apiAt(ready.port, `/api/actions/${send.id}/approve`, {});
      // Attach rejection immediately: SIGKILL is expected to disconnect the
      // in-flight owner HTTP request, not produce a successful approval reply.
      const disconnected = pending.then(() => { throw new Error('Approval settled before interruption'); }, () => 'disconnected');
      await Promise.race([entered.promise, disconnected.then(() => { throw new Error('Approval disconnected before provider handoff'); })]);
      const exiting = once(child, 'exit'); assert.equal(child.kill('SIGKILL'), true); const [code, signal] = await exiting;
      assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.equal(await disconnected, 'disconnected');
      const queue = getQueuedActionByActionId(send.id), attempts = listActionAttempts(queue.id);
      assert.equal(queue.status, 'executing'); assert.equal(queue.attempt_count, 1); assert.equal(attempts.length, 1); assert.equal(attempts[0].status, 'executing');
      const reads = fixture.network.length;
      // Only Date advances. Real HTTP/abort/guard timers remain unchanged; no
      // attempt/action/lease row is edited to manufacture recovery evidence.
      t.mock.timers.enable({ apis: ['Date'], now: Math.max(Date.now(), Date.parse(queue.lease_expires_at) + 1) });
      await fixture.restart(); await fixture.processQueue();
      const recovered = getQueuedActionByActionId(send.id); assert.equal(recovered.status, 'failed'); assert.equal(recovered.error_class, 'outcome_uncertain');
      const recoveredAction = await fixture.api(`/api/actions/${send.id}`);
      assert.deepEqual(recoveredAction.arguments, fixture.expectedApprovedSend); assert.deepEqual(recoveredAction.accountBinding, send.accountBinding);
      const completed = await fixture.api(`/api/agent/runs/${result.runId}/result`);
      assert.equal(completed.status, 'needs_attention'); assert.equal(completed.objectiveStatus, 'unverified'); assert.match(completed.response, /outcome uncertain/);
      assert.deepEqual(completed.steps.map((step) => step.status), ['executed', 'executed', 'outcome_uncertain', 'waiting_dependency']);
      const operation = (await fixture.api('/api/actions/operations')).items.find((item) => item.actionId === send.id);
      assert.equal(operation.errorClass, 'outcome_uncertain'); assert.equal(operation.attemptCount, 1); assert.equal(operation.account.instanceId, fixture.primary.id);
      assert.throws(() => requeueAction(queue.id), /cannot be requeued/); await fixture.api(`/api/actions/${send.id}/approve`, {}, 400);
      await fixture.api(`/api/agent/runs/${result.runId}/resume`, {}); await fixture.restart(); await fixture.processQueue();
      await fixture.api(`/api/agent/runs/${result.runId}/resume`, {});
      assert.equal(fixture.network.length, reads); assert.equal(fixture.modelRequests.length, 2); assert.equal(fixture.simulatedSends.length, 1); assert.equal(listActionAttempts(queue.id).length, 1);
      assert.equal(getDb().prepare("SELECT count(*) n FROM emails WHERE folder IN ('sent','drafts')").get().n, 0);
      assert.equal(getDb().prepare("SELECT count(*) n FROM events WHERE type='email.sent'").get().n, 0); assert.deepEqual(errors, []);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { const exiting = once(child, 'exit'); child.kill('SIGKILL'); await exiting; }
      provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
    }
  });
});
