import { randomUUID } from 'node:crypto';
import type { ReconciliationReport } from '@tw/contracts';
import pino from 'pino';
import type { PrismaClient } from '../src/core/db/prisma';
import { AppError } from '../src/core/errors/app-error';
import { FakePaymentProvider } from '../src/integrations/payments/fake-payment-provider';
import { SettingsService } from '../src/modules/admin/settings.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { ReconciliationService } from '../src/modules/reports/reconciliation.service';
import { LedgerService } from '../src/modules/wallets/ledger.service';
import { adminContext, presentAt } from './money';

/**
 * Randomized, concurrent stress test of every money path (Phase 5 gate).
 *
 * A seeded PRNG picks a stream of mixed operations over a small set of users so the same
 * wallets are hit concurrently. Business rejections (insufficient balance, already reversed…)
 * are expected and counted; anything else is a failure. Afterwards the books must reconcile
 * and the wallet invariants must hold. The operation stream is reproducible from the seed;
 * the interleaving is not (that is the point).
 */

export interface SimulationOptions {
  operations: number;
  seed: number;
  users?: number;
  concurrency?: number;
  onProgress?: (done: number) => void;
}

export interface SimulationResult {
  durationMs: number;
  stats: Record<string, { ok: number; rejected: number }>;
  rejections: Record<string, number>;
  failures: { op: string; error: string }[];
  replayMismatches: string[];
  invariantViolations: string[];
  reconciliation: ReconciliationReport;
  totals: { wallets: number; transactions: number; balanceMinor: number; debtMinor: number };
}

/** Rejections the business rules are supposed to produce under random input. */
const EXPECTED = new Set([
  'INSUFFICIENT_BALANCE',
  'AMOUNT_OUT_OF_RANGE',
  'ALREADY_REVERSED',
  'NOT_REVERSIBLE',
  'BALANCE_LIMIT_EXCEEDED',
  'CONFLICT',
]);

type OpName =
  | 'cash'
  | 'cash_replay'
  | 'adjust_credit'
  | 'adjust_debit'
  | 'debt_waiver'
  | 'charge'
  | 'reverse'
  | 'reverse_charge'
  | 'refund_cash'
  | 'online_top_up'
  | 'card_refund'
  | 'dispute';

const WEIGHTS: [OpName, number][] = [
  ['cash', 14],
  ['cash_replay', 4],
  ['adjust_credit', 5],
  ['adjust_debit', 5],
  ['debt_waiver', 4],
  ['charge', 22],
  ['reverse', 8],
  ['reverse_charge', 7],
  ['refund_cash', 6],
  ['online_top_up', 13],
  ['card_refund', 7],
  ['dispute', 5],
];

/** mulberry32: tiny, fast, good enough for test input. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export async function runLedgerSimulation(
  prisma: PrismaClient,
  options: SimulationOptions,
): Promise<SimulationResult> {
  const started = Date.now();
  const random = prng(options.seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: T[]): T | undefined =>
    items.length === 0 ? undefined : items[int(0, items.length - 1)];
  const totalWeight = WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  const nextOp = (): OpName => {
    let roll = random() * totalWeight;
    for (const [name, weight] of WEIGHTS) {
      roll -= weight;
      if (roll < 0) return name;
    }
    return 'cash';
  };

  const settings = new SettingsService(prisma);
  const ledger = new LedgerService(prisma, settings);
  const provider = new FakePaymentProvider();
  const payments = new PaymentsService(
    prisma,
    ledger,
    settings,
    provider,
    pino({ level: 'silent' }),
  );
  const reconciliation = new ReconciliationService(prisma);

  // ── Fixtures ───────────────────────────────────────────────────────────
  const admins: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const admin = await prisma.user.create({
      data: {
        email: `sim-admin-${options.seed}-${i}-${randomUUID()}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'ADMIN',
        status: 'ACTIVE',
        profile: { create: { firstName: 'Sim', lastName: `Admin ${i}`, preferredLanguage: 'en' } },
      },
    });
    admins.push(admin.id);
  }
  const users: string[] = [];
  for (let i = 0; i < (options.users ?? 12); i += 1) {
    const user = await prisma.user.create({
      data: {
        email: `sim-user-${options.seed}-${i}-${randomUUID()}@example.test`,
        passwordHash: 'not-a-real-hash',
        role: 'USER',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: 'Sim', lastName: `User ${i}`, preferredLanguage: 'en' } },
        wallets: { create: { currency: 'EUR' } },
      },
    });
    users.push(user.id);
  }

  // Things later operations act on (filled as operations succeed).
  const reversible: string[] = [];
  const charges: string[] = [];
  const cashOps: {
    userId: string;
    adminId: string;
    key: string;
    amountMinor: number;
    transactionId: string;
  }[] = [];
  const paid: { userId: string; paymentId: string; intentId: string; amountMinor: number }[] = [];
  const disputed = new Set<string>();

  const stats = Object.fromEntries(
    WEIGHTS.map(([name]) => [name, { ok: 0, rejected: 0 }]),
  ) as SimulationResult['stats'];
  const rejections: Record<string, number> = {};
  const failures: SimulationResult['failures'] = [];
  const replayMismatches: string[] = [];

  async function deliver(type: string, object: Record<string, unknown>, times = 1): Promise<void> {
    const signed = provider.signedEvent(type, object);
    const event = provider.verifyWebhook(Buffer.from(signed.payload), signed.signature);
    // Stripe delivers at least once: send duplicates concurrently.
    await Promise.all(Array.from({ length: times }, () => payments.handleEvent(event)));
  }

  /** Draws the operation and its inputs synchronously (so the stream follows the seed). */
  function plan(index: number): { name: OpName; run: () => Promise<void> } {
    // Alternate rich and poor phases so wallets swing between credit and debt (and back).
    const poor = Math.floor(index / 400) % 2 === 1;
    const name = nextOp();
    const userId = pick(users)!;
    const adminId = pick(admins)!;
    const ctx = adminContext(adminId);
    const key = randomUUID();
    const amount = int(1, poor ? 8 : 40) * 50; // €0.50 … €4.00 / €20.00

    switch (name) {
      case 'cash':
        return {
          name,
          run: async () => {
            const result = await ledger.creditCash(
              { userId, amountMinor: amount, adminId, idempotencyKey: key },
              ctx,
            );
            reversible.push(result.transaction.id);
            cashOps.push({
              userId,
              adminId,
              key,
              amountMinor: amount,
              transactionId: result.transaction.id,
            });
          },
        };
      case 'cash_replay': {
        const original = pick(cashOps);
        return {
          name,
          run: async () => {
            if (!original) return;
            // The same request twice at once (double-tap / client retry) must post nothing new.
            const input = {
              userId: original.userId,
              amountMinor: original.amountMinor,
              adminId: original.adminId,
              idempotencyKey: original.key,
            };
            const results = await Promise.all([
              ledger.creditCash(input, adminContext(original.adminId)),
              ledger.creditCash(input, adminContext(original.adminId)),
            ]);
            for (const r of results) {
              if (r.transaction.id !== original.transactionId)
                replayMismatches.push(`${original.key} → ${r.transaction.id}`);
            }
          },
        };
      }
      case 'adjust_credit':
      case 'adjust_debit':
      case 'debt_waiver': {
        const waiverAmount = int(1, poor ? 20 : 4) * 50;
        return {
          name,
          run: async () => {
            const kind =
              name === 'adjust_credit'
                ? 'CREDIT'
                : name === 'adjust_debit'
                  ? 'DEBIT'
                  : 'DEBT_WAIVER';
            // Waivers are small so some fit the (usually small) outstanding debt.
            const amountMinor = kind === 'DEBT_WAIVER' ? Math.min(amount, waiverAmount) : amount;
            const result = await ledger.adjust(
              { userId, kind, amountMinor, reason: 'simulation', adminId, idempotencyKey: key },
              ctx,
            );
            reversible.push(result.transaction.id);
          },
        };
      }
      case 'charge': {
        const price = random() < 0.08 ? 0 : int(1, poor ? 120 : 20) * 50;
        return {
          name,
          run: async () => {
            const training = await presentAt(prisma, { adminId, userId, priceMinor: price });
            const charged = await ledger.run(undefined, (tx) =>
              ledger.chargeTraining(
                tx,
                {
                  trainingId: training.trainingId,
                  trainingTitle: training.title,
                  userId,
                  attendanceId: training.attendanceId,
                  unitPriceMinor: price,
                  priceSource: 'TRAINING_DEFAULT',
                  currency: 'EUR',
                },
                ctx,
              ),
            );
            charges.push(charged.chargeId);
          },
        };
      }
      case 'reverse': {
        const transactionId = pick(reversible);
        return {
          name,
          run: async () => {
            if (!transactionId) return;
            await ledger.reverse({ transactionId, reason: 'simulation', adminId }, ctx);
          },
        };
      }
      case 'reverse_charge': {
        const chargeId = pick(charges);
        return {
          name,
          run: async () => {
            if (!chargeId) return;
            await ledger.run(undefined, (tx) =>
              ledger.reverseTrainingCharge(tx, { chargeId, reason: 'simulation', adminId }, ctx),
            );
          },
        };
      }
      case 'refund_cash':
        return {
          name,
          run: async () => {
            const result = await ledger.refundCash(
              { userId, amountMinor: amount, reason: 'simulation', adminId, idempotencyKey: key },
              ctx,
            );
            reversible.push(result.transaction.id);
          },
        };
      case 'online_top_up': {
        // €2.50 … €50.00 (below the €5 minimum is rejected)
        const topUp = int(1, poor ? 6 : 20) * 250;
        const failFirst = random() < 0.1;
        const duplicates = int(1, 3);
        return {
          name,
          run: async () => {
            const intent = await payments.createTopUp(
              userId,
              { amountMinor: topUp, currency: 'EUR' },
              key,
              { ...ctx, actor: { id: userId, role: 'USER' } },
            );
            const payment = await prisma.payment.findUniqueOrThrow({
              where: { id: intent.paymentId },
            });
            const intentId = payment.providerPaymentId!;
            if (failFirst) {
              provider.complete(intentId, {
                status: 'requires_payment_method',
                amountReceivedMinor: 0,
                lastErrorCode: 'card_declined',
              });
              await deliver('payment_intent.payment_failed', provider.intentObject(intentId));
            }
            provider.complete(intentId, { lastErrorCode: null });
            await deliver('payment_intent.succeeded', provider.intentObject(intentId), duplicates);
            paid.push({ userId, paymentId: payment.id, intentId, amountMinor: topUp });
          },
        };
      }
      case 'card_refund': {
        const target = pick(paid);
        return {
          name,
          run: async () => {
            if (!target) return;
            await payments.refundToCard(
              {
                userId: target.userId,
                paymentId: target.paymentId,
                amountMinor: amount,
                reason: 'simulation',
                adminId,
                idempotencyKey: key,
              },
              ctx,
            );
          },
        };
      }
      case 'dispute': {
        const target = pick(paid.filter((p) => !disputed.has(p.paymentId)));
        const won = random() < 0.5;
        return {
          name,
          run: async () => {
            if (!target) return;
            disputed.add(target.paymentId);
            const dispute = {
              id: `dp_${randomUUID().replaceAll('-', '')}`,
              object: 'dispute',
              amount: target.amountMinor,
              payment_intent: target.intentId,
              reason: 'fraudulent',
              status: 'needs_response',
            };
            // A chargeback cannot be refused: what the wallet lacks becomes debt.
            await deliver('charge.dispute.created', dispute, 2);
            await deliver('charge.dispute.closed', { ...dispute, status: won ? 'won' : 'lost' }, 2);
          },
        };
      }
    }
  }

  // ── Run with a pool of concurrent workers ──────────────────────────────
  let issued = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (issued < options.operations) {
      const op = plan(issued);
      issued += 1;
      try {
        await op.run();
        stats[op.name]!.ok += 1;
      } catch (error) {
        if (error instanceof AppError && EXPECTED.has(error.code)) {
          stats[op.name]!.rejected += 1;
          rejections[error.code] = (rejections[error.code] ?? 0) + 1;
        } else {
          failures.push({
            op: op.name,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
        }
      }
      done += 1;
      if (done % 500 === 0) options.onProgress?.(done);
    }
  }
  await Promise.all(Array.from({ length: options.concurrency ?? 12 }, () => worker()));

  // ── Verify ─────────────────────────────────────────────────────────────
  const report = await reconciliation.run();
  const wallets = await prisma.wallet.findMany({
    select: { id: true, balanceMinor: true, debtMinor: true },
  });
  const invariantViolations: string[] = [];
  for (const w of wallets) {
    if (w.balanceMinor < 0 || w.debtMinor < 0)
      invariantViolations.push(`${w.id}: negative balance or debt`);
    // Credits settle debt first and charges spend the wallet first, so both can never be positive.
    if (w.balanceMinor > 0 && w.debtMinor > 0) {
      invariantViolations.push(`${w.id}: balance ${w.balanceMinor} while owing ${w.debtMinor}`);
    }
  }

  return {
    durationMs: Date.now() - started,
    stats,
    rejections,
    failures,
    replayMismatches,
    invariantViolations,
    reconciliation: report,
    totals: {
      wallets: wallets.length,
      transactions: await prisma.walletTransaction.count(),
      balanceMinor: wallets.reduce((s, w) => s + w.balanceMinor, 0),
      debtMinor: wallets.reduce((s, w) => s + w.debtMinor, 0),
    },
  };
}
