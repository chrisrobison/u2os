import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from '../router.js';
import { getVaultDir, ensureVaultLayout, setVaultDir, DEFAULT_ME_MD } from '../../vault/vault-dir.js';
import { indexVault, getLastVaultReport } from '../../vault/indexer.js';
import { exportMemoryToVault } from '../../vault/exporter.js';
import { loadPolicies, getPolicySourceStatus } from '../../policy/policies-loader.js';
import { getMcpStatus, startMcpServers, unloadMcpServers } from '../../mcp/mcp-tools.js';
import { inspectVaultCandidate } from '../../vault/vault-inspect.js';
import { getOnboardingStatus } from '../../onboarding/onboarding-config.js';
import { readJournal } from '../../vault/journal.js';
import { parseMarkdown, MAX_VAULT_FILE_BYTES } from '../../vault/markdown.js';
import { getDb, getDataDir } from '../../db/connection.js';
import { getEntity, findEntities } from '../../memory/entity-store.js';
import { vaultTargetForEntity } from '../../vault/writeback.js';
import { createVaultRecord, updateVaultRecord, readVaultRecord, RECORD_FIELDS } from '../../vault/records.js';
import { listStarterContent, installStarterContent, STARTER_CONTENT } from '../../vault/starter-content.js';

const ME_FILE = 'me.md';

// Owner-only (router default). The report names vault-relative paths and
// parse errors, never file contents.
export function registerVaultRoutes(router, { eventBus, toolRegistry }) {
  router.get('/api/vault', async (_req, res) => {
    loadPolicies(); // refresh the policy file status without changing the running engine
    sendJson(res, 200, { vaultDir: getVaultDir(), lastIndex: getLastVaultReport(), policy: getPolicySourceStatus(), mcp: getMcpStatus() });
  });

  // The owner's journal: what U2OS did on their behalf, newest first.
  router.get('/api/vault/journal', async (req, res) => {
    try {
      sendJson(res, 200, readJournal({ month: req.query?.month || null, limit: req.query?.limit }));
    } catch (error) {
      if (error.code !== 'INVALID_MONTH') throw error;
      sendJson(res, 400, { error: error.message });
    }
  });

  // Restarts the MCP servers after the owner edits mcp.yaml.
  router.post('/api/vault/mcp/restart', async (_req, res) => {
    sendJson(res, 200, { mcp: await startMcpServers({ toolRegistry }) });
  });

  // Creating and editing people and projects from the browser (#438, #439).
  // The vault file is written first, then indexed, exactly like the other owner
  // edits (docs/vault.md, "Editing from the UI"). Nothing here goes through the
  // agent: the owner is editing their own files.
  const recordRoute = async (res, handler) => {
    try { return await handler(); } catch (error) {
      if (error.code === 'VAULT_WRITEBACK') return sendJson(res, error.status || 409, { error: error.message, code: error.code });
      throw error;
    }
  };

  router.post('/api/vault/records', async (req, res) => recordRoute(res, () => {
    const { type } = req.body || {};
    if (!Object.hasOwn(RECORD_FIELDS, type)) return sendJson(res, 400, { error: `type must be one of: ${Object.keys(RECORD_FIELDS).join(', ')}` });
    const { path: relativePath, entityId } = createVaultRecord(type, req.body);
    const report = indexVault({ eventBus });
    const problem = report.errors.find((item) => item.path === relativePath);
    if (problem) return sendJson(res, 500, { error: `The file was written but could not be indexed: ${problem.error}` });
    sendJson(res, 201, { entity: getEntity(entityId), path: relativePath });
  }));

  // People or projects with the values their files hold, for the list views.
  // Bounded, and never returns notes (the dialog fetches those one at a time).
  router.get('/api/vault/records', async (req, res) => recordRoute(res, () => {
    const type = req.query.type;
    if (!Object.hasOwn(RECORD_FIELDS, type)) return sendJson(res, 400, { error: `type must be one of: ${Object.keys(RECORD_FIELDS).join(', ')}` });
    const records = [];
    for (const entity of findEntities({ type }).slice(0, 500)) {
      const target = vaultTargetForEntity(entity.id);
      if (target?.owner) continue; // the owner is not one of their own contacts
      let fields = {};
      let vaultBacked = false;
      if (target) {
        try { fields = readVaultRecord(entity.id, type)?.fields ?? {}; vaultBacked = true; } catch { /* unreadable file: still list the record */ }
      }
      records.push({ id: entity.id, name: entity.name, vaultBacked, fields });
    }
    records.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    sendJson(res, 200, { records });
  }));

  router.get('/api/vault/records/:id', async (req, res) => recordRoute(res, () => {
    const entity = getEntity(req.params.id);
    if (!entity) return sendJson(res, 404, { error: 'Not Found' });
    if (!Object.hasOwn(RECORD_FIELDS, entity.type)) return sendJson(res, 400, { error: `${entity.type} records cannot be edited here` });
    let record = null;
    try { record = readVaultRecord(entity.id, entity.type); } catch (error) {
      if (error.code === 'VAULT_INVALID' || error.code === 'ENOENT') return sendJson(res, 409, { error: `${entity.name}'s vault file cannot be read: ${error.message}` });
      throw error;
    }
    // vaultBacked: false means the record exists only in the database.
    sendJson(res, 200, { entity, vaultBacked: Boolean(record), name: record?.name ?? entity.name, fields: record?.fields ?? {}, notes: record?.notes ?? '' });
  }));

  router.patch('/api/vault/records/:id', async (req, res) => recordRoute(res, () => {
    const entity = getEntity(req.params.id);
    if (!entity) return sendJson(res, 404, { error: 'Not Found' });
    if (!Object.hasOwn(RECORD_FIELDS, entity.type)) return sendJson(res, 400, { error: `${entity.type} records cannot be edited here` });
    const result = updateVaultRecord(entity.id, entity.type, req.body || {});
    if (!result) {
      return sendJson(res, 409, {
        error: 'This record is stored only in the database, not in your vault. Export your memory to the vault first (Vault view), then edit it.',
        code: 'NOT_VAULT_BACKED',
      });
    }
    const report = indexVault({ eventBus });
    const problem = report.errors.find((item) => item.path === result.path);
    if (problem) return sendJson(res, 409, { error: `${result.path} could not be indexed after the edit: ${problem.error}` });
    sendJson(res, 200, { entity: getEntity(entity.id), path: result.path });
  }));

  router.post('/api/vault/reindex', async (_req, res) => {
    sendJson(res, 200, { report: indexVault({ eventBus }) });
  });

  // Writes database memory into new vault files (never overwriting), then
  // indexes them so the files become the authority for those records.
  router.post('/api/vault/export', async (_req, res) => {
    const exported = exportMemoryToVault();
    sendJson(res, 200, { export: exported, index: indexVault({ eventBus }) });
  });

  // Onboarding step 2 ("who you are"): raw me.md content, for a plain-text
  // editor rather than the per-fact Memory view. Never written until the
  // owner actually saves (see docs/vault.md: "me.md is applied once an
  // owner account exists").
  router.get('/api/vault/me', async (_req, res) => {
    const file = path.join(getVaultDir(), ME_FILE);
    try {
      sendJson(res, 200, { content: fs.readFileSync(file, 'utf8'), exists: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      sendJson(res, 200, { content: DEFAULT_ME_MD, exists: false });
    }
  });

  router.put('/api/vault/me', async (req, res) => {
    const content = req.body?.content;
    if (typeof content !== 'string') return sendJson(res, 400, { error: 'content must be a string' });
    if (Buffer.byteLength(content, 'utf8') > MAX_VAULT_FILE_BYTES) {
      return sendJson(res, 400, { error: `content exceeds ${MAX_VAULT_FILE_BYTES} bytes` });
    }
    // Syntactically broken YAML is refused outright, the same "never write
    // an unparseable file" stance as the fact-level write-back path (docs/
    // vault.md). A semantically invalid file (bad classification, etc.) is
    // still saved -- this is a raw-text editor, the same as opening me.md in
    // any other editor -- but reported below via the reindex report so the
    // wizard never silently accepts it.
    try {
      parseMarkdown(content);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    const vaultDir = ensureVaultLayout();
    fs.writeFileSync(path.join(vaultDir, ME_FILE), content, { mode: 0o600 });
    const report = indexVault({ eventBus });
    const meError = report.errors.find((entry) => entry.path === ME_FILE)?.error || null;
    sendJson(res, 200, { content, exists: true, report, error: meError });
  });

  // Onboarding step 1: choose where the vault lives (#413), or point U2OS at
  // an existing vault (#423). Choosing never deletes, moves or rewrites a file:
  // it only changes where U2OS looks.
  const resolveCandidate = (requested) => {
    if (typeof requested !== 'string' || !requested.trim()) return { error: { status: 400, body: { error: 'vaultDir is required', code: 'INVALID_INPUT' } } };
    const resolved = path.resolve(getDataDir(), requested.trim());
    if (resolved === path.parse(resolved).root) return { error: { status: 400, body: { error: 'vaultDir must not resolve to a filesystem root', code: 'INVALID_INPUT' } } };
    return { resolved };
  };

  // Read-only summary of a candidate folder so the owner can see what U2OS
  // found before committing: names and counts only, nothing is created or run.
  router.get('/api/vault/inspect', async (req, res) => {
    const candidate = resolveCandidate(req.query?.path);
    if (candidate.error) return sendJson(res, candidate.error.status, candidate.error.body);
    sendJson(res, 200, { ...inspectVaultCandidate(candidate.resolved), envOverride: Boolean(process.env.U2OS_VAULT), current: candidate.resolved === getVaultDir() });
  });

  router.post('/api/vault/location', async (req, res) => {
    if (process.env.U2OS_VAULT) {
      // U2OS_VAULT always overrides config.json's vaultDir in getVaultDir()
      // (server/vault/vault-dir.js), so writing vaultDir here would be a
      // silent no-op: the response would claim success while every future
      // getVaultDir() call kept resolving to the env-pinned path. Refuse
      // outright rather than report a relocation that never actually takes
      // effect (docs/onboarding.md).
      return sendJson(res, 409, { error: 'U2OS_VAULT is set and always overrides the configured vault location; unset it to relocate the vault through this API.', code: 'VAULT_ENV_OVERRIDE' });
    }
    const candidate = resolveCandidate(req.body?.vaultDir);
    if (candidate.error) return sendJson(res, candidate.error.status, candidate.error.body);
    const { resolved } = candidate;
    const dataDir = getDataDir();
    const currentVaultDir = getVaultDir();
    const currentHasContent = () => fs.existsSync(path.join(currentVaultDir, ME_FILE))
      || Boolean(getDb().prepare("SELECT 1 FROM facts WHERE source LIKE 'vault:%' LIMIT 1").get());

    if (req.body?.adopt === true) {
      // Explicit owner intent to switch vaults. While onboarding is still in
      // progress the previous vault may hold content (a saved me.md, starter
      // routines); its files are left exactly where they are. Once onboarding
      // is complete a populated vault is protected as before.
      const inspection = inspectVaultCandidate(resolved);
      if (resolved === currentVaultDir) return sendJson(res, 200, { vaultDir: resolved, previousVaultDir: currentVaultDir, unchanged: true, inspection, mcp: getMcpStatus() });
      if (getOnboardingStatus().completed && currentHasContent()) {
        return sendJson(res, 409, { error: 'The current vault already has records; once setup is complete it cannot be switched from here.', code: 'VAULT_NOT_EMPTY' });
      }
      if (inspection.exists && !inspection.isDirectory) return sendJson(res, 400, { error: `${resolved} exists and is not a directory`, code: 'TARGET_NOT_DIRECTORY' });
      if (inspection.exists && !inspection.writable) return sendJson(res, 400, { error: `${resolved} is not writable`, code: 'TARGET_NOT_WRITABLE' });
      if (inspection.exists && !inspection.empty && !inspection.looksLikeVault && req.body?.useNonEmpty !== true) {
        return sendJson(res, 409, { error: `${resolved} has files but does not look like a U2OS vault; confirm to use it anyway`, code: 'TARGET_NOT_A_VAULT' });
      }
      if (!inspection.exists) {
        try { fs.mkdirSync(resolved, { recursive: true }); }
        catch (error) { return sendJson(res, 400, { error: `Could not create ${resolved}: ${error.message}`, code: 'TARGET_CREATE_FAILED' }); }
      }
      setVaultDir(resolved, dataDir);
      ensureVaultLayout(resolved);
      // The previous vault's tool servers must not keep serving. The new
      // vault's own servers are programs its mcp.yaml would launch, so they
      // start only when the owner asked for that.
      await unloadMcpServers({ toolRegistry, vaultDir: resolved });
      if (req.body?.startToolServers === true && inspection.mcpServers.length) await startMcpServers({ toolRegistry, vaultDir: resolved });
      return sendJson(res, 200, {
        vaultDir: resolved, previousVaultDir: currentVaultDir, unchanged: false,
        adopted: inspection.looksLikeVault && !inspection.empty, inspection,
        report: indexVault({ eventBus }), mcp: getMcpStatus(),
      });
    }

    if (currentHasContent()) {
      return sendJson(res, 409, { error: 'The current vault already has records; relocation is only allowed for an empty vault.', code: 'VAULT_NOT_EMPTY' });
    }

    let stat = null;
    try { stat = fs.lstatSync(resolved); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && !stat.isDirectory()) {
      return sendJson(res, 400, { error: `${resolved} exists and is not a directory`, code: 'TARGET_NOT_DIRECTORY' });
    }
    if (stat) {
      if (fs.readdirSync(resolved).length) {
        return sendJson(res, 409, { error: `${resolved} is not empty`, code: 'TARGET_NOT_EMPTY' });
      }
      try { fs.accessSync(resolved, fs.constants.W_OK); }
      catch { return sendJson(res, 400, { error: `${resolved} is not writable`, code: 'TARGET_NOT_WRITABLE' }); }
    } else {
      try { fs.mkdirSync(resolved, { recursive: true }); }
      catch (error) { return sendJson(res, 400, { error: `Could not create ${resolved}: ${error.message}`, code: 'TARGET_CREATE_FAILED' }); }
    }

    setVaultDir(resolved, dataDir);
    ensureVaultLayout(resolved);
    sendJson(res, 200, { vaultDir: resolved, report: indexVault({ eventBus }) });
  });

  // Onboarding step 5: the starter routine/skill catalog from #412, plus
  // which of those are already present in the live vault.
  router.get('/api/vault/starter-routines', async (_req, res) => {
    const vaultDir = getVaultDir();
    const catalog = listStarterContent();
    const installed = catalog.filter((item) => item.files.every((file) => fs.existsSync(path.join(vaultDir, file)))).map((item) => item.id);
    sendJson(res, 200, { catalog, installed });
  });

  router.post('/api/vault/starter-routines', async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: 'ids must be a non-empty array' });
    const known = new Set(STARTER_CONTENT.map((item) => item.id));
    for (const id of ids) {
      if (typeof id !== 'string' || !known.has(id)) return sendJson(res, 400, { error: `Unknown starter content id "${id}"` });
    }
    const vaultDir = ensureVaultLayout();
    sendJson(res, 200, { results: ids.map((id) => installStarterContent(id, vaultDir)) });
  });
}
