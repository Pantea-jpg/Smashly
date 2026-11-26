/**
 * Phase 9 performance checks for every list, detail and report endpoint:
 *   1. N+1: the number of SQL statements per request must not grow with the data.
 *      Each endpoint is measured on a tiny club and on a large one and the counts compared.
 *   2. Query plans: on the large club (2,000 members, 50,000 ledger rows, 40,000 notifications,
 *      30,000 audit rows ...) every SELECT an endpoint runs is EXPLAIN ANALYZEd. A sequential
 *      scan of a large table, or a slow statement, fails the test.
 * PERF_REPORT=<file> writes the measured table there (the source for docs/performance.md).
 */
import { writeFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { describe, expect, inject, it } from 'vitest';
import { useTestDatabase } from '../../test/db';
import { buildTestApp, createUser, TEST_PASSWORD } from '../../test/fixtures';
import { loginAs } from '../../test/sessions';
import { hashPassword } from '../core/auth/password';
import type { PrismaClient } from '../core/db/prisma';
import { PrismaClient as GeneratedClient } from '../generated/prisma/client';

const prisma = useTestDatabase();

/** A second client for the app under test, logging every statement it sends. */
const logged = new GeneratedClient({
  adapter: new PrismaPg({ connectionString: inject('databaseUrl') }),
  log: [{ emit: 'event', level: 'query' }],
});
let capture: { query: string; params: string }[] | null = null;
logged.$on('query', (e) => capture?.push({ query: e.query, params: e.params }));
const { app } = buildTestApp({ prisma: logged as unknown as PrismaClient });

interface Scale {
  members: number;
  txPerMember: number;
  trainings: number;
  perTraining: number;
  notificationsPerMember: number;
  auditRows: number;
  paymentsPerMember: number;
  debts: number;
}
const SMALL: Scale = {
  members: 4,
  txPerMember: 3,
  trainings: 4,
  perTraining: 3,
  notificationsPerMember: 3,
  auditRows: 10,
  paymentsPerMember: 2,
  debts: 2,
};
const LARGE: Scale = {
  members: 2000,
  txPerMember: 25,
  trainings: 200,
  perTraining: 40,
  notificationsPerMember: 20,
  auditRows: 30_000,
  paymentsPerMember: 3,
  debts: 400,
};
/** Below this many rows a sequential scan is cheaper than an index and is not a finding. */
const LARGE_TABLE_ROWS = 10_000;
const SLOW_MS = 100;

async function seed(s: Scale) {
  const admin = await createUser(prisma, { role: 'ADMIN' });
  const hash = await hashPassword(TEST_PASSWORD);
  const sql = (text: string, ...values: unknown[]) => prisma.$executeRawUnsafe(text, ...values);
  await sql(
    `INSERT INTO users (id, email, password_hash, role, status, email_verified_at, created_at, updated_at)
     SELECT gen_random_uuid(), 'member' || i || '@perf.test', $1, 'USER', 'ACTIVE', now(),
            now() - (i || ' minutes')::interval, now()
       FROM generate_series(1, ${s.members}) i`,
    hash,
  );
  await sql(
    `INSERT INTO user_profiles (user_id, first_name, last_name, updated_at)
     SELECT id, 'First' || substr(md5(email), 1, 6), 'Last' || substr(md5(email), 7, 8), now()
       FROM users WHERE email LIKE '%@perf.test'`,
  );
  await sql(
    `INSERT INTO wallets (id, user_id, currency, balance_minor, sequence, updated_at)
     SELECT gen_random_uuid(), id, 'EUR', ${s.txPerMember * 100}, ${s.txPerMember}, now()
       FROM users WHERE email LIKE '%@perf.test'`,
  );
  await sql(
    `INSERT INTO wallet_transactions (id, wallet_id, user_id, sequence, type, amount_minor,
       wallet_delta_minor, debt_delta_minor, balance_before_minor, balance_after_minor,
       debt_before_minor, debt_after_minor, currency, payment_method, description, reason,
       idempotency_key, group_id, created_by_admin_id, created_at)
     SELECT gen_random_uuid(), w.id, w.user_id, n,
            (CASE WHEN n % 3 = 0 THEN 'CASH_TOP_UP' ELSE 'ADJUSTMENT' END)::"TransactionType",
            100, 100, 0, (n - 1) * 100, n * 100, 0, 0, 'EUR',
            (CASE WHEN n % 3 = 0 THEN 'CASH' ELSE 'SYSTEM' END)::"PaymentMethod",
            'Seed', 'Seed', 'seed:' || w.id || ':' || n, gen_random_uuid(), $1::uuid,
            now() - ((${s.txPerMember} - n) || ' hours')::interval
       FROM wallets w CROSS JOIN generate_series(1, ${s.txPerMember}) n`,
    admin.id,
  );
  await sql(
    `WITH d AS (
       SELECT w.id AS wallet_id, w.user_id, t.id AS tx_id
         FROM wallets w JOIN wallet_transactions t ON t.wallet_id = w.id AND t.sequence = 1
        ORDER BY w.created_at LIMIT ${s.debts})
     INSERT INTO debts (id, user_id, wallet_id, source, source_transaction_id,
       original_amount_minor, outstanding_amount_minor, currency, status, created_at)
     SELECT gen_random_uuid(), user_id, wallet_id, 'TRAINING_CHARGE', tx_id, 500, 500, 'EUR', 'OPEN',
            now() - interval '5 days'
       FROM d`,
  );
  await sql(
    `UPDATE wallets SET debt_minor = 500 WHERE id IN (SELECT wallet_id FROM debts WHERE status = 'OPEN')`,
  );
  await sql(
    `INSERT INTO trainings (id, title, location, starts_at, ends_at, reservation_deadline,
       default_price_minor, created_by_id, updated_at, status, attendance_finalized_at)
     SELECT gen_random_uuid(), 'Training ' || i, 'Hall A',
            date_trunc('hour', now()) + ((i - ${Math.floor(s.trainings / 2)}) || ' days')::interval,
            date_trunc('hour', now()) + ((i - ${Math.floor(s.trainings / 2)}) || ' days')::interval + interval '1 hour',
            date_trunc('hour', now()) + ((i - ${Math.floor(s.trainings / 2)}) || ' days')::interval - interval '1 hour',
            1000, $1::uuid, now(), 'SCHEDULED',
            CASE WHEN i < ${Math.floor(s.trainings / 2) - 3} THEN now() END
       FROM generate_series(1, ${s.trainings}) i`,
    admin.id,
  );
  await sql(
    `INSERT INTO training_reservations (id, training_id, user_id, status, responded_by_id, responded_at, updated_at)
     SELECT gen_random_uuid(), t.id, m.id,
            (CASE WHEN m.rn % 5 = 0 THEN 'NOT_ATTENDING' ELSE 'ATTENDING' END)::"ReservationStatus",
            m.id, now(), now()
       FROM trainings t
       CROSS JOIN LATERAL (
         SELECT id, row_number() OVER () AS rn FROM users
          WHERE email LIKE '%@perf.test' ORDER BY md5(id::text || t.id::text) LIMIT ${s.perTraining}
       ) m`,
  );
  await sql(
    `INSERT INTO attendances (id, training_id, user_id, status, marked_by_id, marked_at, updated_at)
     SELECT gen_random_uuid(), r.training_id, r.user_id,
            (CASE WHEN t.attendance_finalized_at IS NULL THEN 'PENDING' ELSE 'PRESENT' END)::"AttendanceStatus",
            $1::uuid, now(), now()
       FROM training_reservations r JOIN trainings t ON t.id = r.training_id
      WHERE r.status = 'ATTENDING' AND t.starts_at < now()`,
    admin.id,
  );
  await sql(
    `INSERT INTO notifications (id, user_id, type, category, params, dedupe_key, read_at, created_at)
     SELECT gen_random_uuid(), u.id, 'TRAINING_CREATED', 'TRAININGS',
            jsonb_build_object('title', 'Training', 'startsAt', now()), 'seed:' || n,
            CASE WHEN n % 2 = 0 THEN now() END, now() - (n || ' hours')::interval
       FROM users u CROSS JOIN generate_series(1, ${s.notificationsPerMember}) n
      WHERE u.email LIKE '%@perf.test'`,
  );
  await sql(
    `INSERT INTO payments (id, user_id, wallet_id, provider_payment_id, amount_minor, currency,
       status, client_idempotency_key, succeeded_at, created_at, updated_at)
     SELECT gen_random_uuid(), w.user_id, w.id, 'pi_seed_' || w.id || '_' || n, 2500, 'EUR',
            'SUCCEEDED', 'seed-' || n, now(), now() - (n || ' days')::interval, now()
       FROM wallets w CROSS JOIN generate_series(1, ${s.paymentsPerMember}) n`,
  );
  await sql(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, created_at)
     SELECT gen_random_uuid(), $1::uuid, 'ADMIN', 'wallet.adjustment_credit', 'User',
            gen_random_uuid()::text, now() - (n || ' minutes')::interval
       FROM generate_series(1, ${s.auditRows}) n`,
    admin.id,
  );
  await sql('ANALYZE');

  const member = await prisma.user.findFirstOrThrow({
    where: { email: 'member1@perf.test' },
  });
  const training = await prisma.training.findFirstOrThrow({
    where: { attendanceFinalizedAt: null, startsAt: { lt: new Date() } },
    orderBy: { startsAt: 'desc' },
  });
  const upcoming = await prisma.training.findFirstOrThrow({
    where: { startsAt: { gt: new Date() } },
    orderBy: { startsAt: 'asc' },
  });
  return {
    adminSession: await loginAs(app, admin),
    memberSession: await loginAs(app, { email: member.email, password: TEST_PASSWORD }),
    memberId: member.id,
    trainingId: training.id,
    upcomingId: upcoming.id,
  };
}

type Seeded = Awaited<ReturnType<typeof seed>>;
const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
const to = new Date(Date.now() + 86_400_000).toISOString();
const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

function endpoints(s: Seeded): { as: 'member' | 'admin'; path: string }[] {
  const member = (path: string) => ({ as: 'member' as const, path: `/api/v1/me${path}` });
  const admin = (path: string) => ({ as: 'admin' as const, path: `/api/v1/admin${path}` });
  return [
    member(''),
    member('/wallet'),
    member('/transactions'),
    member('/debts'),
    member('/payments'),
    member('/trainings'),
    member(`/trainings/${s.upcomingId}`),
    member('/notifications'),
    member('/notifications/unread-count'),
    admin('/dashboard'),
    admin('/users'),
    admin('/users?q=member12'),
    admin('/users?hasDebt=true'),
    admin('/users?sort=lastName'),
    admin(`/users/${s.memberId}`),
    admin(`/users/${s.memberId}/transactions`),
    admin(`/users/${s.memberId}/debts`),
    admin(`/users/${s.memberId}/payments`),
    admin(`/users/${s.memberId}/trainings`),
    admin('/wallets'),
    admin('/transactions'),
    admin('/payments'),
    admin('/trainings'),
    admin(`/trainings/${s.trainingId}`),
    admin(`/trainings/${s.trainingId}/reservations`),
    admin(`/trainings/${s.trainingId}/attendance`),
    admin('/attendance/queue'),
    admin('/audit-logs'),
    admin(`/reports/summary?${range}`),
    admin(`/reports/revenue?${range}`),
    admin('/reports/debts'),
    admin(`/reports/cash?${range}`),
  ];
}

async function measure(s: Seeded) {
  const results = new Map<
    string,
    { status: number; statements: { query: string; params: string }[] }
  >();
  for (const e of endpoints(s)) {
    const auth = e.as === 'admin' ? s.adminSession.auth : s.memberSession.auth;
    capture = [];
    const res = await request(app).get(e.path).set(auth);
    const statements = capture;
    capture = null;
    results.set(e.path.replaceAll(/[0-9a-f-]{36}/g, ':id'), { status: res.status, statements });
  }
  return results;
}

/**
 * Sequential scans that an index should avoid: on a large table (≥ LARGE_TABLE_ROWS) AND
 * either under a LIMIT (a paginated list must not read the whole table to show one page) or
 * keeping under 10% of the rows (a selective filter without an index). Whole-table aggregates
 * (pagination totals, report sums) legitimately scan and are bounded by SLOW_MS instead.
 */
function inspect(plan: Record<string, unknown>, sizes: Map<string, number>): string[] {
  const scans: string[] = [];
  const walk = (node: Record<string, unknown>, underLimit: boolean) => {
    const limited = underLimit || node['Node Type'] === 'Limit';
    const relation = node['Relation Name'] as string | undefined;
    const size = relation ? (sizes.get(relation) ?? 0) : 0;
    if (node['Node Type'] === 'Seq Scan' && size >= LARGE_TABLE_ROWS) {
      const rowsOut = node['Actual Rows'] as number;
      if (limited || rowsOut < size * 0.1) {
        scans.push(`${relation!} (${String(rowsOut)} of ${String(size)} rows)`);
      }
    }
    for (const child of (node['Plans'] as Record<string, unknown>[] | undefined) ?? []) {
      walk(child, limited);
    }
  };
  walk(plan, false);
  return scans;
}

const isRead = (q: string) => /^\s*(SELECT|WITH)\b/i.test(q);

describe('query performance', () => {
  it('no N+1 queries and no slow plans on list, detail and report endpoints', async () => {
    const small = await measure(await seed(SMALL));
    await prisma.$executeRawUnsafe(
      `TRUNCATE ${(
        await prisma.$queryRaw<{ t: string }[]>`
          SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
      )
        .map((r) => `"public"."${r.t}"`)
        .join(', ')} RESTART IDENTITY CASCADE`,
    );
    const large = await measure(await seed(LARGE));
    const sizes = new Map(
      (
        await prisma.$queryRaw<{ relname: string; n: number }[]>`
          SELECT relname, reltuples::int AS n FROM pg_class
           WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace`
      ).map((r) => [r.relname, r.n]),
    );

    const report: string[] = [];
    const findings: string[] = [];
    for (const [path, l] of large) {
      const sm = small.get(path)!;
      expect(l.status, path).toBe(200);
      expect(sm.status, path).toBe(200);
      const nPlusOne = l.statements.length > sm.statements.length;
      if (nPlusOne) {
        findings.push(
          `${path}: ${String(sm.statements.length)} statements on a small club, ${String(l.statements.length)} on a large one (N+1)`,
        );
      }
      let worstMs = 0;
      const scans: string[] = [];
      for (const st of l.statements.filter((x) => isRead(x.query))) {
        const params = JSON.parse(st.params) as unknown[];
        const rows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': [Record<string, unknown>] }[]>(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${st.query}`,
          ...params,
        );
        const top = rows[0]!['QUERY PLAN'][0];
        const ms = top['Execution Time'] as number;
        worstMs = Math.max(worstMs, ms);
        const seq = inspect(top['Plan'] as Record<string, unknown>, sizes);
        scans.push(...seq);
        if (seq.length > 0 || ms > SLOW_MS) {
          findings.push(
            `${path}: ${ms.toFixed(1)} ms, seq scans: ${seq.join(', ') || 'none'}\n    ${st.query.slice(0, 400)}`,
          );
        }
      }
      report.push(
        `| \`GET ${path.replace('/api/v1', '').replace(/from=.*$/, 'from=…&to=…')}\` | ${String(l.statements.length)} | ${worstMs.toFixed(1)} | ${scans.length ? scans.join('; ') : '–'} |`,
      );
    }
    const reportFile = process.env['PERF_REPORT'];
    if (reportFile) {
      writeFileSync(
        reportFile,
        [
          '| Endpoint | SQL statements | Slowest statement (ms) | Avoidable full scans |',
          '|---|---|---|---|',
          ...report,
        ].join('\n'),
      );
    }
    expect(findings).toEqual([]);
  }, 600_000);

  it('every foreign key column leads an index (cheap joins and cascading deletes)', async () => {
    const missing = await prisma.$queryRaw<{ tbl: string; col: string }[]>`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
       ORDER BY 1, 2`;
    expect(missing.map((m) => `${m.tbl}.${m.col}`)).toEqual([]);
  });
});
