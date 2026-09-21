# Contributing to U2OS

U2OS is a local-first personal agent, not a chatbot wrapper. Contributions should deepen the observe → remember → anticipate → act → observe outcome → learn loop while preserving owner control, provenance, and replaceable infrastructure.

## Ground rules

- Require Node.js 22 or newer and use native ES modules.
- Keep SQLite as the authoritative local store.
- Keep the browser no-build: vanilla JavaScript, Web Components, and web standards.
- Prefer small explicit modules over framework or dependency expansion.
- Treat browser clients, connector content, model output, and device messages as untrusted.
- Keep authorization outside the model. Every consequential tool action must pass through policy, audit, and durable execution.
- Keep data-processing privacy separate from action authorization.
- Never store or expose model chain-of-thought. Stored reasoning summaries and provenance are sufficient.
- Preserve existing `U2OS_HOME` installations with additive migrations and conservative defaults.

Read [docs/architecture.md](docs/architecture.md), [docs/policies.md](docs/policies.md), [docs/events.md](docs/events.md), and [docs/models.md](docs/models.md) before changing a trust boundary.

## Set up and test

```sh
npm install
npm test
npm run test:e2e
```

Run the service with `npm start`, or `npm run dev` for automatic restarts. Runtime data belongs under `U2OS_HOME`; use a temporary value while developing against migrations or seed data. Do not point destructive tests at a real owner data directory.

The Node suite uses the built-in test runner. Browser tests use Playwright against the real server and real Web Components—there is no frontend compilation step. Add focused regression coverage first, run targeted tests while iterating, then run both complete suites before opening a pull request.

## Code and pull requests

- Match the existing formatting and naming in the file you touch; the project does not impose a formatter-generated rewrite.
- Keep commits and pull requests focused on one coherent issue.
- Use a GitHub issue, working branch, pull request, self-review, passing CI, and squash merge for substantial work.
- Review the complete diff for correctness, privacy leaks, authorization bypasses, error handling, migration safety, idempotency, secrets, and documentation drift.
- Update subsystem docs in the same change as behavior. Clearly label implemented, mock, degraded, planned, and unavailable paths.

## Add a tool

1. Implement the `Tool` contract in `server/tools/`: `name`, `domain`, `category`, JSON schema, and `execute()`.
2. Register it in `server/tools/register-all.js`.
3. Add or update the authoritative server policy configuration. Never infer autonomy from model output or browser identity.
4. Publish a normalized event for state changes with correlation and provenance metadata.
5. Leave `supportsIdempotency` false unless the concrete external provider consumes the durable idempotency key and guarantees duplicate suppression.
6. Test schema rejection, policy outcomes, audit records, failures, and any external-side-effect recovery behavior. Update [docs/tools.md](docs/tools.md) and [docs/policies.md](docs/policies.md).

## Add a provider or connector

1. Implement the existing domain interface under `server/integrations/`; tools must remain provider-agnostic.
2. Register the provider explicitly in `provider-registry.js` and its allowed ID in `connectors-config.js`.
3. Add a metadata-only manifest under `skills/` when the connector should appear in the UI.
4. Store credentials with `server/security/vault.js`; APIs and logs may expose status, never credential values.
5. Classify remote destinations authoritatively and apply the data-processing policy before sending owner data.
6. Bound network calls, sanitize provider errors, and do not claim idempotency without a provider guarantee.
7. Test mock fallback, real request mapping, auth failure, secret redaction, and policy invariance. Update [docs/connectors.md](docs/connectors.md).

## Add a dashboard component

1. Define a trusted component type and bounded structured data contract in `server/api/dashboard-schema.js`.
2. Resolve data through an allowlisted server source or validated inline data; never accept model-generated HTML, script, component code, or arbitrary URLs.
3. Implement the Web Component under `public/components/` using DOM nodes and `textContent` for untrusted values.
4. Register it in the application/dashboard renderer without adding a build step.
5. Add validator rejection tests, component behavior tests, and Playwright coverage. Update [docs/dashboards.md](docs/dashboards.md).

## Add a database migration

The schema bootstrap lives in `server/db/schema.sql`; additive compatibility work runs from `server/db/connection.js` before the current schema is applied.

- Prefer new tables, indexes, or nullable/defaulted columns.
- Never assume an existing table is empty.
- Preserve old data and provenance; use soft deletion or revision history where the domain requires it.
- Make startup migration idempotent.
- Add a test that constructs the previous schema/data shape, opens it through the normal startup path, and verifies both preservation and the new invariant.
- Consider backup/restore compatibility and document any rollback limitation.

## Security and privacy review

At minimum, ask:

- Can model or connector content become trusted instructions?
- Can browser-provided identity, voice confidence, or feedback weaken authorization?
- Can restricted context reach a remote planner, embedding provider, connector, log, event, or API response?
- Can a crash, timeout, duplicate tick, or restart repeat an external side effect?
- Can arbitrary HTML, JavaScript, unsafe object keys, or credential-bearing URLs cross a boundary?
- Does every persisted decision retain useful actor, correlation, source, and provenance data?

Report vulnerabilities privately as directed by [SECURITY.md](SECURITY.md). Never commit credentials, private owner data, live connector payloads, database snapshots, or a real `U2OS_HOME`.
