const path = require('path');

const SCHEMA_KINDS = [
  'solution',
  'app-wrapper',
  'module',
  'process',
  'template',
  'datasource',
  'client-overlay'
];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateRequiredString(doc, key, errors, label = key) {
  if (typeof doc[key] !== 'string' || !doc[key].trim()) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function validateSchemaVersion(doc, errors) {
  if (doc.schemaVersion !== '2026-03-14') {
    errors.push(`schemaVersion must be '2026-03-14'`);
  }
}

function policyChecksForDataSource(doc, errors, warnings) {
  if (doc.type === 'sql') {
    const query = String(doc.query || '');
    if (!query.trim()) {
      errors.push('dataSource.query is required for type=sql');
    }

    const dangerous = /(\bupdate\b|\binsert\b|\bdelete\b|\bdrop\b|\balter\b|\btruncate\b|\bcreate\b)/i;
    if (dangerous.test(query)) {
      errors.push('SQL query appears to be non-read-only (DML/DDL keywords detected)');
    }

    if (!/:tenantId\b/.test(query)) {
      errors.push('SQL query must include :tenantId for tenant scoping');
    }

    if (!/\blimit\b/i.test(query)) {
      warnings.push('SQL query has no LIMIT clause; consider bounding result size');
    }
  }

  if (doc.mode && doc.mode !== 'readOnly') {
    errors.push('dataSource.mode must be readOnly');
  }

  if (typeof doc.rowLimit === 'number' && doc.rowLimit > 1000) {
    warnings.push('rowLimit > 1000 may cause slow process bootstrap loads');
  }

  if (typeof doc.timeoutMs === 'number' && doc.timeoutMs > 5000) {
    warnings.push('timeoutMs > 5000 may hurt UX; consider a lower timeout');
  }
}

function validateDataSource(doc, errors, warnings) {
  if (!isObject(doc)) {
    errors.push('datasource must be an object');
    return;
  }

  validateSchemaVersion(doc, errors);
  if (!['sql', 'queryRef'].includes(doc.type)) {
    errors.push("type must be one of: 'sql', 'queryRef'");
  }
  validateRequiredString(doc, 'returns', errors);

  if (doc.type === 'sql') {
    validateRequiredString(doc, 'query', errors);
  }
  if (doc.type === 'queryRef') {
    validateRequiredString(doc, 'queryRef', errors);
  }

  policyChecksForDataSource(doc, errors, warnings);
}

function validateTemplate(doc, errors) {
  validateSchemaVersion(doc, errors);
  validateRequiredString(doc, 'id', errors);
  validateRequiredString(doc, 'title', errors);
  validateRequiredString(doc, 'componentTag', errors);
}

function validateProcess(doc, errors, warnings) {
  validateSchemaVersion(doc, errors);
  validateRequiredString(doc, 'id', errors);
  validateRequiredString(doc, 'moduleId', errors);
  validateRequiredString(doc, 'title', errors);
  if (!isObject(doc.template)) {
    errors.push('template must be an object');
  } else {
    validateRequiredString(doc.template, 'id', errors, 'template.id');
  }

  if (!isObject(doc.dataSource)) {
    errors.push('dataSource must be an object');
  } else {
    validateDataSource(doc.dataSource, errors, warnings);
  }
}

function validateModule(doc, errors, warnings) {
  validateSchemaVersion(doc, errors);
  validateRequiredString(doc, 'id', errors);
  validateRequiredString(doc, 'title', errors);
  if (!Array.isArray(doc.processes) || doc.processes.length === 0) {
    errors.push('processes must be a non-empty array');
  }

  for (const process of doc.processes || []) {
    if (isObject(process)) {
      validateProcess(process, errors, warnings);
    } else if (typeof process !== 'string') {
      errors.push('process entries must be process IDs or process objects');
    }
  }
}

function validateClientOverlay(doc, errors, warnings) {
  validateSchemaVersion(doc, errors);
  validateRequiredString(doc, 'clientId', errors);
  validateRequiredString(doc, 'baseAppId', errors);

  for (const mod of doc.customModules || []) {
    validateModule(mod, errors, warnings);
  }
  for (const process of doc.customProcesses || []) {
    validateProcess(process, errors, warnings);
  }
  for (const template of doc.customTemplates || []) {
    validateTemplate(template, errors);
  }
}

function validateAppWrapper(doc, errors, warnings) {
  validateSchemaVersion(doc, errors);
  if (!isObject(doc.app)) {
    errors.push('app must be an object');
  } else {
    validateRequiredString(doc.app, 'id', errors, 'app.id');
    validateRequiredString(doc.app, 'name', errors, 'app.name');
  }

  if (!Array.isArray(doc.modules) || doc.modules.length === 0) {
    errors.push('modules must be a non-empty array');
  } else {
    for (const mod of doc.modules) {
      validateModule(mod, errors, warnings);
    }
  }
}

function previewFor(kind, doc) {
  if (!isObject(doc)) return {};

  switch (kind) {
    case 'datasource':
      return {
        kind,
        returns: doc.returns || null,
        type: doc.type || null,
        hasTenantGuard: typeof doc.query === 'string' ? /:tenantId\b/.test(doc.query) : null,
        timeoutMs: doc.timeoutMs || null,
        rowLimit: doc.rowLimit || null
      };
    case 'template':
      return {
        kind,
        id: doc.id || null,
        title: doc.title || null,
        componentTag: doc.componentTag || null,
        slots: Object.keys(doc.slots || {})
      };
    case 'process':
      return {
        kind,
        id: doc.id || null,
        title: doc.title || null,
        moduleId: doc.moduleId || null,
        templateId: doc.template && doc.template.id ? doc.template.id : null,
        returns: doc.dataSource && doc.dataSource.returns ? doc.dataSource.returns : null
      };
    case 'module':
      return {
        kind,
        id: doc.id || null,
        title: doc.title || null,
        processCount: Array.isArray(doc.processes) ? doc.processes.length : 0
      };
    case 'solution':
    case 'app-wrapper':
      return {
        kind: kind === 'app-wrapper' ? 'solution' : kind,
        appId: doc.app && doc.app.id ? doc.app.id : null,
        appName: doc.app && doc.app.name ? doc.app.name : null,
        moduleCount: Array.isArray(doc.modules) ? doc.modules.length : 0
      };
    case 'client-overlay':
      return {
        kind,
        clientId: doc.clientId || null,
        baseAppId: doc.baseAppId || null,
        customModuleCount: Array.isArray(doc.customModules) ? doc.customModules.length : 0,
        customProcessCount: Array.isArray(doc.customProcesses) ? doc.customProcesses.length : 0
      };
    default:
      return { kind };
  }
}

function scaffold(kind, opts = {}) {
  const schemaVersion = '2026-03-14';
  const moduleId = opts.moduleId || 'support';
  const processId = opts.processId || `${moduleId}.inbox`;
  const templateId = opts.templateId || 'workspace.table-detail';

  const dataSource = {
    schemaVersion,
    type: 'sql',
    query: 'SELECT id, subject, status, priority FROM tickets WHERE tenant_id = :tenantId ORDER BY updated DESC LIMIT :limit',
    params: {
      tenantId: '$ctx.tenantId',
      limit: 100
    },
    returns: 'tickets',
    timeoutMs: 2000,
    rowLimit: 200,
    mode: 'readOnly',
    access: {
      rolesAny: ['owner', 'admin', 'staff'],
      tenantScope: 'currentTenant'
    }
  };

  if (kind === 'datasource') return dataSource;

  if (kind === 'template') {
    return {
      schemaVersion,
      id: templateId,
      title: 'Table + Detail Workspace',
      componentTag: 'bos-entity-form',
      componentProps: {
        entity: 'tickets'
      },
      slots: {
        headerActions: {
          type: 'action',
          required: false
        }
      }
    };
  }

  if (kind === 'process') {
    return {
      schemaVersion,
      id: processId,
      moduleId,
      title: 'Support Inbox',
      icon: 'mail',
      template: {
        id: templateId,
        url: '/app/templates/support-inbox'
      },
      dataSource
    };
  }

  if (kind === 'module') {
    return {
      schemaVersion,
      id: moduleId,
      title: 'Support',
      icon: 'headset',
      processes: [scaffold('process', opts)]
    };
  }

  if (kind === 'solution' || kind === 'app-wrapper') {
    return {
      schemaVersion,
      app: {
        id: opts.appId || 'default',
        name: 'Business Workspace'
      },
      modules: [scaffold('module', opts)],
      templateCatalog: [scaffold('template', opts)]
    };
  }

  if (kind === 'client-overlay') {
    return {
      schemaVersion,
      clientId: opts.clientId || 'demo-client',
      baseAppId: opts.baseAppId || 'default',
      processOverrides: [
        {
          processId,
          title: 'Priority Inbox',
          hidden: false
        }
      ],
      customProcesses: [scaffold('process', opts)]
    };
  }

  throw new Error(`Unknown schema kind '${kind}'`);
}

function sanitizeFileName(input, fallback) {
  const normalized = String(input || '').trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!normalized) return fallback;
  return normalized.endsWith('.json') ? normalized : `${normalized}.json`;
}

function getDefaultFileName(kind, document) {
  switch (kind) {
    case 'solution':
    case 'app-wrapper':
      return sanitizeFileName(document?.app?.id || 'app-wrapper', 'app-wrapper.json');
    case 'client-overlay': {
      const clientId = sanitizeFileName(document?.clientId || 'client', 'client');
      const baseAppId = sanitizeFileName(document?.baseAppId || 'default', 'default');
      return `${clientId}-${baseAppId}`.replace(/\.json/g, '') + '.json';
    }
    default:
      return sanitizeFileName(document?.id || kind, `${kind}.json`);
  }
}

function resolveSaveTarget({ kind, document, saveAs }) {
  const fileName = sanitizeFileName(saveAs, getDefaultFileName(kind, document));
  if (kind === 'solution' || kind === 'app-wrapper') {
    return path.join('config', 'solutions', fileName);
  }
  if (kind === 'client-overlay') {
    const clientKey = sanitizeFileName(document?.clientId || 'client', 'client').replace(/\.json$/i, '');
    return path.join('clients', clientKey, 'schemas', fileName);
  }
  return path.join('config', 'schemas', 'workbench', kind, fileName);
}

function lintAndPreview({ kind, document }) {
  if (!SCHEMA_KINDS.includes(kind)) {
    return { ok: false, errors: [`Unknown schema kind '${kind}'`], warnings: [], preview: {} };
  }

  const errors = [];
  const warnings = [];

  if (!isObject(document)) {
    errors.push('Document must be a JSON object');
    return { ok: false, errors, warnings, preview: {} };
  }

  switch (kind) {
    case 'solution':
    case 'app-wrapper':
      validateAppWrapper(document, errors, warnings);
      break;
    case 'module':
      validateModule(document, errors, warnings);
      break;
    case 'process':
      validateProcess(document, errors, warnings);
      break;
    case 'template':
      validateTemplate(document, errors, warnings);
      break;
    case 'datasource':
      validateDataSource(document, errors, warnings);
      break;
    case 'client-overlay':
      validateClientOverlay(document, errors, warnings);
      break;
    default:
      break;
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    preview: previewFor(kind, document)
  };
}

module.exports = {
  SCHEMA_KINDS,
  lintAndPreview,
  resolveSaveTarget,
  scaffold
};
