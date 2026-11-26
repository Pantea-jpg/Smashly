import type { AdminTraining, MeTraining, Notification, Transaction, Wallet } from '@tw/contracts';
import type { MockResponse } from './api';

export const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR' as const });
const HOUR = 3_600_000;
let id = 0;
/** Valid UUIDv7-shaped ids (the app validates every response). */
export const uuid = (_kind = '') =>
  `0192f6d2-7a3c-7b1e-9f00-${(id += 1).toString(16).padStart(12, '0')}`;

export function wallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: '0192f6d2-7a3c-7b1e-9f00-00000000aaaa',
    balance: eur(2500),
    debt: eur(0),
    topUpLimits: {
      minMinor: 500,
      maxMinor: 50_000,
      maxBalanceMinor: 100_000,
      presetsMinor: [1000, 2500, 5000, 10_000],
    },
    canTopUp: true,
    ...overrides,
  };
}

export function meTraining(overrides: Partial<MeTraining> = {}): MeTraining {
  const start = Date.now() + 24 * HOUR;
  return {
    id: uuid('t'),
    seriesId: null,
    title: 'Tuesday training',
    description: null,
    location: 'Hall A',
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + HOUR).toISOString(),
    timezone: 'Europe/Amsterdam',
    capacity: 12,
    attendingCount: 4,
    spotsLeft: 8,
    defaultPrice: eur(1000),
    reservationDeadline: new Date(start).toISOString(),
    deadlinePassed: false,
    status: 'SCHEDULED',
    cancelledAt: null,
    cancellationReason: null,
    finalizedAt: null,
    myPrice: { price: eur(1000), source: 'TRAINING_DEFAULT' },
    myReservation: null,
    myAttendance: null,
    myCharge: null,
    ...overrides,
  };
}

export function adminTraining(overrides: Partial<AdminTraining> = {}): AdminTraining {
  const { myPrice: _p, myReservation: _r, myAttendance: _a, myCharge: _c, ...base } = meTraining();
  return {
    ...base,
    createdById: uuid('ad'),
    finalizedById: null,
    counts: {
      attending: 4,
      notAttending: 1,
      noResponse: 3,
      present: 0,
      absent: 0,
      excused: 0,
      pending: 4,
    },
    ...overrides,
  };
}

export function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: uuid('x'),
    type: 'CASH_TOP_UP',
    status: 'POSTED',
    amount: eur(2500),
    walletDelta: eur(2500),
    debtDelta: eur(0),
    balanceAfter: eur(2500),
    debtAfter: eur(0),
    paymentMethod: 'CASH',
    description: 'Cash payment',
    reason: null,
    trainingId: null,
    paymentId: null,
    reversesTransactionId: null,
    reversedByTransactionId: null,
    groupId: uuid('g'),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: uuid('n'),
    type: 'TOP_UP_SUCCEEDED',
    category: 'PAYMENTS',
    params: { amountMinor: 2500, currency: 'EUR' },
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A cursor-list response. */
export function cursorPage(items: unknown[]): MockResponse {
  return {
    status: 200,
    body: { data: items, meta: { requestId: 't', page: { nextCursor: null, hasMore: false } } },
  };
}

export function offsetPage(items: unknown[]): MockResponse {
  return {
    status: 200,
    body: {
      data: items,
      meta: { requestId: 't', page: { page: 1, pageSize: 25, total: items.length } },
    },
  };
}
