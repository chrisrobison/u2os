# Architecture Language

This document defines the canonical hierarchy and terms used in U2OS.

## Canonical Terms

1. Kernel
- Shared runtime services in `/core`.
- Provides auth, tenancy, CRUD, event bus, observability, and routing foundations.

2. Capability Package
- Executable extension bundle in `/modules/<package-id>/`.
- May contribute routes, events, jobs, and migrations.
- Must declare permissions in `manifest.json`.

3. Solution
- Composition root for a business experience.
- Declared in `config/solutions/<solution-id>.json`.
- Assembles Business Modules, Processes, and Templates.

4. Business Module
- Domain grouping inside a Solution (e.g. Sales, Operations, Support).
- Owns related Processes and visibility/order metadata.

5. Process
- Concrete workflow/action inside a Business Module.
- Binds metadata, hooks, optional data source, and a Template.

6. Template
- Reusable UI workspace implementation used by Processes.
- Declares the runtime component tag and default props.

7. Client Overlay
- Per-client customization layer in `clients/<client-id>/overlay.json`.
- Overrides/extends Solution modules/processes/templates without cross-client leakage.

## Hierarchy

`Tenant -> Client Overlay -> Solution -> Business Module -> Process -> Template`

Infrastructure layer (orthogonal to hierarchy):

`Kernel + Capability Packages`

## Runtime Contract Compatibility

U2OS currently supports both:

- Legacy runtime app definitions (`config/apps/*.json`), and
- Canonical solution manifests (`config/solutions/*.json`).

The solution registry adapts legacy app navigation into Process/Template structures and adapts effective Solutions back into runtime navigation so migration can be incremental.

## Resolution Order

Effective composition resolution order is:

`core defaults < solution manifest < client overlay`

No cross-client imports are allowed.
