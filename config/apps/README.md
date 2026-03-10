# App Definitions

App definitions drive the user-facing runtime at `/app`.

## File Location

- Directory: `config/apps`
- Default app file: `config/apps/default.json`
- Override with env vars:
  - `APPS_DIR` (default `config/apps`)
  - `DEFAULT_APP_ID` (default `default`)

## Shape (v1)

```json
{
  "version": "1.0",
  "app": {
    "id": "default",
    "name": "Business Workspace"
  },
  "navigation": [
    {
      "id": "customers",
      "title": "Customers",
      "componentTag": "bos-entity-form",
      "componentProps": { "entity": "customers" },
      "hooks": {
        "onLoad": [{ "type": "client", "name": "client.notifyLoaded" }],
        "afterSave": [{ "type": "server", "name": "server.auditSave" }]
      }
    }
  ]
}
```

## Hook Events

Allowed hook event keys:

- `onLoad`
- `onView`
- `beforeSave`
- `afterSave`
- `onSave`

Hook item format:

```json
{ "type": "client|server", "name": "hook.name", "options": {} }
```

## APIs

- `GET /api/apps` list available app IDs
- `GET /api/apps/:appId` fetch validated app definition
- `POST /api/apps/:appId/hooks/:hookName` execute an allowlisted server hook
