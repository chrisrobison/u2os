import * as api from '../services/api.js';

const DOMAINS = ['web', 'email', 'calendar', 'contacts', 'tasks'];

/** Owner-facing goal editor and manual run evidence viewer. */
export class U2Goals extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Goals</div>
        <div class="workspace__subtitle">Bounded read-only runs. No automatic goal work is scheduled unless you select a wake.</div>
      </div>
      <div class="goal-layout">
        <section class="goal-list-panel" aria-label="Saved goal drafts">
          <button type="button" class="btn goal-new">New draft</button>
          <button type="button" class="btn goal-job-draft">Job research draft</button>
          <div class="goal-list"></div>
        </section>
        <form class="goal-form dashboard-card">
          <h2 class="goal-form__title">New draft</h2>
          <p class="goal-form__state">Manual only · Next wake-up: none · Spent: 0 runs, 0 model calls, 0 tokens</p>
          <label>Objective <textarea name="objective" maxlength="2000" required rows="3"></textarea></label>
          <label>Observable completion criteria <textarea name="criteria" maxlength="2400" required rows="3" placeholder="One criterion per line"></textarea></label>
          <label>Constraints <textarea name="constraints" maxlength="3000" rows="2" placeholder="One constraint per line"></textarea></label>
          <fieldset class="goal-domains"><legend>Intended domains</legend>
            ${DOMAINS.map((domain) => `<label><input type="checkbox" name="domain" value="${domain}"> ${domain}</label>`).join('')}
          </fieldset>
          <label class="goal-check"><input type="checkbox" name="consequentialActions"> May propose consequential actions later (normal policy and approval still apply)</label>
          <div class="goal-budgets">
            <label>Maximum runs <input type="number" name="maxRuns" min="1" max="100" required value="10"></label>
            <label>Maximum model calls <input type="number" name="maxModelCalls" min="1" max="300" required value="20"></label>
            <label>Maximum tokens <input type="number" name="maxTokens" min="1000" max="1000000" required value="50000"></label>
          </div>
          <p class="goal-form__note">Manual runs use read-only tools in the selected domains. This does not authorize consequential actions or start automation.</p>
          <div class="goal-form__actions"><button type="submit" class="btn btn-primary">Save draft</button><button type="button" class="btn goal-run" hidden>Run once (read-only)</button><button type="button" class="btn goal-reload" hidden>Reload saved goal</button></div>
          <div class="goal-controls" hidden><button type="button" class="btn" data-goal-control="pause">Pause goal</button><button type="button" class="btn" data-goal-control="resume">Resume goal</button><button type="button" class="btn" data-goal-control="cancel">Cancel goal</button></div>
          <section class="goal-schedule" hidden><label>One-time wake (local time) <input type="datetime-local" name="wakeAt"></label><button type="button" class="btn goal-schedule-save">Schedule one read-only pass</button><p class="goal-wake-status"></p><p class="goal-research-schedule-status"></p></section>
          <p class="goal-message" role="status" aria-live="polite"></p>
          <div class="goal-runs" aria-label="Related runs"></div>
          <section class="goal-evidence" aria-label="Selected run evidence"></section>
          <section class="goal-findings" aria-label="Research findings"></section>
        </form>
      </div>`;
    this._list = this.querySelector('.goal-list');
    this._form = this.querySelector('.goal-form');
    this._message = this.querySelector('.goal-message');
    this.querySelector('.goal-new').addEventListener('click', () => this._newDraft());
    this.querySelector('.goal-job-draft').addEventListener('click', () => this._newJobResearchDraft());
    this.querySelector('.goal-reload').addEventListener('click', () => this._select(this._goalId));
    this.querySelector('.goal-run').addEventListener('click', () => this._run());
    this.querySelector('.goal-schedule-save').addEventListener('click', () => this._schedule());
    this.querySelectorAll('[data-goal-control]').forEach((button) => button.addEventListener('click', () => this._control(button.dataset.goalControl)));
    this._form.addEventListener('submit', (event) => { event.preventDefault(); this._save(); });
    this._setDraftEditable(false);
    this.querySelector('.goal-new').disabled = true;
    this.querySelector('.goal-job-draft').disabled = true;
    this._load();
  }

  async _load() {
    const generation = this._generation || 0;
    try {
      const { goals } = await api.listGoalDrafts();
      this._renderList(goals);
      if (generation !== (this._generation || 0)) return;
      if (this._goalId) await this._select(this._goalId);
      else if (goals.length) await this._select(goals[0].id);
      else this._newDraft();
    } catch (error) { this._showError(`Couldn't load goal drafts: ${error.message}`); }
    finally {
      this.querySelector('.goal-new').disabled = false;
      this.querySelector('.goal-job-draft').disabled = false;
    }
  }

  _renderList(goals) {
    this._list.replaceChildren();
    if (!goals.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No goal drafts yet.';
      this._list.appendChild(empty);
    }
    for (const goal of goals) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'goal-list__item';
      button.textContent = goal.objective;
      button.title = `${goal.status} · revision ${goal.revision}`;
      button.dataset.goalId = goal.id;
      button.addEventListener('click', () => this._select(goal.id));
      this._list.appendChild(button);
    }
    this._markSelected();
  }

  _markSelected() {
    this._list.querySelectorAll('[data-goal-id]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.goalId === this._goalId);
    });
  }

  _setDraftEditable(editable) {
    this._draftEditable = editable;
    this._form.querySelectorAll('textarea, input:not([name="wakeAt"])').forEach((field) => { field.disabled = !editable; });
    this._form.querySelector('[type="submit"]').disabled = !editable;
  }

  _newDraft() {
    this._generation = (this._generation || 0) + 1;
    this._goalId = null;
    this._revision = null;
    this._form.reset();
    this._form.maxRuns.value = '10';
    this._form.maxModelCalls.value = '20';
    this._form.maxTokens.value = '50000';
    this.querySelector('.goal-form__title').textContent = 'New draft';
    this._form.querySelector('[type="submit"]').textContent = 'Save draft';
    this.querySelector('.goal-reload').hidden = true;
    this.querySelector('.goal-run').hidden = true;
    this.querySelector('.goal-controls').hidden = true;
    this.querySelector('.goal-schedule').hidden = true;
    this._setDraftEditable(true);
    this.querySelector('.goal-form__state').textContent = 'Manual only · Next wake-up: none · Spent: 0 runs, 0 model calls, 0 tokens';
    this.querySelector('.goal-runs').replaceChildren();
    this.querySelector('.goal-evidence').replaceChildren();
    this.querySelector('.goal-findings').replaceChildren();
    this._message.textContent = '';
    this._message.classList.remove('is-error');
    this._markSelected();
  }

  _newJobResearchDraft() {
    this._newDraft();
    this._form.objective.value = 'Research suitable job opportunities against my stated role, location and experience preferences. Ask for clarification if these preferences are missing.';
    this._form.criteria.value = [
      'Report at most five candidate opportunities with source links and observed evidence.',
      'Explain fit against my constraints using source excerpts; identify missing information and do not claim current availability from a snippet.',
      'Distinguish previously reviewed or repeated links from new findings in indexed evidence.',
    ].join('\n');
    this._form.constraints.value = 'Research only. Do not apply, send messages or contact employers.';
    this._form.querySelector('[name="domain"][value="web"]').checked = true;
    this._form.maxRuns.value = '5';
    this._form.maxModelCalls.value = '15';
    this._form.maxTokens.value = '30000';
    this.querySelector('.goal-form__title').textContent = 'New job research draft';
    this._message.textContent = 'Add your preferred role, location and experience level to Constraints, then review scope and budgets before saving. Nothing is saved or started yet; availability and fit require evidence.';
    this._form.constraints.focus();
  }

  async _select(id) {
    if (!id) return;
    const generation = this._generation = (this._generation || 0) + 1;
    try {
      const goal = await api.getGoalDraft(id);
      if (generation !== this._generation) return;
      this._goalId = goal.id;
      this._revision = goal.revision;
      this._form.objective.value = goal.objective;
      this._form.criteria.value = goal.completionCriteria.join('\n');
      this._form.constraints.value = goal.constraints.join('\n');
      this._form.querySelectorAll('[name="domain"]').forEach((input) => { input.checked = goal.permittedScope.domains.includes(input.value); });
      this._form.consequentialActions.checked = goal.permittedScope.consequentialActions;
      this._form.maxRuns.value = String(goal.budgets.maxRuns);
      this._form.maxModelCalls.value = String(goal.budgets.maxModelCalls);
      this._form.maxTokens.value = String(goal.budgets.maxTokens);
      const stateLabel = { draft: 'Draft', active: 'Active', paused: 'Paused', cancelled: 'Cancelled' }[goal.status] || goal.status;
      this.querySelector('.goal-form__title').textContent = `${stateLabel} · revision ${goal.revision}`;
      this.querySelector('.goal-reload').hidden = false;
      this.querySelector('.goal-run').hidden = !goal.manualRunAvailable;
      this.querySelector('.goal-controls').hidden = goal.status === 'cancelled';
      this.querySelectorAll('[data-goal-control]').forEach((button) => {
        button.hidden = button.dataset.goalControl === 'resume' ? goal.status !== 'paused'
          : button.dataset.goalControl === 'pause' ? goal.status === 'paused' : false;
        button.disabled = false;
      });
      this._setDraftEditable(['draft', 'paused'].includes(goal.status));
      this._form.querySelector('[type="submit"]').textContent = goal.status === 'paused' ? 'Save revised goal' : 'Save draft';
      this.querySelector('.goal-form__state').textContent = `${goal.researchSchedule?.status === 'active' ? 'Finite research schedule' : goal.nextWakeAt ? 'One-time schedule' : 'Manual only'} · Next wake-up: ${goal.nextWakeAt || 'none'} · Spent: ${goal.spent.runs} runs, ${goal.spent.modelCalls} model calls, ${goal.spent.tokens} reported tokens${goal.spent.tokenUsageComplete ? '' : ' (usage incomplete)'}${goal.spent.monetaryCost.available ? '' : ' (cost unavailable)'}`;
      this.querySelector('.goal-schedule').hidden = false;
      const canSchedule = goal.manualRunAvailable && !goal.nextWakeAt && goal.researchSchedule?.status !== 'active';
      this._form.wakeAt.disabled = !canSchedule;
      this.querySelector('.goal-schedule-save').disabled = !canSchedule;
      this.querySelector('.goal-wake-status').textContent = goal.lastWake
        ? `Wake ${goal.lastWake.status} · revision ${goal.lastWake.goalRevision} · ${goal.lastWake.fireAt}${goal.lastWake.runId ? ` · inspect run ${goal.lastWake.runId}` : ''}${goal.lastWake.blocker ? ` · ${goal.lastWake.blocker}: review goal state, budgets and linked runs before scheduling again.` : ''}`
        : 'No wake scheduled. Pause cancels pending wakes; resume does not rearm them.';
      const research = goal.researchSchedule;
      this.querySelector('.goal-research-schedule-status').textContent = research
        ? `Research schedule ${research.status} · revision ${research.goalRevision} · every ${research.intervalHours} hours · ${research.scheduledPasses}/${research.maxPasses} passes scheduled · ${research.successfulPasses} confirmed successful read passes (not goal completion)${research.blocker ? ` · ${research.blocker}: inspect linked run, goal scope and budgets before explicitly scheduling again.` : ''}`
        : 'No finite research schedule. One-time wakes do not repeat.';
      const runs = this.querySelector('.goal-runs');
      runs.replaceChildren();
      this.querySelector('.goal-evidence').replaceChildren();
      for (const run of goal.relatedRuns) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'goal-runs__item';
        button.textContent = `Inspect run ${run.id} · ${run.status} · objective ${run.objectiveStatus}`;
        button.addEventListener('click', () => this._openRun(goal.id, run.id));
        runs.appendChild(button);
      }
      this._message.textContent = '';
      this._message.classList.remove('is-error');
      this._markSelected();
      await this._loadFindings(goal.id);
    } catch (error) { if (generation === this._generation) this._showError(`Couldn't open draft: ${error.message}`); }
  }

  _payload() {
    const lines = (name) => this._form[name].value.split('\n').map((line) => line.trim()).filter(Boolean);
    return {
      objective: this._form.objective.value,
      completionCriteria: lines('criteria'), constraints: lines('constraints'),
      permittedScope: { domains: [...this._form.querySelectorAll('[name="domain"]:checked')].map((input) => input.value),
        consequentialActions: this._form.consequentialActions.checked },
      budgets: { maxRuns: Number(this._form.maxRuns.value), maxModelCalls: Number(this._form.maxModelCalls.value), maxTokens: Number(this._form.maxTokens.value) },
    };
  }

  async _save() {
    const button = this._form.querySelector('[type="submit"]');
    const generation = this._generation || 0;
    const id = this._goalId;
    const revision = this._revision;
    button.disabled = true;
    this._message.textContent = '';
    this._message.classList.remove('is-error');
    try {
      const payload = this._payload();
      const goal = id
        ? await api.updateGoalDraft(id, { ...payload, expectedRevision: revision })
        : await api.createGoalDraft(payload);
      if (generation !== (this._generation || 0)) return;
      this._goalId = goal.id;
      this._revision = goal.revision;
      const { goals } = await api.listGoalDrafts();
      if (generation !== (this._generation || 0)) return;
      this._renderList(goals);
      await this._select(goal.id);
      if (this._goalId === goal.id) this._message.textContent = goal.status === 'paused'
        ? 'Revision saved. Goal remains paused; spending and prior evidence retained.' : 'Draft saved. No work has started.';
    } catch (error) { if (generation === (this._generation || 0)) this._showError(`Couldn't save draft: ${error.message}${/changed|revision/i.test(error.message) ? ' Reload the saved draft to review the latest version.' : ''}`); }
    finally { button.disabled = !this._draftEditable; }
  }

  async _run() {
    if (!this._goalId) return;
    const id = this._goalId;
    const button = this.querySelector('.goal-run');
    button.disabled = true;
    this._message.textContent = 'Running one bounded read-only pass…';
    this._message.classList.remove('is-error');
    try {
      const result = await api.runGoalOnce(id);
      if (this._goalId !== id) return;
      await this._select(id);
      if (this._goalId === id && await this._openRun(id, result.runId)) {
        this._message.textContent = `Run ${result.runId} returned. Review its status; the goal objective is not automatically verified.`;
      }
    } catch (error) {
      if (this._goalId === id) {
        await this._select(id);
        this._showError(`Run did not complete: ${error.message}. Review the linked run before retrying.`);
      }
    } finally { button.disabled = false; }
  }

  async _openRun(goalId, runId) {
    const generation = this._generation;
    const request = this._evidenceRequest = (this._evidenceRequest || 0) + 1;
    const panel = this.querySelector('.goal-evidence');
    panel.replaceChildren();
    try {
      const evidence = await api.getGoalRunEvidence(goalId, runId);
      if (generation !== this._generation || request !== this._evidenceRequest || goalId !== this._goalId) return;
      const heading = document.createElement('h3');
      heading.textContent = `Run ${evidence.runId} · ${evidence.status} · objective ${evidence.objectiveStatus}`;
      panel.appendChild(heading);
      if (evidence.objective != null) {
        const label = document.createElement('p');
        label.textContent = `Original goal revision ${evidence.goalRevision ?? 'unavailable'}${evidence.objectiveTruncated ? ' · objective truncated' : ''}`;
        const objective = document.createElement('pre');
        objective.textContent = evidence.objective;
        panel.append(label, objective);
      }
      if (evidence.response !== null) {
        const label = document.createElement('p');
        label.textContent = `Run response (not verified completion)${evidence.responseTruncated ? ' · truncated' : ''}`;
        panel.appendChild(label);
        const response = document.createElement('pre');
        response.textContent = evidence.response;
        panel.appendChild(response);
      }
      const update = evidence.researchUpdate;
      if (update) {
        const summary = document.createElement('p');
        summary.className = 'goal-research-update';
        summary.textContent = update.unavailable ? 'Research update unavailable. Run evidence is still available; reload to retry.'
          : `Research update · ${update.newCount} new links in indexed evidence · ${update.repeatedCount} seen before · goal revision ${update.goalRevision ?? 'unavailable'} · ${update.coverage.indexedSearches}/${update.coverage.successfulSearches} successful searches indexed for this run · ${update.coverage.pendingSearches} pending · ${update.coverage.limitedSearches} limited/omitted · ${update.coverage.pendingGoalActions} goal searches awaiting indexing · ${update.coverage.limitedGoalActions} goal searches limited/omitted. Relevance, availability and goal completion not verified.`;
        panel.appendChild(summary);
        for (const finding of update.newFindings || []) {
          const row = document.createElement('p');
          row.className = 'goal-research-new';
          row.appendChild(this._findingLink(finding));
          const review = document.createElement('span');
          review.textContent = ` · ${finding.reviewStatus}${finding.reviewGoalRevision ? ` under goal revision ${finding.reviewGoalRevision}` : ''} · first observed ${finding.firstSeenAt}${finding.sources.some((source) => source.mock) ? ' · includes demo evidence' : ''}`;
          row.appendChild(review); panel.appendChild(row);
        }
        if (update.findingsTruncated) {
          const warning = document.createElement('p');
          warning.textContent = 'Showing at most 20 new links; inspect Search findings for more.';
          panel.appendChild(warning);
        }
      }
      for (const step of evidence.steps) {
        const label = document.createElement('p');
        label.textContent = `Step ${step.index} · ${step.tool} · ${step.status}${step.actionId ? ` · action ${step.actionId}` : ''}`;
        panel.appendChild(label);
        if (step.status === 'executed' && step.resultPreview !== null) {
          const result = document.createElement('pre');
          result.textContent = `${step.resultPreview}${step.resultTruncated ? '\n[preview truncated]' : ''}`;
          panel.appendChild(result);
        }
      }
      if (evidence.stepsTruncated) {
        const warning = document.createElement('p');
        warning.textContent = 'Additional steps omitted from this preview.';
        panel.appendChild(warning);
      }
      return true;
    } catch (error) {
      if (generation === this._generation && request === this._evidenceRequest && goalId === this._goalId) this._showError(`Couldn't inspect run: ${error.message}`);
      return false;
    }
  }

  async _control(operation) {
    if (!this._goalId) return;
    const id = this._goalId;
    const revision = this._revision;
    this.querySelectorAll('[data-goal-control]').forEach((button) => { button.disabled = true; });
    try {
      await api.controlGoal(id, operation, revision);
      if (this._goalId !== id) return;
      await this._select(id);
      if (this._goalId === id) this._message.textContent = operation === 'resume'
        ? 'Goal resumed. No work automatically started.'
        : `Goal ${operation === 'pause' ? 'paused' : 'cancelled'}. New work stopped; any in-flight outcome remains visible.`;
    } catch (error) { if (this._goalId === id) this._showError(`Couldn't change goal state: ${error.message}`); }
    finally { this.querySelectorAll('[data-goal-control]').forEach((button) => { button.disabled = false; }); }
  }

  async _schedule() {
    const id = this._goalId;
    if (!id) return;
    const button = this.querySelector('.goal-schedule-save');
    button.disabled = true;
    try {
      const time = new Date(this._form.wakeAt.value);
      if (!Number.isFinite(time.getTime())) throw new Error('Choose a future local date and time');
      await api.scheduleGoalWake(id, time.toISOString(), this._revision);
      if (this._goalId !== id) return;
      await this._select(id);
      if (this._goalId === id) this._message.textContent = 'One read-only wake scheduled. Pause the goal to cancel it. No work started now.';
    } catch (error) {
      if (this._goalId === id) { this._showError(`Could not schedule wake: ${error.message}`); button.disabled = false; }
    }
  }

  async _loadFindings(goalId, offset = 0) {
    const generation = this._generation;
    const goalRevision = this._revision;
    const request = this._findingRequest = (this._findingRequest || 0) + 1;
    const panel = this.querySelector('.goal-findings');
    panel.replaceChildren();
    try {
      const { findings, coverage } = await api.listGoalFindings(goalId, offset);
      if (goalId !== this._goalId || generation !== this._generation || request !== this._findingRequest) return;
      const title = document.createElement('h3');
      title.textContent = 'Search findings · relevance and availability not verified';
      const summary = document.createElement('p');
      summary.textContent = `${coverage.totalFindings} distinct links · showing ${findings.length} · ${coverage.indexedActions}/${coverage.successfulSearches} successful searches indexed · ${coverage.pendingActions} awaiting indexing · ${coverage.limitedActions} limited/omitted results · up to ${coverage.maxResultsPerAction} links per search`;
      const refresh = document.createElement('button');
      refresh.type = 'button'; refresh.className = 'btn'; refresh.textContent = 'Refresh findings';
      refresh.addEventListener('click', () => this._loadFindings(goalId, offset));
      panel.append(title, summary, refresh);
      for (const [label, start, disabled] of [['Previous findings', Math.max(0, offset - 20), offset === 0],
        ['Next findings', offset + 20, offset + findings.length >= coverage.totalFindings]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn';
        button.textContent = label; button.disabled = disabled;
        button.addEventListener('click', () => this._loadFindings(goalId, start));
        panel.appendChild(button);
      }
      for (const finding of findings) {
        const card = document.createElement('article');
        card.className = 'dashboard-card goal-finding';
        const link = this._findingLink(finding);
        const snippet = document.createElement('p'); snippet.textContent = finding.snippet;
        const state = document.createElement('p');
        state.textContent = `${finding.reviewStatus}${finding.reviewGoalRevision ? ` · reviewed under goal revision ${finding.reviewGoalRevision}` : ''} · seen in ${finding.sourceCount} searches · first ${finding.firstSeenAt} · last ${finding.lastSeenAt}`;
        card.append(link, snippet, state);
        for (const source of finding.sources) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'btn';
          button.textContent = `${source.mock ? 'Demo result · ' : ''}Source ${source.actionId} · goal revision ${source.goalRevision ?? 'unavailable'} · ${source.observedAt}${source.account ? ` · ${source.account.label || source.account.providerId} (${source.account.providerId}/${source.account.instanceId || 'no instance'})` : ' · account provenance unavailable'}`;
          button.addEventListener('click', () => this._openRun(goalId, source.runId));
          card.appendChild(button);
        }
        for (const status of ['relevant', 'dismissed', 'unreviewed']) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'btn';
          button.textContent = { relevant: 'Mark relevant', dismissed: 'Dismiss finding', unreviewed: 'Reset review' }[status];
          button.disabled = finding.reviewStatus === status;
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              await api.reviewGoalFinding(goalId, finding.id, status, finding.revision, goalRevision);
              if (this._goalId === goalId) await this._loadFindings(goalId, offset);
            } catch (error) { if (this._goalId === goalId) { this._showError(`Could not review finding: ${error.message}`); button.disabled = false; } }
          });
          card.appendChild(button);
        }
        panel.appendChild(card);
      }
    } catch (error) {
      if (goalId === this._goalId && generation === this._generation && request === this._findingRequest) {
        const warning = document.createElement('p');
        warning.textContent = `Could not load findings: ${error.message}. Reload the goal to retry.`;
        panel.appendChild(warning);
      }
    }
  }

  _showError(message) {
    this._message.textContent = message;
    this._message.classList.add('is-error');
  }

  _findingLink(finding) {
    const link = document.createElement('a');
    link.textContent = finding.title;
    try {
      const url = new URL(finding.url);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
        link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      }
    } catch { /* An invalid result remains inert text. */ }
    return link;
  }
}

customElements.define('u2-goals', U2Goals);
