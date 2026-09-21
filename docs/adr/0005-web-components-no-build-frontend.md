# 0005 — Web Components and a no-build frontend

## Status

Accepted

## Context

U2OS needs a durable browser client that is easy to inspect, self-host, and evolve without coupling the persistent service to a large frontend toolchain. The interface must render model-selected structures without executing model-generated code.

## Decision

Use vanilla JavaScript, native ES modules, Web Components, HTML, and CSS served directly by the Node service. Do not require a frontend build step or introduce a component framework. Dynamic dashboards select only registered components and validated structured inputs; untrusted text is rendered as text, never arbitrary HTML or JavaScript.

## Consequences

- Development and deployment do not require bundling or generated frontend artifacts.
- Components expose explicit browser-standard boundaries and can be tested against the real server with Playwright.
- Shared conventions must be maintained without a framework enforcing them.
- Compatibility targets follow browser web standards rather than framework abstractions.
- Rich dashboard behavior requires trusted components and server-side schemas rather than model-authored markup.

See [dashboards](../dashboards.md) and [architecture](../architecture.md).
