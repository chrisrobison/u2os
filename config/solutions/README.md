# Solution Manifests

`config/solutions/*.json` are canonical composable manifests.

A solution composes:

- Business Modules
- Processes
- Templates
- optional Process Data Sources

Runtime navigation at `/app` is materialized from these manifests through `core/registry.js`.
Legacy runtime app definitions in `config/apps` are still supported through compatibility adapters.
