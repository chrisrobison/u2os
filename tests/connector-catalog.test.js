import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConnectorCatalog } from '../server/integrations/connector-catalog.js';

test('connector catalog has unique schema-renderable definitions and common planned integrations', () => {
  const catalog = getConnectorCatalog();
  assert.equal(catalog.version, 1);
  const ids = catalog.connectors.map((connector) => connector.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const connector of catalog.connectors) {
    assert.ok(connector.id && connector.name && connector.description);
    assert.ok(['available', 'planned'].includes(connector.status));
    assert.ok(['single', 'multiple'].includes(connector.accountMode));
    assert.ok(Array.isArray(connector.capabilities));
    assert.ok(Array.isArray(connector.setup.fields));
  }
  for (const id of ['google', 'imap', 'smtp', 'rss-atom', 'pop3', 'discord', 'whatsapp', 'imessage']) {
    assert.ok(ids.includes(id), `catalog should include ${id}`);
  }
});
