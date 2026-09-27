// Shared type documentation for the package platform
// (docs/plugin-architecture.md). JSDoc only: the project has no build step.

/**
 * @typedef {'read'|'write'} CapabilityEffect
 *   `read` has no external side effect; `write` is consequential and is
 *   subject to policies.yaml autonomy levels and approvals.
 */

/**
 * @typedef {object} CapabilityDefinition   A versioned capability contract.
 * @property {string} id                     e.g. "web.search"
 * @property {string} version                semver
 * @property {string} description
 * @property {CapabilityEffect} effect
 * @property {object} inputSchema            JSON Schema subset (json-schema.js)
 * @property {object|null} outputSchema
 * @property {string[]} requiredPermissions  normalized permissions (permissions.js)
 * @property {string} source                 'core' or 'package:<id>'
 */

/**
 * @typedef {object} CapabilityProvider      An implementation of a contract.
 * @property {string} id                     provider id ("core", "gmail", "com.example.pkg")
 * @property {string} capability             contract id
 * @property {string|null} packageId
 * @property {'tool'|'fixture'|'static'|'module'} kind
 * @property {(input: object, context: CapabilityContext) => Promise<object>} [execute]
 */

/**
 * @typedef {object} CapabilityContext       What a provider receives.
 * @property {string|null} packageId
 * @property {object} settings               effective package settings
 * @property {(name: string) => object|null} getSecret  declared secrets only
 * @property {(capabilityId: string, input: object) => Promise<object>} invoke  permission-checked
 */

/**
 * @typedef {object} SkillDefinition
 * @property {string} id
 * @property {string} version
 * @property {string} description
 * @property {object} inputSchema
 * @property {object|null} outputSchema
 * @property {{capabilities: Object<string,string>, skills: Object<string,string>}} requires
 * @property {object|null} workflow          declarative workflow (preferred)
 * @property {object|null} implementation    { type: 'module', module, export } escape hatch
 * @property {string} packageId
 */

/**
 * @typedef {object} AutomationDefinition
 * @property {string} id
 * @property {string} name
 * @property {object[]} triggers             see triggers.js
 * @property {{schema: object|null, initial: object}} state
 * @property {'single'|'parallel'} concurrency
 * @property {object} workflow
 * @property {string} packageId
 */

/**
 * @typedef {object} PackageAuthority        Overlay passed to the action gate.
 * @property {string} packageId
 * @property {string|null} automationId
 * @property {string|null} workflowRunId
 * @property {string|null} stepId
 * @property {{allowed: boolean, required: string[], missingDeclared: string[], missingGrant: string[]}} permission
 * @property {{name: string, decision: 'automatic'|'approval'|'deny', reasons: string[]}|null} policy
 */

/**
 * @typedef {object} EventEnvelope           The existing EventBus envelope (docs/events.md).
 * @property {string} id                     "evt_..."
 * @property {string} type                   "job.candidate"
 * @property {string} timestamp
 * @property {string} source                 "package:com.u2os.job-hunter"
 * @property {{type: string, id: string}|null} subject
 * @property {object} data
 * @property {object} metadata               includes automationInstanceId / workflowRunId for package events
 */

export {};
