#!/usr/bin/env node
// Post-deploy smoke test for a deployed API (staging or production). Read-only: it creates
// nothing and needs no credentials, so it is safe to run against production.
//
//   node scripts/smoke-test.mjs <baseUrl> [expectedVersion] [--wait <seconds>]
//
// With an expected version it first waits (default 900 s) until /health/ready reports that
// version, i.e. until the new deploy is live, then runs the checks. Exit code 1 on any failure.
const args = process.argv.slice(2);
const waitIndex = args.indexOf('--wait');
const waitSeconds = waitIndex >= 0 ? Number(args.splice(waitIndex, 2)[1]) : 900;
const [baseArg, expectedVersion] = args;
if (!baseArg) {
  console.error(
    'usage: node scripts/smoke-test.mjs <baseUrl> [expectedVersion] [--wait <seconds>]',
  );
  process.exit(2);
}
const base = baseArg.replace(/\/+$/, '');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function get(path, init) {
  return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
}

async function waitForVersion() {
  const deadline = Date.now() + waitSeconds * 1000;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    try {
      const res = await get('/health/ready');
      const body = await res.json();
      last = `${String(res.status)} version=${String(body.version)}`;
      if (res.ok && String(body.version).startsWith(expectedVersion.slice(0, 12))) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(
    `version ${expectedVersion} not live after ${String(waitSeconds)} s (last: ${last})`,
  );
}

console.log(`Smoke test ${base}${expectedVersion ? ` (expecting ${expectedVersion})` : ''}`);
if (expectedVersion) {
  await check(`deploy of ${expectedVersion.slice(0, 12)} is live`, waitForVersion);
}

await check('liveness: GET /health/live answers 200', async () => {
  const res = await get('/health/live');
  assert(res.status === 200, `status ${String(res.status)}`);
});

await check('readiness: database and Redis are ok', async () => {
  const res = await get('/health/ready');
  const body = await res.json();
  assert(res.status === 200, `status ${String(res.status)}: ${JSON.stringify(body)}`);
  assert(body.checks?.database === 'ok', `database ${String(body.checks?.database)}`);
  assert(
    body.checks?.redis === 'ok',
    `redis ${String(body.checks?.redis)} (rate limits need Redis)`,
  );
});

await check('HTTPS with HSTS', async () => {
  assert(base.startsWith('https://'), 'base URL is not https');
  const res = await get('/health/live');
  assert(res.headers.get('strict-transport-security'), 'missing Strict-Transport-Security');
});

await check('protected routes reject anonymous requests (401, no-store)', async () => {
  const res = await get('/api/v1/me');
  const body = await res.json();
  assert(res.status === 401, `status ${String(res.status)}`);
  assert(body.error?.code === 'UNAUTHENTICATED', `code ${String(body.error?.code)}`);
  assert(res.headers.get('cache-control') === 'no-store', 'missing Cache-Control: no-store');
});

await check('sign-in rejects wrong credentials without revealing accounts', async () => {
  const res = await get('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke-test@invalid.example', password: 'not the password' }),
  });
  const body = await res.json();
  assert(res.status === 401, `status ${String(res.status)}`);
  assert(body.error?.code === 'INVALID_CREDENTIALS', `code ${String(body.error?.code)}`);
});

await check('Stripe webhook rejects unsigned requests', async () => {
  const res = await get('/api/v1/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=invalid' },
    body: '{}',
  });
  assert(res.status === 400, `status ${String(res.status)} (503 means Stripe keys are missing)`);
});

await check('API docs are not public', async () => {
  const res = await get('/api/docs/');
  assert(res.status === 404, `status ${String(res.status)}`);
});

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? 'All smoke checks passed.' : `${String(failed)} smoke check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
