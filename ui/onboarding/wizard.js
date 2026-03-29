/**
 * ui/onboarding/wizard.js
 *
 * Self-contained vanilla JS onboarding wizard. No external dependencies.
 *
 * Flow:
 *   1. On load: GET /api/system/onboarding — if already completed, redirect to /app/
 *   2. GET /api/system/settings — pre-fill form fields
 *   3. Render current step
 *   On Next:
 *     - Validate current step fields
 *     - If identity/contact step: PUT /api/system/settings
 *     - POST /api/system/onboarding/complete with step id
 *     - Advance to next step
 *   On Finish (done step):
 *     - POST /api/system/onboarding/complete (mark all)
 *     - Redirect to /app/
 *   Skip setup:
 *     - POST /api/system/onboarding/complete (no step = mark all)
 *     - Redirect to /app/
 */

'use strict';

// ── Step definitions (must match server ONBOARDING_STEPS) ───────────────────

const STEPS = [
  { id: 'welcome',  label: 'Welcome',   fields: [] },
  { id: 'identity', label: 'Workspace', fields: ['productName', 'logoUrl', 'primaryColor'] },
  { id: 'contact',  label: 'Contact',   fields: ['supportEmail'] },
  { id: 'done',     label: 'Ready',     fields: [] }
];

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  currentStepIndex: 0,
  busy: false
};

// ── DOM refs ─────────────────────────────────────────────────────────────────

const progressDots = document.getElementById('progressDots');
const wizardBanner = document.getElementById('wizardBanner');
const btnBack      = document.getElementById('btnBack');
const btnNext      = document.getElementById('btnNext');
const btnSkip      = document.getElementById('btnSkip');

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (response.status === 401) {
    // Redirect to app login — adapt path if your auth route differs
    window.location.href = '/app/';
    return null;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload.error || `Request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  // Unwrap v1 envelope if present
  return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

// ── Banner ────────────────────────────────────────────────────────────────────

function showBanner(message, type = 'error') {
  wizardBanner.textContent = message;
  wizardBanner.className = `wizard-banner visible ${type}`;
}

function hideBanner() {
  wizardBanner.className = 'wizard-banner';
  wizardBanner.textContent = '';
}

// ── Progress dots ─────────────────────────────────────────────────────────────

function renderProgress() {
  progressDots.innerHTML = '';
  STEPS.forEach((step, idx) => {
    if (idx > 0) {
      const connector = document.createElement('div');
      connector.className = 'wizard-step-connector';
      progressDots.appendChild(connector);
    }
    const dot = document.createElement('div');
    const isDone   = idx < state.currentStepIndex;
    const isActive = idx === state.currentStepIndex;
    dot.className = `wizard-step-dot${isDone ? ' done' : ''}${isActive ? ' active' : ''}`;
    dot.setAttribute('aria-label', `${step.label}${isDone ? ' (complete)' : isActive ? ' (current)' : ''}`);
    progressDots.appendChild(dot);
  });
}

// ── Step panel visibility ─────────────────────────────────────────────────────

function showStep(index) {
  STEPS.forEach((step) => {
    const panel = document.getElementById(`step-${step.id}`);
    if (panel) panel.classList.remove('active');
  });
  const current = STEPS[index];
  const panel = document.getElementById(`step-${current.id}`);
  if (panel) panel.classList.add('active');
}

// ── Button state ──────────────────────────────────────────────────────────────

function updateButtons() {
  const isFirst = state.currentStepIndex === 0;
  const isLast  = state.currentStepIndex === STEPS.length - 1;

  btnBack.hidden = isFirst;
  btnSkip.hidden = !isFirst;

  if (isLast) {
    btnNext.textContent = 'Open Workspace';
  } else {
    btnNext.textContent = 'Next';
  }

  btnNext.disabled = state.busy;
  btnBack.disabled = state.busy;
}

// ── Field pre-fill ────────────────────────────────────────────────────────────

function prefillFields(settings) {
  const branding = (settings && settings.branding) || {};

  const productNameEl = document.getElementById('productName');
  if (productNameEl && branding.productName) {
    productNameEl.value = branding.productName;
  }

  const logoUrlEl = document.getElementById('logoUrl');
  if (logoUrlEl && branding.logoUrl) {
    logoUrlEl.value = branding.logoUrl;
  }

  const primaryColorEl = document.getElementById('primaryColor');
  const primaryColorHexEl = document.getElementById('primaryColorHex');
  if (branding.primaryColor) {
    if (primaryColorEl) primaryColorEl.value = branding.primaryColor;
    if (primaryColorHexEl) primaryColorHexEl.value = branding.primaryColor;
  }

  const supportEmailEl = document.getElementById('supportEmail');
  if (supportEmailEl && branding.supportEmail) {
    supportEmailEl.value = branding.supportEmail;
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

function clearValidation() {
  document.querySelectorAll('.wizard-field.has-error').forEach((el) => {
    el.classList.remove('has-error');
  });
}

function setFieldError(fieldId, show) {
  const wrapper = document.getElementById(`field-${fieldId}`);
  if (wrapper) {
    wrapper.classList.toggle('has-error', show);
  }
}

function isValidEmail(value) {
  // Simple RFC-ish check; good enough for onboarding
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

/**
 * Validate fields for the current step.
 * Returns true when all fields are valid.
 */
function validateCurrentStep() {
  const step = STEPS[state.currentStepIndex];
  clearValidation();
  let valid = true;

  if (step.id === 'identity') {
    const productName = String(document.getElementById('productName')?.value || '').trim();
    if (!productName) {
      setFieldError('productName', true);
      valid = false;
    }
  }

  if (step.id === 'contact') {
    const email = String(document.getElementById('supportEmail')?.value || '').trim();
    if (!isValidEmail(email)) {
      setFieldError('supportEmail', true);
      valid = false;
    }
  }

  return valid;
}

// ── Collect step payload for settings PUT ─────────────────────────────────────

function collectIdentityPayload() {
  const productName  = String(document.getElementById('productName')?.value || '').trim();
  const logoUrl      = String(document.getElementById('logoUrl')?.value || '').trim();
  const primaryColor = String(document.getElementById('primaryColorHex')?.value
    || document.getElementById('primaryColor')?.value || '').trim();

  const branding = { productName };
  if (logoUrl)      branding.logoUrl      = logoUrl;
  if (primaryColor) branding.primaryColor = primaryColor;

  return { branding };
}

function collectContactPayload() {
  const supportEmail = String(document.getElementById('supportEmail')?.value || '').trim();
  return { branding: { supportEmail } };
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function saveCurrentStepSettings() {
  const step = STEPS[state.currentStepIndex];
  let body = null;

  if (step.id === 'identity')  body = collectIdentityPayload();
  if (step.id === 'contact')   body = collectContactPayload();

  if (!body) return; // welcome / done have no fields to save

  await apiFetch('/api/system/settings', {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

async function markStepComplete(stepId) {
  await apiFetch('/api/system/onboarding/complete', {
    method: 'POST',
    body: stepId ? JSON.stringify({ step: stepId }) : '{}'
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────

async function goNext() {
  if (state.busy) return;

  // Final step: mark all complete and go to app
  if (state.currentStepIndex === STEPS.length - 1) {
    state.busy = true;
    updateButtons();
    try {
      await markStepComplete(null); // null = mark all complete
      window.location.href = '/app/';
    } catch (error) {
      showBanner(error.message);
      state.busy = false;
      updateButtons();
    }
    return;
  }

  // Validate before advancing
  if (!validateCurrentStep()) {
    return;
  }

  state.busy = true;
  updateButtons();
  hideBanner();

  try {
    const currentStep = STEPS[state.currentStepIndex];
    await saveCurrentStepSettings();
    await markStepComplete(currentStep.id);
    state.currentStepIndex += 1;
    render();
  } catch (error) {
    showBanner(error.message);
  } finally {
    state.busy = false;
    updateButtons();
  }
}

function goBack() {
  if (state.busy || state.currentStepIndex === 0) return;
  clearValidation();
  hideBanner();
  state.currentStepIndex -= 1;
  render();
}

async function skipSetup() {
  if (state.busy) return;
  state.busy = true;
  updateButtons();
  hideBanner();
  try {
    await markStepComplete(null); // mark all complete
    window.location.href = '/app/';
  } catch (error) {
    showBanner(error.message);
    state.busy = false;
    updateButtons();
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  showStep(state.currentStepIndex);
  renderProgress();
  updateButtons();
}

// ── Color picker sync ─────────────────────────────────────────────────────────

function bindColorSync() {
  const picker = document.getElementById('primaryColor');
  const hex    = document.getElementById('primaryColorHex');
  if (!picker || !hex) return;

  picker.addEventListener('input', () => {
    hex.value = picker.value;
  });

  hex.addEventListener('input', () => {
    const val = hex.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      picker.value = val;
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
  try {
    // Check if already completed — redirect immediately
    const onboardingState = await apiFetch('/api/system/onboarding');
    if (onboardingState && onboardingState.completed) {
      window.location.href = '/app/';
      return;
    }

    // Pre-fill fields from current settings
    try {
      const settings = await apiFetch('/api/system/settings');
      if (settings && settings.effectiveSettings) {
        prefillFields(settings.effectiveSettings);
      }
    } catch {
      // Non-fatal — just leave fields blank
    }

    bindColorSync();

    // Wire up buttons
    btnNext.addEventListener('click', goNext);
    btnBack.addEventListener('click', goBack);
    btnSkip.addEventListener('click', skipSetup);

    // Keyboard: Enter advances the wizard
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        goNext();
      }
    });

    render();
  } catch (error) {
    showBanner(`Failed to load setup: ${error.message}`);
  }
}());
