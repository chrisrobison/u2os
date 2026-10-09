import { executePlan, inspectApplication } from './apply.js';

// The form driver contract: the one place a browser (or anything else that
// can read and fill an application form) plugs in.
//
// Playwright is one implementation. A second driver is registered with
// registerDriver() and selected by `browser.driver` in autopilot.yaml.

/**
 * @typedef {object} FormSchema   what inspect() returns (see schema.js readFormSchema)
 * @property {boolean} hasForm
 * @property {Array<object>} fields   {key, label, type, required, filled, options?}
 * @property {{captcha?: boolean, password?: boolean}} [blockers]
 */

/**
 * @typedef {object} ExecuteResult
 * @property {string} status   submitted | unconfirmed | dry_run | failed | manual_required | schema_changed | files_changed | fill_incomplete
 *                             (anything else is treated by callers as uncertain and is never retried)
 * @property {string} [reason]
 * @property {string[]} [errors]
 * @property {string[]} [missing]
 * @property {string[]} [failed]
 * @property {string[]} [screenshots]
 */

/**
 * @typedef {object} FormDriver
 * @property {(args: {url: string}) => Promise<FormSchema>} inspect
 *   Read-only: open the application page and report its form. Never fills or submits.
 * @property {(args: {plan: object, files?: object, submit?: boolean, headed?: boolean,
 *   beforeSubmit?: () => Promise<void>, screenshotDir?: string|null}) => Promise<ExecuteResult>} execute
 *   Fill the reviewed plan and (when `submit`) submit it. A driver MUST:
 *   1. stop with manual_required on a CAPTCHA, login wall or missing form (never evade);
 *   2. return schema_changed if the form's field hash differs from plan.schemaHash (schemaHash() in schema.js);
 *   3. return files_changed if an uploaded file's SHA-256 differs from the plan's;
 *   4. return fill_incomplete unless every required field ends up filled;
 *   5. await beforeSubmit() immediately before the submit action, and never before the checks above;
 *   6. never call beforeSubmit() on a dry run (submit === false);
 *   7. report an unprovable outcome as unconfirmed, not submitted. Callers never retry an uncertain outcome.
 */

const DEFAULT_DRIVER = 'playwright';

/** @type {FormDriver} */
export const playwrightDriver = Object.freeze({
  name: 'playwright',
  inspect: (args) => inspectApplication(args),
  execute: (args) => executePlan(args),
});

const registry = new Map([[playwrightDriver.name, playwrightDriver]]);

/** Registers a driver under a name (used by additional drivers and by tests). */
export function registerDriver(name, driver) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error('Form driver name must be lowercase letters, digits, - or _');
  if (typeof driver?.inspect !== 'function' || typeof driver?.execute !== 'function') throw new Error(`Form driver "${name}" must provide inspect() and execute()`);
  registry.set(name, driver);
  return driver;
}

export function unregisterDriver(name) { if (name !== DEFAULT_DRIVER) registry.delete(name); }

export const driverNames = () => [...registry.keys()];

/** A driver object, or a registered name (default "playwright"). An unknown name throws. */
export function resolveDriver(driver) {
  if (driver === undefined || driver === null) driver = DEFAULT_DRIVER;
  if (driver && typeof driver === 'object') {
    if (typeof driver.inspect !== 'function' || typeof driver.execute !== 'function') throw new Error('Form driver must provide inspect() and execute()');
    return driver;
  }
  const found = registry.get(driver);
  if (!found) throw new Error(`Unknown form driver "${driver}" (available: ${driverNames().join(', ')})`);
  return found;
}
