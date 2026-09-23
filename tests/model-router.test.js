import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../server/agent/model-router.js';
import { Planner } from '../server/agent/planner.js';
import { createToolRegistry } from '../server/tools/register-all.js';

const registry = createToolRegistry();

function fakeProvider(id, { fails = false } = {}) {
  return {
    id,
    plan: async (_ctx, objective) => {
      if (fails) throw new Error(`${id} unavailable`);
      return { reasoning_summary: `${id}: ${objective}`, actions: [] };
    },
  };
}

test('resolve() picks the provider configured for a role', () => {
  const router = new ModelRouter(
    {
      providers: { small: { type: 'mock', tag: 'small' }, large: { type: 'mock', tag: 'large' } },
      roles: { planner: 'large', classifier: 'small' },
    },
    { createProvider: (cfg) => fakeProvider(cfg.tag) }
  );
  assert.equal(router.resolve('planner').id, 'large');
  assert.equal(router.resolve('classifier').id, 'small');
});

test('resolve() instantiates and caches one provider instance per provider name, shared across roles that reference it', () => {
  let constructions = 0;
  const router = new ModelRouter(
    {
      providers: { shared: { type: 'mock' } },
      roles: { classifier: 'shared', summarizer: 'shared' },
    },
    {
      createProvider: () => {
        constructions += 1;
        return fakeProvider('shared-instance');
      },
    }
  );
  const a = router.resolve('classifier');
  const b = router.resolve('summarizer');
  assert.equal(a, b);
  assert.equal(constructions, 1);
});

test('resolve() throws a clear error for a role with no mapping and no default/fallback', () => {
  const router = new ModelRouter({ providers: { p: { type: 'mock' } }, roles: { planner: 'p' } });
  assert.throws(() => router.resolve('embeddings'), /no provider configured for role "embeddings"/);
});

test('resolve() throws a clear error when a role references an unknown provider name', () => {
  const router = new ModelRouter({ providers: { p: { type: 'mock' } }, roles: { planner: 'ghost' } });
  assert.throws(() => router.resolve('planner'), /unknown provider "ghost"/);
});

test('a legacy single-provider config ({provider, baseUrl, model}) is treated as one "default" provider used for every role', () => {
  const router = new ModelRouter({ provider: 'mock' });
  const a = router.resolve('planner');
  const b = router.resolve('classifier');
  assert.equal(a, b, 'both roles should resolve to the same normalized "default" provider');
});

test('resolveFallback() returns null when no fallback is configured, or when the fallback equals the role\'s own provider', () => {
  const router1 = new ModelRouter({ providers: { p: { type: 'mock' } }, roles: { planner: 'p' } });
  assert.equal(router1.resolveFallback('planner'), null);

  const router2 = new ModelRouter({ providers: { p: { type: 'mock' } }, roles: { planner: 'p' }, fallback: 'p' });
  assert.equal(router2.resolveFallback('planner'), null);
});

test('resolveFallback() returns the configured fallback provider when distinct from the role\'s primary', () => {
  const router = new ModelRouter({
    providers: { local: { type: 'mock' }, hosted: { type: 'mock' } },
    roles: { planner: 'local' },
    fallback: 'hosted',
  });
  const fallback = router.resolveFallback('planner');
  assert.ok(fallback);
});

test('Planner routed through a failing primary provider retries once against the router fallback, and switching does not change the returned plan shape', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const router = new ModelRouter(
    {
      providers: { primary: { type: 'mock', tag: 'primary' }, backup: { type: 'mock', tag: 'backup' } },
      roles: { planner: 'primary' },
      fallback: 'backup',
    },
    {
      createProvider: (cfg) =>
        cfg.tag === 'backup'
          ? { id: 'backup', plan: async () => { fallbackCalls += 1; return { reasoning_summary: 'from backup', actions: [] }; } }
          : { id: 'primary', plan: async () => { primaryCalls += 1; throw new Error('primary down'); } },
    }
  );

  const planner = new Planner({ modelRouter: router, role: 'planner' });
  const plan = await planner.plan({ toolRegistry: registry }, 'do something');
  assert.equal(plan.reasoning_summary, 'from backup');
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(planner.lastProviderId, 'backup');
});

test('Planner without a fallback propagates the primary provider\'s failure explicitly rather than silently succeeding', async () => {
  const router = new ModelRouter(
    { providers: { primary: { type: 'mock' } }, roles: { planner: 'primary' } },
    { createProvider: () => ({ id: 'primary', plan: async () => { throw new Error('primary down'); } }) }
  );
  const planner = new Planner({ modelRouter: router, role: 'planner' });
  await assert.rejects(planner.plan({ toolRegistry: registry }, 'do something'), /primary down/);
});

test('DOCUMENTED FOOTGUN: a legacy single-provider config\'s "every role uses this provider" fallback also applies to an unconfigured "embeddings" role -- callers resolving embeddings must check listRoles() first (see server/index.js)', () => {
  const router = new ModelRouter({ provider: 'mock' });
  // This is the exact behavior server/index.js works around: it does NOT
  // throw for an unconfigured 'embeddings' role on a legacy config -- it
  // silently resolves to the single planning provider, which has no
  // .embed(). listRoles() is how a caller detects "embeddings was never
  // actually configured" instead of getting a wrong-interface object.
  assert.equal(router.resolve('embeddings'), router.resolve('planner'));
  assert.equal(router.listRoles().includes('embeddings'), false);
});

test('an explicit multi-provider config with its own "embeddings" role does NOT fall back to the planner provider', () => {
  const router = new ModelRouter({
    providers: { planner: { type: 'mock' }, embed: { type: 'mock-embedding' } },
    roles: { planner: 'planner', embeddings: 'embed' },
  });
  assert.equal(router.listRoles().includes('embeddings'), true);
  const embeddingProvider = router.resolve('embeddings');
  assert.equal(embeddingProvider.id, 'mock-embedding-provider');
});

test('Planner with a plain modelProvider (no router) behaves exactly as before -- no router involved', async () => {
  const provider = fakeProvider('plain');
  const planner = new Planner({ modelProvider: provider });
  const plan = await planner.plan({ toolRegistry: registry }, 'hi');
  assert.equal(plan.reasoning_summary, 'plain: hi');
  assert.equal(planner.lastProviderId, 'plain');
});

test('personal router rejects mock planner and never retries a failed real planner through a mock fallback', async () => {
  const mockOnly = new ModelRouter({ provider: 'mock' }, { allowMock: false });
  assert.throws(() => mockOnly.resolve('planner'), { code: 'MODEL_UNAVAILABLE' });
  const realWithMockFallback = new ModelRouter({
    providers: { real: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234', model: 'fixture' }, fixture: { type: 'mock' } },
    roles: { planner: 'real' }, fallback: 'fixture',
  }, { allowMock: false, createProvider: (config) => ({ id: config.type, plan: async () => { throw new Error('real provider unavailable'); } }) });
  assert.equal(realWithMockFallback.resolveFallback('planner'), null);
  await assert.rejects(new Planner({ modelRouter: realWithMockFallback }).plan({ toolRegistry: registry }, 'test'), { code: 'MODEL_UNAVAILABLE', status: 503 });
});
