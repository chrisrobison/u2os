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
        <div class="workspace__subtitle">Owner-invoked read-only runs only. No automatic goal work is scheduled.</div>
      </div>
      <div class="goal-layout">
        <section class="goal-list-panel" aria-label="Saved goal drafts">
          <button type="button" class="btn goal-new">New draft</button>
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
          <p class="goal-message" role="status" aria-live="polite"></p>
          <div class="goal-runs" aria-label="Related runs"></div>
          <section class="goal-evidence" aria-label="Selected run evidence"></section>
        </form>
      </div>`;
    this._list = this.querySelector('.goal-list');
    this._form = this.querySelector('.goal-form');
    this._message = this.querySelector('.goal-message');
    this.querySelector('.goal-new').addEventListener('click', () => this._newDraft());
    this.querySelector('.goal-reload').addEventListener('click', () => this._select(this._goalId));
    this.querySelector('.goal-run').addEventListener('click', () => this._run());
    this._form.addEventListener('submit', (event) => { event.preventDefault(); this._save(); });
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
      button.title = `Draft · revision ${goal.revision}`;
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
    this._form.querySelectorAll('textarea, input').forEach((field) => { field.disabled = !editable; });
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
    this.querySelector('.goal-reload').hidden = true;
    this.querySelector('.goal-run').hidden = true;
    this._setDraftEditable(true);
    this.querySelector('.goal-form__state').textContent = 'Manual only · Next wake-up: none · Spent: 0 runs, 0 model calls, 0 tokens';
    this.querySelector('.goal-runs').replaceChildren();
    this.querySelector('.goal-evidence').replaceChildren();
    this._message.textContent = '';
    this._message.classList.remove('is-error');
    this._markSelected();
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
      this.querySelector('.goal-form__title').textContent = `${goal.status === 'draft' ? 'Draft' : 'Active (manual only)'} · revision ${goal.revision}`;
      this.querySelector('.goal-reload').hidden = false;
      this.querySelector('.goal-run').hidden = !goal.manualRunAvailable;
      this._setDraftEditable(goal.status === 'draft');
      this.querySelector('.goal-form__state').textContent = `Manual only · Next wake-up: none · Spent: ${goal.spent.runs} runs, ${goal.spent.modelCalls} model calls, ${goal.spent.tokens} reported tokens${goal.spent.tokenUsageComplete ? '' : ' (usage incomplete)'}${goal.spent.monetaryCost.available ? '' : ' (cost unavailable)'}`;
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
      if (this._goalId === goal.id) this._message.textContent = 'Draft saved. No work has started.';
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
      if (evidence.response !== null) {
        const label = document.createElement('p');
        label.textContent = `Run response (not verified completion)${evidence.responseTruncated ? ' · truncated' : ''}`;
        panel.appendChild(label);
        const response = document.createElement('pre');
        response.textContent = evidence.response;
        panel.appendChild(response);
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

  _showError(message) {
    this._message.textContent = message;
    this._message.classList.add('is-error');
  }
}

customElements.define('u2-goals', U2Goals);
