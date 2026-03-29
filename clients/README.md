# Client Settings

Per-client overrides live in:

- `clients/<CLIENT_NAME>/settings.json`
- `clients/<CLIENT_NAME>/overlay.json` (optional composable solution overlay)

`<CLIENT_NAME>` is normalized to lowercase kebab-case from the control-plane customer name.
Example: `Acme Wellness Group` => `clients/acme-wellness-group/settings.json`.

Effective settings are merged as:

1. `config/settings.json` (global defaults)
2. `clients/<CLIENT_NAME>/settings.json` (client overrides)

Object keys merge deeply. Scalar values and arrays in client settings replace global values.

When present, `overlay.json` is applied on top of the resolved solution manifest for that client.
