// Discovers every skills/*/manifest.json at startup. Manifests are metadata
// only (name, domain, auth type, declared scopes/permissions) -- the actual
// provider logic lives in server/integrations/*-provider.js. Used purely by
// the GET /api/connectors listing, per docs/connectors.md's "Skill manifest
// schema" section.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.join(__dirname, '..', '..', 'skills');

export function loadSkillManifests() {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  const manifests = [];
  for (const entry of fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(SKILLS_ROOT, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      manifests.push(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    } catch (err) {
      console.error(`[skill-manifests] failed to parse ${manifestPath}`, err.message);
    }
  }
  return manifests;
}

export function manifestsByDomain() {
  const byDomain = {};
  for (const manifest of loadSkillManifests()) {
    byDomain[manifest.domain] = byDomain[manifest.domain] || [];
    byDomain[manifest.domain].push(manifest);
  }
  return byDomain;
}
