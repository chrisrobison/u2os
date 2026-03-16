const config = require('../core/config');
const { createControlStore } = require('../core/tenancy/controlStore');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || process.env.ADMIN_EMAIL || '').trim();
  const password = String(args.password || process.env.ADMIN_PASSWORD || '');
  const fullName = String(args.name || process.env.ADMIN_NAME || 'Control Admin').trim();
  const role = String(args.role || process.env.ADMIN_ROLE || 'admin').trim().toLowerCase();
  const status = String(args.status || process.env.ADMIN_STATUS || 'active').trim().toLowerCase();
  const isSuperuser = Boolean(args.superuser || String(process.env.ADMIN_SUPERUSER || '').toLowerCase() === 'true');
  const instanceIds = String(args.instances || process.env.ADMIN_INSTANCE_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!email || !password) {
    console.error('Usage: node scripts/create-admin-user.js --email admin@example.com --password <secret> [--name "Control Admin"] [--role admin] [--superuser] [--instances id1,id2]');
    process.exit(1);
  }

  const controlStore = await createControlStore(config.controlDb);
  await controlStore.initSchema();

  try {
    const admin = await controlStore.createAdminLogin({
      email,
      password,
      full_name: fullName,
      role,
      status,
      is_superuser: isSuperuser
    });

    if (!isSuperuser) {
      for (const instanceId of instanceIds) {
        await controlStore.assignAdminLoginInstance(admin.id, instanceId);
      }
    }

    const scope = await controlStore.listAdminLoginInstanceIds(admin.id);
    console.log('Admin user ready');
    console.log(`id: ${admin.id}`);
    console.log(`email: ${admin.email}`);
    console.log(`role: ${admin.role}`);
    console.log(`superuser: ${admin.is_superuser ? 'yes' : 'no'}`);
    console.log(`instance_scope: ${scope.length ? scope.join(', ') : '(none/all via superuser)'}`);
  } finally {
    await controlStore.close();
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
