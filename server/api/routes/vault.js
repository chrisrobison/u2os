import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from '../router.js';
import { getVaultDir, ensureVaultLayout, setVaultDir, DEFAULT_ME_MD } from '../../vault/vault-dir.js';
import { indexVault, getLastVaultReport } from '../../vault/indexer.js';
import { exportMemoryToVault } from '../../vault/exporter.js';
import { loadPolicies, getPolicySourceStatus } from '../../policy/policies-loader.js';
import { getMcpStatus, startMcpServers } from '../../mcp/mcp-tools.js';
import { readJournal } from '../../vault/journal.js';
import { parseMarkdown, MAX_VAULT_FILE_BYTES } from '../../vault/markdown.js';
import { getDb, getDataDir } from '../../db/connection.js';
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

  // Onboarding step 1: relocate the vault, but only while it is still
  // empty, so this can never risk an existing owner's data (#413).
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
    const requested = req.body?.vaultDir;
    if (typeof requested !== 'string' || !requested.trim()) {
      return sendJson(res, 400, { error: 'vaultDir is required', code: 'INVALID_INPUT' });
    }
    const dataDir = getDataDir();
    const resolved = path.resolve(dataDir, requested.trim());
    if (resolved === path.parse(resolved).root) {
      return sendJson(res, 400, { error: 'vaultDir must not resolve to a filesystem root', code: 'INVALID_INPUT' });
    }

    const currentVaultDir = getVaultDir();
    if (fs.existsSync(path.join(currentVaultDir, ME_FILE))) {
      return sendJson(res, 409, { error: 'The current vault already has me.md; relocation is only allowed for an empty vault.', code: 'VAULT_NOT_EMPTY' });
    }
    if (getDb().prepare("SELECT 1 FROM facts WHERE source LIKE 'vault:%' LIMIT 1").get()) {
      return sendJson(res, 409, { error: 'The current vault already has indexed records; relocation is only allowed for an empty vault.', code: 'VAULT_NOT_EMPTY' });
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
