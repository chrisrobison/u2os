import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModelsConfig } from '../mcp/jobs/hunt/llm/models.js';
import { createFastLlm } from '../server/jobhunt/llm.js';

function vaultWith(yamlText) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-ladder-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'models.yaml'), yamlText);
  return vault;
}
const FAST = 'fast:\n  provider: lmstudio\n  model: small\n';

test('models.yaml: escalate lists bigger local models, validated like fast', () => {
  const config = loadModelsConfig(vaultWith(`${FAST}escalate:\n  - { provider: lmstudio, model: big, reasoning: 'on', timeout_seconds: 300 }\n`));
  assert.deepEqual(config.escalate.map((m) => [m.model, m.reasoning, m.timeout_seconds]), [['big', 'on', 300]]);
  assert.deepEqual(loadModelsConfig(vaultWith(FAST)).escalate, []);
  for (const bad of ['escalate: x\n', 'escalate:\n  - { provider: openai, model: b }\n', 'escalate:\n  - { provider: lmstudio, model: "a b" }\n']) {
    assert.throws(() => loadModelsConfig(vaultWith(FAST + bad)), /models\.yaml/, bad);
  }
  assert.throws(() => loadModelsConfig(vaultWith('escalate:\n  - { provider: lmstudio, model: big }\n')), /needs a fast model/);
});

test('fast llm escalates to the next local model when the first answers invalidly, and stays on the first when it is valid', async () => {
  const vault = vaultWith(`${FAST}escalate:\n  - { provider: lmstudio, model: big }\n`);
  const asked = [];
  const answers = { small: 'not json at all', big: '{"ok":true}' };
  const fetchImpl = async (_url, request) => {
    const model = JSON.parse(request.body).model; asked.push(model);
    return new Response(JSON.stringify({ output: [{ type: 'message', content: answers[model] }] }), { status: 200 });
  };
  const llm = createFastLlm({ vaultDir: vault, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-ladder-data-')), fetchImpl });
  const validate = (v) => v;
  const result = await llm.json({ system: 's', user: 'u', validate });
  assert.equal(result.model, 'lmstudio:big'); assert.deepEqual(result.value, { ok: true });
  assert.ok(asked.includes('small') && asked.at(-1) === 'big');
  answers.small = '{"ok":"first"}'; asked.length = 0;
  assert.equal((await llm.json({ system: 's', user: 'u', validate })).model, 'lmstudio:small');
  assert.deepEqual(asked, ['small']);
});
