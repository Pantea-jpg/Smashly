// Generates the repository-root render.yaml (Render Blueprint) for staging and production.
// Edit the settings here, then run:  node infra/render/generate-blueprint.mjs
// The output is plain YAML (no anchors), so Render reads exactly what is written.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Secrets: Render asks for them once when the Blueprint is created and never overwrites them. */
const SECRETS = [
  'JWT_PRIVATE_KEY',
  'SMTP_URL',
  'EMAIL_FROM',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_PRIVATE_KEY',
  'SENTRY_DSN',
];

const BACKEND_PATHS = [
  'apps/api/**',
  'packages/**',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
];

const ENVIRONMENTS = [
  {
    name: 'staging',
    comment: 'auto-deploys `main` once CI has passed; used with the TestFlight "preview" build',
    protection: false,
    autoDeployTrigger: 'checksPass',
    bundleId: 'com.trainingwallet.app.staging',
    appLinkBase: 'trainingwallet-staging://',
    dbPlan: '0.1c-256mb',
    dbDiskGB: null,
    redisPlan: 'free',
    apiPlan: '0.5c-512mb',
    apiInstances: 1,
    workerPlan: '0.5c-512mb',
  },
  {
    name: 'production',
    comment: 'deployed only by .github/workflows/release.yml (manual approval, deploy hook)',
    protection: true,
    autoDeployTrigger: 'off',
    bundleId: 'com.trainingwallet.app',
    appLinkBase: 'trainingwallet://',
    dbPlan: '0.5c-1g',
    dbDiskGB: 15,
    redisPlan: '256mb',
    apiPlan: '1c-2g',
    apiInstances: 2,
    workerPlan: '0.5c-512mb',
  },
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function environment(e) {
  const db = `tw-db-${e.name}`;
  const redis = `tw-redis-${e.name}`;
  const group = `tw-${e.name}-config`;
  const secrets = e.secrets ?? SECRETS;
  const out = [];
  const line = (indent, text) => out.push(' '.repeat(indent) + text);

  const envVars = (indent) => {
    line(indent, 'envVars:');
    line(indent + 2, `- fromGroup: ${group}`);
    line(indent + 2, '- key: DATABASE_URL');
    line(indent + 4, 'fromDatabase:');
    line(indent + 6, `name: ${db}`);
    line(indent + 6, 'property: connectionString');
    line(indent + 2, '- key: REDIS_URL');
    line(indent + 4, 'fromService:');
    line(indent + 6, 'type: keyvalue');
    line(indent + 6, `name: ${redis}`);
    line(indent + 6, 'property: connectionString');
    for (const key of secrets) {
      line(indent + 2, `- key: ${key}`);
      line(indent + 4, 'sync: false');
    }
  };
  const buildFilter = (indent) => {
    line(indent, 'buildFilter:');
    line(indent + 2, 'paths:');
    for (const p of BACKEND_PATHS) line(indent + 4, `- ${q(p)}`);
  };

  line(6, `# ${'─'.repeat(30)} ${e.name} ${'─'.repeat(30)}`);
  line(6, `# ${e.comment}`);
  line(6, `- name: ${e.name}`);
  if (e.protection) {
    line(8, '# Destructive actions (deleting the database or services) need extra confirmation.');
    line(8, 'permissions:');
    line(10, 'protection: enabled');
  }
  line(8, 'envVarGroups:');
  line(10, `- name: ${group}`);
  line(12, 'envVars:');
  const config = [
    ['NODE_ENV', e.nodeEnv ?? e.name],
    ['LOG_LEVEL', 'info'],
    ['TRUST_PROXY_HOPS', '1'], // Render's proxy in front of the app (client IP for limits/audit)
    ['APNS_ENVIRONMENT', 'production'], // TestFlight and App Store builds use production APNs
    ['APNS_BUNDLE_ID', e.bundleId],
    ['APP_LINK_BASE', e.appLinkBase],
    ['S3_REGION', 'auto'], // Cloudflare R2
    ['S3_FORCE_PATH_STYLE', 'true'],
    ...(e.extraConfig ?? []),
  ];
  for (const [key, value] of config) {
    line(14, `- key: ${key}`);
    line(16, `value: ${q(value)}`);
  }

  line(8, 'databases:');
  line(10, `- name: ${db}`);
  line(12, 'region: frankfurt');
  line(12, "postgresMajorVersion: '17'");
  line(
    12,
    e.dbPlan === 'free'
      ? `plan: ${e.dbPlan} # no backups; expires after 30 days (test only)`
      : `plan: ${e.dbPlan} # paid plan: daily backups + point-in-time recovery`,
  );
  if (e.dbDiskGB) {
    line(12, `diskSizeGB: ${e.dbDiskGB}`);
    line(12, 'storageAutoscalingEnabled: true');
  }
  line(12, 'databaseName: training_wallet');
  line(12, 'user: training_wallet');
  line(12, 'ipAllowList: [] # internal connections only');

  line(8, 'services:');
  line(10, '- type: keyvalue');
  line(12, `name: ${redis}`);
  line(12, 'region: frankfurt');
  line(12, `plan: ${e.redisPlan}`);
  line(12, 'ipAllowList: [] # internal connections only');
  line(12, 'maxmemoryPolicy: noeviction');

  line(10, '- type: web');
  line(12, `name: tw-api-${e.name}`);
  line(12, 'runtime: docker');
  line(12, 'region: frankfurt');
  line(12, `plan: ${e.apiPlan}`);
  if (e.apiInstances > 1) {
    line(12, `numInstances: ${e.apiInstances} # rolling deploys without downtime`);
  }
  line(12, 'dockerfilePath: ./apps/api/Dockerfile');
  line(12, 'dockerContext: .');
  line(12, 'healthCheckPath: /health/ready');
  if (e.migrateOnStart) {
    // Free web services have no pre-deploy step: migrate at start (fine for one instance).
    line(12, '# Free plan has no pre-deploy step: migrations run when the container starts.');
    line(
      12,
      'dockerCommand: sh -c "node_modules/.bin/prisma migrate deploy && exec node --enable-source-maps dist/main.js"',
    );
  } else {
    line(12, '# Migrations run once per deploy, before new instances take traffic.');
    line(12, 'preDeployCommand: node_modules/.bin/prisma migrate deploy');
  }
  line(12, 'branch: main');
  line(12, `autoDeployTrigger: ${e.autoDeployTrigger}`);
  buildFilter(12);
  envVars(12);

  if (e.workerComment) line(10, `# ${e.workerComment}`);
  line(10, '- type: worker');
  line(12, `name: tw-worker-${e.name}`);
  line(12, 'runtime: docker');
  line(12, 'region: frankfurt');
  line(12, `plan: ${e.workerPlan}`);
  line(12, 'dockerfilePath: ./apps/api/Dockerfile');
  line(12, 'dockerContext: .');
  line(12, 'dockerCommand: node --enable-source-maps dist/worker.js');
  line(12, 'branch: main');
  line(12, `autoDeployTrigger: ${e.autoDeployTrigger}`);
  buildFilter(12);
  envVars(12);
  return out.join('\n');
}

const header = `# Render Blueprint — Training Wallet backend. GENERATED by infra/render/generate-blueprint.mjs;
# edit that script, not this file. Setup guide: docs/09-deployment.md.
#
# Region: Frankfurt (EU data residency, D26). One project, two environments that share nothing.
# Per environment: the API (web service, also serves Socket.IO), the worker (outbox, pushes,
# reminders, payment sweeper, reconciliation), PostgreSQL 17 with point-in-time recovery, and
# Key Value (Redis) for shared rate limits. API and worker run the same Docker image.
# Secrets are "sync: false": Render asks for each one when the Blueprint is first created.
# Never write a secret value into this file.
`;

const yaml = `${header}
projects:
  - name: training-wallet
    environments:
${ENVIRONMENTS.map(environment).join('\n\n')}
`;

const target = fileURLToPath(new URL('../../render.yaml', import.meta.url));
writeFileSync(target, yaml);
console.log(`wrote ${target}`);

// ── Low-cost test setup (render.test.yaml) ────────────────────────────────────────────────
// For trying the app before any other account exists: no Stripe, no email provider, no storage,
// no Sentry. Emails are written to the worker's log (SMTP_URL=log://), the API docs are on, and
// only the sign-in key is asked for. Delete the whole project in Render when done.
const TEST = {
  name: 'test',
  nodeEnv: 'staging', // server behaves as staging (Redis rate limits, no demo shortcuts)
  comment: 'test only: free database, Redis and API; deploys every push to main',
  protection: false,
  autoDeployTrigger: 'commit',
  bundleId: 'com.trainingwallet.app',
  appLinkBase: 'trainingwallet://',
  dbPlan: 'free', // Render's free database expires after 30 days; enough for testing
  dbDiskGB: null,
  redisPlan: 'free',
  apiPlan: 'free', // sleeps when idle: the first request after a while takes about a minute
  apiInstances: 1,
  workerPlan: '0.5c-512mb',
  migrateOnStart: true,
  secrets: ['JWT_PRIVATE_KEY'],
  workerComment:
    'The only paid part (free plans have no background workers). It writes emails to its log and runs reminders and the nightly money check. Delete it to keep everything free.',
  extraConfig: [
    ['ENABLE_API_DOCS', 'true'],
    ['SMTP_URL', 'log://'],
    ['EMAIL_FROM', 'Training Wallet <no-reply@example.test>'],
    ['S3_BUCKET', 'tw-test-no-storage'], // profile picture upload is unavailable in this setup
  ],
};
const testYaml = `# Render Blueprint — Training Wallet LOW-COST TEST setup. GENERATED by
# infra/render/generate-blueprint.mjs; edit that script, not this file. Guide: docs/13-testing.md.
# No Stripe, email provider, storage or Sentry needed: online top-ups and profile pictures are
# unavailable, and emails (verification, password reset) are written to the worker's log.
# Only JWT_PRIVATE_KEY is asked for. Never use this setup for real members.

projects:
  - name: training-wallet-test
    environments:
${environment(TEST)}
`;
const testTarget = fileURLToPath(new URL('../../render.test.yaml', import.meta.url));
writeFileSync(testTarget, testYaml);
console.log(`wrote ${testTarget}`);
