const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { validateAppDefinition } = require('./appDefinitions');
const { toClientKey, deepMerge } = require('./settings');

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJsonSyncIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

async function listJsonBasenames(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function normalizeOverlayDocument(overlay, { clientKey, baseAppId }) {
  if (!isObject(overlay)) return null;
  if (typeof overlay.schemaVersion !== 'string') return null;
  if (typeof overlay.clientId !== 'string') {
    overlay.clientId = clientKey;
  }
  if (typeof overlay.baseAppId !== 'string') {
    overlay.baseAppId = baseAppId;
  }
  return overlay;
}

function loadClientOverlay({ clientsDir, clientName, baseAppId }) {
  const clientKey = toClientKey(clientName);
  if (!clientKey) {
    return {
      clientKey: null,
      overlay: null,
      source: null
    };
  }

  const root = path.resolve(process.cwd(), clientsDir, clientKey);
  const candidates = [
    path.join(root, 'overlay.json'),
    path.join(root, 'schemas', `${baseAppId}.overlay.json`),
    path.join(root, 'schemas', `${clientKey}-${baseAppId}.json`)
  ];

  for (const candidate of candidates) {
    const parsed = readJsonSyncIfExists(candidate);
    if (!parsed) continue;
    const normalized = normalizeOverlayDocument(parsed, { clientKey, baseAppId });
    if (!normalized) continue;
    if (normalized.baseAppId !== baseAppId) continue;

    return {
      clientKey,
      overlay: normalized,
      source: candidate
    };
  }

  return {
    clientKey,
    overlay: null,
    source: null
  };
}

function walkNavigation(items, visitor, parent = null, depth = 0) {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    visitor(item, { parent, index: i, depth });
    if (Array.isArray(item.children) && item.children.length > 0) {
      walkNavigation(item.children, visitor, item, depth + 1);
    }
  }
}

function legacyAppToSolution(appDefinition) {
  const appId = appDefinition.app.id;
  const modules = [];
  const templateCatalog = [];
  const processCatalog = [];

  function makeTemplateFromLeaf(leaf) {
    const templateId = `legacy.${appId}.${leaf.id}`;
    const existing = templateCatalog.find((entry) => entry.id === templateId);
    if (!existing) {
      templateCatalog.push({
        schemaVersion: '2026-03-14',
        id: templateId,
        title: `${leaf.title} Template`,
        componentTag: leaf.componentTag || 'bos-entity-form',
        componentProps: { ...(leaf.componentProps || {}) }
      });
    }
    return templateId;
  }

  function processFromLeaf(leaf, moduleId, order) {
    const templateId = makeTemplateFromLeaf(leaf);
    return {
      schemaVersion: '2026-03-14',
      id: leaf.id,
      moduleId,
      title: leaf.title,
      description: leaf.description || '',
      icon: leaf.icon || null,
      order,
      hooks: leaf.hooks || {},
      template: {
        id: templateId,
        props: { ...(leaf.componentProps || {}) }
      }
    };
  }

  const directLeaves = [];

  for (let index = 0; index < appDefinition.navigation.length; index += 1) {
    const navItem = appDefinition.navigation[index];
    if (Array.isArray(navItem.children) && navItem.children.length > 0) {
      const moduleEntry = {
        schemaVersion: '2026-03-14',
        id: navItem.id,
        title: navItem.title,
        icon: navItem.icon || null,
        order: index,
        processes: []
      };

      for (let childIndex = 0; childIndex < navItem.children.length; childIndex += 1) {
        const child = navItem.children[childIndex];
        if (Array.isArray(child.children) && child.children.length > 0) {
          walkNavigation(child.children, (leaf, ctx) => {
            if (Array.isArray(leaf.children) && leaf.children.length > 0) return;
            const process = processFromLeaf(leaf, navItem.id, childIndex + ctx.index);
            moduleEntry.processes.push(process);
            processCatalog.push(process);
          }, child, 2);
          continue;
        }

        const process = processFromLeaf(child, navItem.id, childIndex);
        moduleEntry.processes.push(process);
        processCatalog.push(process);
      }

      modules.push(moduleEntry);
      continue;
    }

    directLeaves.push({ navItem, index });
  }

  if (directLeaves.length > 0) {
    const workspace = {
      schemaVersion: '2026-03-14',
      id: 'workspace',
      title: 'Workspace',
      icon: 'grid',
      order: modules.length,
      processes: []
    };

    for (const { navItem, index } of directLeaves) {
      const process = processFromLeaf(navItem, 'workspace', index);
      workspace.processes.push(process);
      processCatalog.push(process);
    }

    modules.push(workspace);
  }

  return {
    schemaVersion: '2026-03-14',
    app: {
      id: appDefinition.app.id,
      name: appDefinition.app.name,
      description: appDefinition.app.description || ''
    },
    modules,
    processCatalog,
    templateCatalog,
    meta: {
      source: 'legacy-app-definition'
    }
  };
}

function indexTemplates(solutionDoc) {
  const map = new Map();
  for (const template of solutionDoc.templateCatalog || []) {
    map.set(template.id, template);
  }
  return map;
}

function materializeProcess(moduleEntry, processEntry, templatesById) {
  const templateId = processEntry.template && processEntry.template.id;
  const template = templateId ? templatesById.get(templateId) : null;
  const componentTag = processEntry.componentTag
    || (template && template.componentTag)
    || 'bos-entity-form';

  const componentProps = deepMerge(
    (template && template.componentProps) || {},
    (processEntry.template && processEntry.template.props) || {}
  );

  return {
    id: processEntry.id,
    title: processEntry.title,
    description: processEntry.description || '',
    icon: processEntry.icon || null,
    order: typeof processEntry.order === 'number' ? processEntry.order : 0,
    moduleId: moduleEntry.id,
    hooks: processEntry.hooks || {},
    dataSource: processEntry.dataSource || null,
    template: {
      id: templateId || null,
      componentTag,
      componentProps
    }
  };
}

function normalizeSolutionStructure(doc) {
  const templatesById = indexTemplates(doc);
  const processesById = new Map();

  for (const process of doc.processCatalog || []) {
    if (process && process.id) {
      processesById.set(process.id, process);
    }
  }

  const modules = (doc.modules || []).map((moduleEntry) => {
    const processRefs = Array.isArray(moduleEntry.processes) ? moduleEntry.processes : [];
    const processes = processRefs
      .map((entry) => {
        const process = typeof entry === 'string' ? processesById.get(entry) : entry;
        if (!process || !process.id) return null;
        return materializeProcess(moduleEntry, process, templatesById);
      })
      .filter(Boolean)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

    return {
      id: moduleEntry.id,
      title: moduleEntry.title,
      icon: moduleEntry.icon || null,
      order: typeof moduleEntry.order === 'number' ? moduleEntry.order : 0,
      hidden: Boolean(moduleEntry.hidden),
      processes
    };
  })
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

  return {
    schemaVersion: doc.schemaVersion || '2026-03-14',
    app: {
      id: doc.app.id,
      name: doc.app.name,
      description: doc.app.description || ''
    },
    modules,
    templateCatalog: doc.templateCatalog || []
  };
}

function applyClientOverlay(baseSolution, overlayDoc) {
  if (!overlayDoc) return normalizeSolutionStructure(baseSolution);

  const next = {
    ...baseSolution,
    modules: [...(baseSolution.modules || [])],
    processCatalog: [...(baseSolution.processCatalog || [])],
    templateCatalog: [...(baseSolution.templateCatalog || [])]
  };

  const moduleById = new Map(next.modules.map((mod) => [mod.id, mod]));
  const processById = new Map();

  for (const mod of next.modules) {
    for (const process of mod.processes || []) {
      if (isObject(process)) {
        processById.set(process.id, process);
      }
    }
  }

  for (const process of next.processCatalog) {
    if (isObject(process) && process.id) {
      processById.set(process.id, process);
    }
  }

  for (const patch of overlayDoc.moduleOverrides || []) {
    const target = moduleById.get(patch.moduleId);
    if (!target) continue;
    if (typeof patch.title === 'string') target.title = patch.title;
    if (typeof patch.icon === 'string') target.icon = patch.icon;
    if (typeof patch.order === 'number') target.order = patch.order;
    if (typeof patch.hidden === 'boolean') target.hidden = patch.hidden;
  }

  for (const patch of overlayDoc.processOverrides || []) {
    const target = processById.get(patch.processId);
    if (!target) continue;
    if (typeof patch.title === 'string') target.title = patch.title;
    if (typeof patch.icon === 'string') target.icon = patch.icon;
    if (typeof patch.order === 'number') target.order = patch.order;
    if (typeof patch.hidden === 'boolean') target.hidden = patch.hidden;
    if (typeof patch.templateId === 'string') {
      target.template = {
        ...(target.template || {}),
        id: patch.templateId
      };
    }
  }

  if (Array.isArray(overlayDoc.customTemplates) && overlayDoc.customTemplates.length > 0) {
    next.templateCatalog.push(...overlayDoc.customTemplates);
  }

  if (Array.isArray(overlayDoc.customProcesses) && overlayDoc.customProcesses.length > 0) {
    next.processCatalog.push(...overlayDoc.customProcesses);
  }

  if (Array.isArray(overlayDoc.customModules) && overlayDoc.customModules.length > 0) {
    next.modules.push(...overlayDoc.customModules);
  }

  return normalizeSolutionStructure(next);
}

function solutionToRuntimeApp(solutionDoc) {
  const navigation = [];

  for (const moduleEntry of solutionDoc.modules || []) {
    if (moduleEntry.hidden) continue;

    const children = [];
    for (const process of moduleEntry.processes || []) {
      if (process.hidden) continue;
      children.push({
        id: process.id,
        title: process.title,
        icon: process.icon || undefined,
        componentTag: process.template.componentTag,
        componentProps: process.template.componentProps || {},
        hooks: process.hooks || {},
        meta: {
          moduleId: moduleEntry.id,
          templateId: process.template.id,
          dataSource: process.dataSource || null
        }
      });
    }

    if (children.length === 0) continue;

    if (moduleEntry.id === 'workspace') {
      navigation.push(...children);
      continue;
    }

    navigation.push({
      id: moduleEntry.id,
      title: moduleEntry.title,
      icon: moduleEntry.icon || undefined,
      children
    });
  }

  return {
    version: '1.1',
    app: {
      id: solutionDoc.app.id,
      name: solutionDoc.app.name,
      description: solutionDoc.app.description || ''
    },
    navigation
  };
}

function isLegacyAppDefinition(doc) {
  return isObject(doc)
    && typeof doc.version === 'string'
    && isObject(doc.app)
    && Array.isArray(doc.navigation);
}

function isSolutionDefinition(doc) {
  return isObject(doc)
    && isObject(doc.app)
    && Array.isArray(doc.modules)
    && typeof doc.schemaVersion === 'string';
}

function createSolutionRegistry({ appsDir, solutionsDir, clientsDir }) {
  const absoluteAppsDir = path.resolve(process.cwd(), appsDir);
  const absoluteSolutionsDir = path.resolve(process.cwd(), solutionsDir);

  async function readJsonById(baseDir, id) {
    const filePath = path.join(baseDir, `${id}.json`);
    const raw = await fsp.readFile(filePath, 'utf8');
    return { parsed: JSON.parse(raw), filePath };
  }

  async function loadBaseSolution(solutionId) {
    const { parsed, filePath } = await readJsonById(absoluteSolutionsDir, solutionId);
    if (!isSolutionDefinition(parsed)) {
      throw new Error(`Invalid solution manifest '${solutionId}'`);
    }
    return {
      solution: parsed,
      source: filePath,
      sourceModel: 'solution'
    };
  }

  async function loadLegacyApp(appId) {
    const { parsed, filePath } = await readJsonById(absoluteAppsDir, appId);
    if (!isLegacyAppDefinition(parsed)) {
      throw new Error(`Invalid runtime app definition '${appId}'`);
    }
    validateAppDefinition(parsed);
    return {
      appDefinition: parsed,
      source: filePath,
      sourceModel: 'legacy-app'
    };
  }

  async function listRuntimeAppIds() {
    const [legacyIds, solutionIds] = await Promise.all([
      listJsonBasenames(absoluteAppsDir),
      listJsonBasenames(absoluteSolutionsDir)
    ]);
    return Array.from(new Set([...legacyIds, ...solutionIds])).sort();
  }

  async function listSolutionIds() {
    return listJsonBasenames(absoluteSolutionsDir);
  }

  async function loadEffectiveSolution(appOrSolutionId, options = {}) {
    const clientName = options.clientName || null;

    try {
      const { solution, source, sourceModel } = await loadBaseSolution(appOrSolutionId);
      const overlayInfo = loadClientOverlay({
        clientsDir,
        clientName,
        baseAppId: solution.app.id
      });

      const effective = applyClientOverlay(solution, overlayInfo.overlay);
      return {
        appId: solution.app.id,
        sourceModel,
        source,
        clientKey: overlayInfo.clientKey,
        overlaySource: overlayInfo.source,
        overlayApplied: Boolean(overlayInfo.overlay),
        solution: effective
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const legacy = await loadLegacyApp(appOrSolutionId);
    const baseSolution = legacyAppToSolution(legacy.appDefinition);
    const overlayInfo = loadClientOverlay({
      clientsDir,
      clientName,
      baseAppId: baseSolution.app.id
    });

    const effective = applyClientOverlay(baseSolution, overlayInfo.overlay);
    return {
      appId: baseSolution.app.id,
      sourceModel: legacy.sourceModel,
      source: legacy.source,
      clientKey: overlayInfo.clientKey,
      overlaySource: overlayInfo.source,
      overlayApplied: Boolean(overlayInfo.overlay),
      solution: effective
    };
  }

  async function loadRuntimeApp(appId, options = {}) {
    try {
      const legacy = await loadLegacyApp(appId);
      const asSolution = legacyAppToSolution(legacy.appDefinition);
      const overlayInfo = loadClientOverlay({
        clientsDir,
        clientName: options.clientName || null,
        baseAppId: legacy.appDefinition.app.id
      });

      const effective = applyClientOverlay(asSolution, overlayInfo.overlay);
      const runtime = solutionToRuntimeApp(effective);
      validateAppDefinition(runtime);

      return {
        appDefinition: runtime,
        sourceModel: legacy.sourceModel,
        source: legacy.source,
        overlayApplied: Boolean(overlayInfo.overlay),
        overlaySource: overlayInfo.source,
        solution: effective
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const effective = await loadEffectiveSolution(appId, options);
    const runtime = solutionToRuntimeApp(effective.solution);
    validateAppDefinition(runtime);

    return {
      appDefinition: runtime,
      sourceModel: effective.sourceModel,
      source: effective.source,
      overlayApplied: effective.overlayApplied,
      overlaySource: effective.overlaySource,
      solution: effective.solution
    };
  }

  return {
    listRuntimeAppIds,
    listSolutionIds,
    loadRuntimeApp,
    loadEffectiveSolution
  };
}

module.exports = {
  createSolutionRegistry,
  legacyAppToSolution,
  solutionToRuntimeApp,
  applyClientOverlay,
  loadClientOverlay
};
