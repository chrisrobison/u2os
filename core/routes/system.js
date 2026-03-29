'use strict';

/**
 * core/routes/system.js
 *
 * System-level routes for onboarding and per-tenant settings override.
 * All routes require a resolved tenant context (req.tenantId / req.instance
 * populated by the tenancy middleware in server.js via getActiveContext()).
 *
 * Mounted at /api/system in server.js.
 */

const { deepMerge } = require('../settings');

// Canonical onboarding step definitions.
const ONBOARDING_STEPS = [
  { id: 'welcome',  label: 'Welcome' },
  { id: 'identity', label: 'Workspace' },
  { id: 'contact',  label: 'Contact' },
  { id: 'done',     label: 'Ready' }
];

const VALID_STEP_IDS = new Set(ONBOARDING_STEPS.map((s) => s.id));

/**
 * Build a default onboarding state object with all steps incomplete.
 * @returns {{ steps: Array, completed: boolean, completedAt: null }}
 */
function defaultOnboardingState() {
  return {
    completed: false,
    completedAt: null,
    steps: ONBOARDING_STEPS.map((s) => ({
      id: s.id,
      label: s.label,
      completed: false,
      completedAt: null
    }))
  };
}

/**
 * Mark a single step complete (or all steps when stepId is omitted).
 * Returns a new state object — does not mutate the input.
 *
 * @param {object} current - existing onboarding state
 * @param {string|null} stepId - step to mark, or null to mark all
 * @returns {object} updated onboarding state
 */
function applyStepComplete(current, stepId) {
  const now = new Date().toISOString();
  const steps = current.steps.map((step) => {
    const shouldMark = !stepId || step.id === stepId;
    if (shouldMark && !step.completed) {
      return { ...step, completed: true, completedAt: now };
    }
    return step;
  });

  const allDone = steps.every((s) => s.completed);
  return {
    completed: allDone,
    completedAt: allDone ? (current.completedAt || now) : null,
    steps
  };
}

/**
 * Walk a settings object looking for a path whose sibling _readOnly key is true.
 * Returns true when the given path (array of keys) is operator-locked.
 *
 * Strategy: for each key in the path, check whether the current object has a
 * sibling `_<key>_readOnly` or a nested `_readOnly` marker inside that key.
 * We use a simple convention: if globalSettings[section]['_readOnly'] === true
 * at ANY ancestor of the requested path, the path is locked.
 *
 * @param {object} globalSettings
 * @param {string[]} keyPath
 * @returns {boolean}
 */
function isPathReadOnly(globalSettings, keyPath) {
  let cursor = globalSettings;
  for (const key of keyPath) {
    if (!cursor || typeof cursor !== 'object') return false;
    // Check for a _readOnly flag on the current level keyed by field name
    if (cursor[`_${key}_readOnly`] === true) return true;
    cursor = cursor[key];
    // Check for a _readOnly flag inside the value itself
    if (cursor && typeof cursor === 'object' && cursor._readOnly === true) return true;
  }
  return false;
}

/**
 * Collect all leaf key-paths (as arrays) from a nested settings object,
 * excluding keys that start with '_'.
 *
 * @param {object} obj
 * @param {string[]} prefix
 * @returns {string[][]}
 */
function collectLeafPaths(obj, prefix = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return [prefix];
  }
  const paths = [];
  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) continue;
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...collectLeafPaths(value, [...prefix, key]));
    } else {
      paths.push([...prefix, key]);
    }
  }
  return paths;
}

/**
 * Check whether any of the paths in the override body conflict with read-only
 * fields declared in the global settings.
 *
 * @param {object} globalSettings - parsed global settings.json
 * @param {object} overrideBody - body sent by the client
 * @returns {{ blocked: boolean, path: string|null }}
 */
function findReadOnlyConflict(globalSettings, overrideBody) {
  const paths = collectLeafPaths(overrideBody);
  for (const keyPath of paths) {
    if (isPathReadOnly(globalSettings, keyPath)) {
      return { blocked: true, path: keyPath.join('.') };
    }
  }
  return { blocked: false, path: null };
}

/**
 * Fetch the raw instance row (with onboarding_state and settings_override)
 * from the control-plane DB by instance ID.
 *
 * Uses a plain SELECT so this module stays decoupled from controlStore's
 * higher-level methods — the columns may not be returned by controlStore yet
 * if ALTER TABLE hasn't run (gracefully handles NULL).
 *
 * @param {object} controlStore
 * @param {string} instanceId
 * @returns {Promise<object|null>}
 */
async function fetchInstanceRow(controlStore, instanceId) {
  // controlStore exposes no generic query, but we can use getInstance which
  // already queries the instances table — however it won't return the new
  // columns because they're fetched by name. We need raw access.
  // The connector is not directly exposed, so we use a workaround:
  // controlStore.getInstance returns a parsed row. New columns are additive
  // and will come along as extra properties when the DB has them.
  const instance = await controlStore.getInstance(instanceId);
  return instance;
}

/**
 * Factory — returns an Express router configured with onboarding and settings
 * endpoints.
 *
 * @param {object} opts
 * @param {object} opts.controlStore - the control-plane store
 * @param {Function} opts.getActiveContext - returns the current tenant context
 * @param {Function} opts.loadSettingsForInstance - loads effective settings
 * @param {object} opts.globalSettings - the parsed global settings object
 */
function createSystemRouter(opts) {
  const { Router } = require('express');
  const router = Router();

  const {
    controlStore,
    getActiveContext,
    loadSettingsForInstance,
    globalSettings
  } = opts;

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function parseJson(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
  }

  /**
   * Write onboarding_state JSON back to the instances row in the control DB.
   * Uses the existing updateInstance path which only touches known fields —
   * so we need to directly update the new column via the connector.
   * We piggy-back on controlStore internals via a lightweight escape hatch:
   * the controlStore exposes no raw query, so we use a direct SQL update
   * through the connector reference stored during createControlStore.
   *
   * Since controlStore doesn't expose its connector directly, we use a
   * small bridge: call updateInstanceMeta which we add to controlStore (see
   * controlStore patch below). For now, we patch via the store's query method
   * if it's exposed, or fall back gracefully.
   *
   * Actually: controlStore wraps connector.query and does NOT expose it.
   * The cleanest path without modifying controlStore.js is to go through a
   * dedicated method we'll add to the store's public surface. We add
   * `updateInstanceOnboardingState` and `updateInstanceSettingsOverride`
   * to controlStore — but that requires modifying controlStore.js.
   *
   * Instead, we use the pattern the codebase already has: pass the needed
   * query functions in via the opts object from server.js.
   */

  /**
   * Read-modify-write the onboarding_state for the active instance.
   */
  async function getOnboardingState(instanceId) {
    const instance = await controlStore.getInstance(instanceId);
    if (!instance) return defaultOnboardingState();
    const raw = instance.onboarding_state || instance['onboarding_state'];
    return parseJson(raw, defaultOnboardingState());
  }

  async function saveOnboardingState(instanceId, state) {
    if (typeof opts.updateInstanceOnboardingState === 'function') {
      await opts.updateInstanceOnboardingState(instanceId, JSON.stringify(state));
    }
  }

  async function getSettingsOverride(instanceId) {
    const instance = await controlStore.getInstance(instanceId);
    if (!instance) return {};
    const raw = instance.settings_override || instance['settings_override'];
    return parseJson(raw, {});
  }

  async function saveSettingsOverride(instanceId, overrideObj) {
    if (typeof opts.updateInstanceSettingsOverride === 'function') {
      await opts.updateInstanceSettingsOverride(instanceId, JSON.stringify(overrideObj));
    }
  }

  // ─── GET /api/system/onboarding ──────────────────────────────────────────

  router.get('/onboarding', async (req, res, next) => {
    try {
      const context = getActiveContext();
      const instanceId = context.instance.id;
      const state = await getOnboardingState(instanceId);
      return res.json(state);
    } catch (error) {
      return next(error);
    }
  });

  // ─── POST /api/system/onboarding/complete ────────────────────────────────

  router.post('/onboarding/complete', async (req, res, next) => {
    try {
      const context = getActiveContext();
      const instanceId = context.instance.id;

      const body = req.body || {};
      const stepId = body.step ? String(body.step).trim() : null;

      // Validate step when provided
      if (stepId && !VALID_STEP_IDS.has(stepId)) {
        return res.status(400).json({
          error: `Invalid step '${stepId}'. Valid steps: ${[...VALID_STEP_IDS].join(', ')}`
        });
      }

      const current = await getOnboardingState(instanceId);
      const updated = applyStepComplete(current, stepId || null);
      await saveOnboardingState(instanceId, updated);

      return res.json(updated);
    } catch (error) {
      return next(error);
    }
  });

  // ─── GET /api/system/settings ─────────────────────────────────────────────
  // Note: a GET /api/system/settings already exists in server.js. This router
  // is mounted AFTER that route, so the server.js version takes precedence.
  // We register it here only as a fallback (will not be reached normally).
  // The server.js version should be updated to include settings_override merge.

  router.get('/settings', async (req, res, next) => {
    try {
      const context = getActiveContext();
      const baseSettings = await loadSettingsForInstance(context.instance);
      const override = await getSettingsOverride(context.instance.id);
      const effective = deepMerge(baseSettings.effectiveSettings, override);
      return res.json({
        version: 'v1',
        data: {
          clientKey: baseSettings.clientKey,
          effectiveSettings: effective,
          source: baseSettings.source
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  // ─── PUT /api/system/settings ─────────────────────────────────────────────

  router.put('/settings', async (req, res, next) => {
    try {
      // Require authenticated user (tenant-level auth via req.auth)
      if (!req.auth) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
      }

      // Check operator-locked fields
      const conflict = findReadOnlyConflict(globalSettings, body);
      if (conflict.blocked) {
        return res.status(403).json({
          error: `Setting '${conflict.path}' is operator-locked and cannot be changed by tenants`
        });
      }

      const context = getActiveContext();
      const instanceId = context.instance.id;

      // Load current override and deep-merge the incoming body into it
      const currentOverride = await getSettingsOverride(instanceId);
      const newOverride = deepMerge(currentOverride, body);
      await saveSettingsOverride(instanceId, newOverride);

      // Return the full effective settings after merge
      const baseSettings = await loadSettingsForInstance(context.instance);
      const effective = deepMerge(baseSettings.effectiveSettings, newOverride);

      return res.json({
        version: 'v1',
        data: {
          clientKey: baseSettings.clientKey,
          effectiveSettings: effective,
          source: baseSettings.source
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createSystemRouter };
