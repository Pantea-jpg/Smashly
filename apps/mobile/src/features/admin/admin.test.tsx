import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AdminUserDetail, AttendanceRow, Dashboard } from '@tw/contracts';
import * as SecureStore from 'expo-secure-store';
import { Alert, type AlertButton } from 'react-native';
import {
  apiError,
  mockApi,
  type MockRequest,
  type MockResponse,
  ok,
  session,
} from '../../../test/api';
import { adminTraining, eur, offsetPage, transaction } from '../../../test/money';
import { App } from '../../app/App';
import { resetSessionStoreForTests } from '../../shared/auth/session';
import { useViewAsStore } from '../../shared/auth/viewAs';
import { usePreferencesStore } from '../../stores/preferences.store';

jest.setTimeout(20_000);
const keychain = (SecureStore as unknown as { __store: Map<string, string> }).__store;
type Routes = Record<string, (r: MockRequest) => MockResponse | Promise<MockResponse>>;
const ANNA = '0192f6d2-7a3c-7b1e-9f00-0000000aa001';

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    period: { from: new Date().toISOString(), to: new Date().toISOString() },
    users: { total: 12, active: 10, pendingApproval: 0 },
    upcomingTrainings: 3,
    totalWalletBalances: eur(45_000),
    outstandingDebt: eur(1200),
    onlineTopUps: eur(30_000),
    cashPayments: eur(5000),
    trainingRevenue: eur(22_000),
    needsAttention: {
      paymentsRequiringReview: 0,
      trainingsAwaitingFinalization: 1,
      reconciliationIssues: 0,
    },
    recentTransactions: [],
    ...overrides,
  };
}

function anna(): AdminUserDetail {
  return {
    id: ANNA,
    email: 'anna@example.test',
    firstName: 'Anna',
    lastName: 'de Vries',
    avatarUrl: null,
    role: 'USER',
    status: 'ACTIVE',
    emailVerified: true,
    balance: eur(2500),
    debt: eur(0),
    createdAt: '2026-01-15T10:00:00.000Z',
    lastLoginAt: null,
    phone: null,
    preferredLanguage: 'nl',
    deletedAt: null,
  };
}

function row(overrides: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    user: { id: ANNA, email: 'anna@example.test', firstName: 'Anna', lastName: 'de Vries' },
    reservation: 'ATTENDING',
    status: 'PENDING',
    note: null,
    markedAt: null,
    price: { price: eur(1000), source: 'TRAINING_DEFAULT' },
    charge: null,
    ...overrides,
  };
}

function adminRoutes(extra: Routes = {}): Routes {
  return {
    'POST /auth/login': () => ok(session({ role: 'ADMIN', firstName: 'Ada', lastName: 'Admin' })),
    'GET /admin/dashboard': () => ok(dashboard()),
    ...extra,
  };
}

async function signInAsAdmin() {
  await render(<App />);
  await fireEvent.changeText(await screen.findByTestId('field-email'), 'ada@example.test');
  await fireEvent.changeText(screen.getByTestId('field-password'), 'correct horse battery');
  await fireEvent.press(screen.getByTestId('login-submit'));
  await screen.findByTestId('admin-dashboard');
}

/** Presses the confirming (last) button of every native dialog. */
function autoConfirm() {
  return jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      buttons?.[buttons.length - 1]?.onPress?.();
    });
}

beforeEach(() => {
  keychain.clear();
  resetSessionStoreForTests();
  useViewAsStore.setState({ session: null });
  usePreferencesStore.setState({ language: 'en', appearance: 'system' });
});

describe('admin dashboard', () => {
  it('shows KPIs and links what needs attention to the finalization queue', async () => {
    const training = adminTraining({
      startsAt: new Date(Date.now() - 30 * 3_600_000).toISOString(),
    });
    mockApi(
      adminRoutes({
        'GET /admin/attendance/queue': () => {
          const { counts: _c, createdById: _a, finalizedById: _f, ...base } = training;
          return ok([{ training: base, pending: 2, present: 3, hoursSinceEnd: 29 }]);
        },
      }),
    );
    await signInAsAdmin();
    expect(await screen.findByTestId('kpi-balances')).toHaveTextContent('€450.00');
    expect(screen.getByTestId('kpi-debt')).toHaveTextContent('€12.00');
    await fireEvent.press(await screen.findByText('1 training to finalize'));
    expect(await screen.findByTestId('attendance-queue')).toBeTruthy();
    expect(await screen.findByText('2 pending')).toBeTruthy();
  });
});

describe('cash payment', () => {
  it('confirms, sends one idempotent request and returns to the member', async () => {
    const confirmSpy = autoConfirm();
    const requests = mockApi(
      adminRoutes({
        'GET /admin/users': () => offsetPage([anna()]),
        [`GET /admin/users/${ANNA}`]: () => ok(anna()),
        [`GET /admin/users/${ANNA}/transactions`]: () => offsetPage([transaction()]),
        [`GET /admin/users/${ANNA}/trainings`]: () => offsetPage([]),
        [`POST /admin/users/${ANNA}/cash-payments`]: () =>
          ok(
            {
              transaction: {
                ...transaction(),
                userId: ANNA,
                sequence: 2,
                balanceBefore: eur(2500),
                debtBefore: eur(0),
                createdByAdminId: null,
              },
              settlements: [],
              wallet: { balance: eur(5000), debt: eur(0) },
            },
            201,
          ),
      }),
    );
    await signInAsAdmin();
    await fireEvent.press((await screen.findAllByText('Users'))[0]!);
    await fireEvent.press(await screen.findByText('Anna de Vries'));
    await fireEvent.press(await screen.findByTestId('record-cash'));
    await fireEvent.changeText(await screen.findByTestId('cash-amount'), '25,00');
    await fireEvent.press(screen.getByTestId('submit-cash'));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/cash-payments'))).toBe(
        true,
      ),
    );
    const post = requests.find((r) => r.method === 'POST' && r.path.endsWith('/cash-payments'))!;
    expect(post.body).toEqual({ amountMinor: 2500 });
    expect(post.headers['idempotency-key']).toMatch(/^m-/);
    expect(confirmSpy).toHaveBeenCalledWith(
      'Record €25.00 in cash from Anna de Vries?',
      expect.any(String),
      expect.any(Array),
    );
    // Back on the member once the balance and lists have refreshed.
    expect(await screen.findByTestId('user-detail-screen', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('rejects an empty or zero amount before asking', async () => {
    mockApi(
      adminRoutes({
        'GET /admin/users': () => offsetPage([anna()]),
        [`GET /admin/users/${ANNA}`]: () => ok(anna()),
        [`GET /admin/users/${ANNA}/transactions`]: () => offsetPage([]),
        [`GET /admin/users/${ANNA}/trainings`]: () => offsetPage([]),
      }),
    );
    await signInAsAdmin();
    await fireEvent.press((await screen.findAllByText('Users'))[0]!);
    await fireEvent.press(await screen.findByText('Anna de Vries'));
    await fireEvent.press(await screen.findByTestId('record-cash'));
    await fireEvent.changeText(await screen.findByTestId('cash-amount'), '0');
    expect(screen.getByText('Enter an amount greater than zero')).toBeTruthy();
  });
});

/** A LedgerResult response for money operations on Anna. */
function ledgerResult(walletMinor: number, debtMinor = 0) {
  return ok(
    {
      transaction: {
        ...transaction(),
        userId: ANNA,
        sequence: 3,
        balanceBefore: eur(2500),
        debtBefore: eur(0),
        createdByAdminId: null,
      },
      settlements: [],
      wallet: { balance: eur(walletMinor), debt: eur(debtMinor) },
    },
    201,
  );
}

function annaRoutes(extra: Routes = {}): Routes {
  return adminRoutes({
    'GET /admin/users': () => offsetPage([anna()]),
    [`GET /admin/users/${ANNA}`]: () => ok(anna()),
    [`GET /admin/users/${ANNA}/transactions`]: () => offsetPage([cashTx]),
    [`GET /admin/users/${ANNA}/trainings`]: () => offsetPage([]),
    ...extra,
  });
}
const cashTx = {
  ...transaction({ id: '0192f6d2-7a3c-7b1e-9f00-0000000cc001' }),
  userId: ANNA,
  sequence: 1,
  balanceBefore: eur(0),
  debtBefore: eur(0),
  createdByAdminId: null,
};

async function openAnna() {
  await signInAsAdmin();
  await fireEvent.press((await screen.findAllByText('Users'))[0]!);
  await fireEvent.press(await screen.findByText('Anna de Vries'));
  await screen.findByTestId('user-detail-screen');
}

describe('adjustments and reversals', () => {
  it('removes credit with a reason after confirming, sending one idempotent request', async () => {
    const confirmSpy = autoConfirm();
    const requests = mockApi(
      annaRoutes({ [`POST /admin/users/${ANNA}/adjustments`]: () => ledgerResult(1500) }),
    );
    await openAnna();
    await fireEvent.press(screen.getByTestId('open-adjustment'));
    await screen.findByTestId('adjustment-screen');
    await fireEvent.press(screen.getByTestId('adjust-kind-DEBIT'));
    await fireEvent.changeText(screen.getByTestId('adjust-amount'), '10');
    await fireEvent.changeText(screen.getByTestId('adjust-reason'), 'Paid twice by mistake');
    await fireEvent.press(screen.getByTestId('submit-adjustment'));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/adjustments'))).toBe(
        true,
      ),
    );
    const post = requests.find((r) => r.method === 'POST' && r.path.endsWith('/adjustments'))!;
    expect(post.body).toEqual({
      kind: 'DEBIT',
      amountMinor: 1000,
      reason: 'Paid twice by mistake',
    });
    expect(post.headers['idempotency-key']).toMatch(/^m-/);
    expect(confirmSpy).toHaveBeenCalled();
    expect(await screen.findByTestId('user-detail-screen', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('shows the server refusal (more than the balance) without leaving the screen', async () => {
    autoConfirm();
    mockApi(
      annaRoutes({
        [`POST /admin/users/${ANNA}/adjustments`]: () => apiError(422, 'INSUFFICIENT_BALANCE'),
      }),
    );
    await openAnna();
    await fireEvent.press(screen.getByTestId('open-adjustment'));
    await fireEvent.press(await screen.findByTestId('adjust-kind-DEBIT'));
    await fireEvent.changeText(screen.getByTestId('adjust-amount'), '99');
    await fireEvent.changeText(screen.getByTestId('adjust-reason'), 'Too much');
    await fireEvent.press(screen.getByTestId('submit-adjustment'));
    expect(await screen.findByText(/balance/i)).toBeTruthy();
    expect(screen.getByTestId('adjustment-screen')).toBeTruthy();
  });

  it('reverses a cash top-up from the full history, with a required reason', async () => {
    const requests = mockApi(
      annaRoutes({
        [`POST /admin/transactions/${cashTx.id}/reversal`]: () => ledgerResult(0),
      }),
    );
    await openAnna();
    await fireEvent.press(await screen.findByTestId('all-user-transactions'));
    await fireEvent.press(await screen.findByTestId(`user-tx-${cashTx.id}`));
    await screen.findByTestId('reversal-screen');
    expect(screen.getByTestId('submit-reversal')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('reversal-reason'), 'Entered twice');
    await fireEvent.press(screen.getByTestId('submit-reversal'));
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/reversal'))).toBe(true),
    );
    const post = requests.find((r) => r.method === 'POST' && r.path.endsWith('/reversal'))!;
    expect(post.body).toEqual({ reason: 'Entered twice' });
    expect(post.headers['idempotency-key']).toMatch(/^m-/);
    expect(await screen.findByTestId('user-transactions', {}, { timeout: 5000 })).toBeTruthy();
  });
});

describe('refunds (D17)', () => {
  const payment = (
    id: string,
    amountMinor: number,
    refundedMinor: number,
    status = 'SUCCEEDED',
  ) => ({
    id,
    status,
    amount: eur(amountMinor),
    refundedAmount: eur(refundedMinor),
    methodType: 'card',
    failureCode: null,
    createdAt: new Date().toISOString(),
    succeededAt: new Date().toISOString(),
  });
  const PAID = '0192f6d2-7a3c-7b1e-9f00-0000000dd001';
  const USED_UP = '0192f6d2-7a3c-7b1e-9f00-0000000dd002';

  it('refunds unused balance in cash after confirming, within the balance', async () => {
    const confirmSpy = autoConfirm();
    const requests = mockApi(
      annaRoutes({
        [`GET /admin/users/${ANNA}/payments`]: () => ok([]),
        [`POST /admin/users/${ANNA}/refunds`]: () => ledgerResult(1500),
      }),
    );
    await openAnna();
    await fireEvent.press(screen.getByTestId('open-refund'));
    await screen.findByTestId('refund-screen');
    expect(await screen.findByText('Available to refund: €25.00')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('refund-amount'), '30');
    await fireEvent.changeText(screen.getByTestId('refund-reason'), 'Moving away');
    expect(screen.getByTestId('submit-refund')).toBeDisabled(); // more than the balance
    await fireEvent.changeText(screen.getByTestId('refund-amount'), '10');
    await fireEvent.press(screen.getByTestId('submit-refund'));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/refunds'))).toBe(true),
    );
    const post = requests.find((r) => r.method === 'POST' && r.path.endsWith('/refunds'))!;
    expect(post.body).toEqual({ method: 'CASH', amountMinor: 1000, reason: 'Moving away' });
    expect(post.headers['idempotency-key']).toMatch(/^m-/);
    expect(confirmSpy).toHaveBeenCalledWith(
      'Refund €10.00 to Anna de Vries?',
      expect.stringContaining('cash'),
      expect.any(Array),
    );
    expect(await screen.findByTestId('user-detail-screen', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('refunds to the card of a chosen top-up, limited to what is left of it', async () => {
    autoConfirm();
    const requests = mockApi(
      annaRoutes({
        [`GET /admin/users/${ANNA}/payments`]: () =>
          ok([payment(PAID, 2000, 500, 'PARTIALLY_REFUNDED'), payment(USED_UP, 1000, 1000)]),
        [`POST /admin/users/${ANNA}/refunds`]: () => ledgerResult(1000),
      }),
    );
    await openAnna();
    await fireEvent.press(screen.getByTestId('open-refund'));
    await fireEvent.press(await screen.findByTestId('refund-method-STRIPE'));
    // A fully refunded top-up is not offered.
    expect(await screen.findByTestId(`refund-payment-${PAID}`)).toBeTruthy();
    expect(screen.queryByTestId(`refund-payment-${USED_UP}`)).toBeNull();
    expect(screen.getByText(/€15.00 refundable/)).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('refund-amount'), '15');
    await fireEvent.changeText(screen.getByTestId('refund-reason'), 'Unused balance');
    expect(screen.getByTestId('submit-refund')).toBeDisabled(); // no top-up chosen yet
    await fireEvent.press(screen.getByTestId(`refund-payment-${PAID}`));
    await fireEvent.press(screen.getByTestId('submit-refund'));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/refunds'))).toBe(true),
    );
    expect(requests.find((r) => r.method === 'POST' && r.path.endsWith('/refunds'))!.body).toEqual({
      method: 'STRIPE',
      amountMinor: 1500,
      reason: 'Unused balance',
      paymentId: PAID,
    });
  });

  it('suggests cash when no top-up can be refunded to the card', async () => {
    mockApi(annaRoutes({ [`GET /admin/users/${ANNA}/payments`]: () => ok([]) }));
    await openAnna();
    await fireEvent.press(screen.getByTestId('open-refund'));
    await fireEvent.press(await screen.findByTestId('refund-method-STRIPE'));
    expect(await screen.findByText(/Refund in cash instead/)).toBeTruthy();
  });
});

describe('finance', () => {
  it('shows the month summary, wallets with search, and all transactions', async () => {
    const requests = mockApi(
      adminRoutes({
        'GET /admin/reports/summary': () =>
          ok({
            period: { from: new Date().toISOString(), to: new Date().toISOString() },
            topUps: { online: eur(30_000), cash: eur(5000), adjustmentsCredit: eur(0) },
            refunds: eur(1500),
            trainingRevenue: {
              charged: eur(22_000),
              collected: eur(20_800),
              outstanding: eur(1200),
            },
            debt: { created: eur(1200), settled: eur(0), waived: eur(0) },
            reversals: { count: 0, amount: eur(0) },
          }),
        'GET /admin/wallets': () =>
          offsetPage([
            {
              id: '0192f6d2-7a3c-7b1e-9f00-0000000ee001',
              userId: ANNA,
              email: 'anna@example.test',
              firstName: 'Anna',
              lastName: 'de Vries',
              balance: eur(2500),
              debt: eur(0),
              updatedAt: new Date().toISOString(),
            },
          ]),
        'GET /admin/transactions': () => offsetPage([cashTx]),
      }),
    );
    await signInAsAdmin();
    await fireEvent.press(screen.getByTestId('tab-finance'));
    expect(await screen.findByText('This month')).toBeTruthy();
    expect(screen.getByText('€220.00')).toBeTruthy();
    expect(await screen.findByTestId(`wallet-${ANNA}`)).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('wallet-search'), 'anna');
    await waitFor(() =>
      expect(
        requests.some((r) => r.path.startsWith('/admin/wallets') && r.path.includes('anna')),
      ).toBe(true),
    );

    await fireEvent.press(screen.getByTestId('finance-tab-transactions'));
    expect(await screen.findByTestId('finance-transactions')).toBeTruthy();
    expect(await screen.findByText('Cash payment')).toBeTruthy();
  });
});

describe('attendance and finalization', () => {
  it('marks present, finalizes, and handles members still pending', async () => {
    autoConfirm();
    const training = adminTraining({
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    const ben = '0192f6d2-7a3c-7b1e-9f00-0000000bb002';
    let rows = [
      row(),
      row({ user: { id: ben, email: 'ben@example.test', firstName: 'Ben', lastName: 'Bakker' } }),
    ];
    let finalizeCalls = 0;
    const requests = mockApi(
      adminRoutes({
        'GET /admin/trainings': () => offsetPage([training]),
        [`GET /admin/trainings/${training.id}`]: () => ok(training),
        [`GET /admin/trainings/${training.id}/attendance`]: () => ok(rows),
        [`PUT /admin/trainings/${training.id}/attendance`]: (r) => {
          const entries = (
            r.body as { entries: { userId: string; status: AttendanceRow['status'] }[] }
          ).entries;
          rows = rows.map((x) => ({
            ...x,
            status: entries.find((e) => e.userId === x.user.id)?.status ?? x.status,
          }));
          return ok(rows);
        },
        [`POST /admin/trainings/${training.id}/attendance/finalize`]: (r) => {
          finalizeCalls += 1;
          if (!(r.body as { pendingAs?: string }).pendingAs) {
            return {
              status: 409,
              body: {
                error: {
                  code: 'ATTENDANCE_HAS_PENDING',
                  message: 'x',
                  details: { pending: 1 },
                  requestId: 't',
                },
              },
            };
          }
          return ok({
            training: { ...training, status: 'COMPLETED', finalizedAt: new Date().toISOString() },
            charged: 1,
            totalCharged: eur(1000),
            paidFromWallets: eur(600),
            debtCreated: eur(400),
          });
        },
      }),
    );
    await signInAsAdmin();
    await fireEvent.press((await screen.findAllByText('Trainings'))[0]!);
    await fireEvent.press(await screen.findByTestId(`admin-training-${training.id}`));
    await fireEvent.press(await screen.findByTestId('open-attendance'));
    await fireEvent.press(await screen.findByTestId(`mark-${ANNA}-PRESENT`));
    await fireEvent.press(screen.getByTestId('finalize-attendance'));

    expect(await screen.findByTestId('finalize-result')).toHaveTextContent(
      /1 charged, €10\.00 in total, €4\.00 became debt/,
    );
    expect(finalizeCalls).toBe(2);
    const finals = requests.filter((r) => r.path.endsWith('/finalize'));
    // The retry with pendingAs reuses the same idempotency key (one intent).
    expect(finals[0]!.headers['idempotency-key']).toBe(finals[1]!.headers['idempotency-key']);
    expect(finals[1]!.body).toEqual({ pendingAs: 'ABSENT' });
    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
      entries: [{ userId: ANNA, status: 'PRESENT' }],
    });
  });

  it('explains that attendance waits for the start', async () => {
    const training = adminTraining();
    mockApi(
      adminRoutes({
        'GET /admin/trainings': () => offsetPage([training]),
        [`GET /admin/trainings/${training.id}`]: () => ok(training),
        [`GET /admin/trainings/${training.id}/attendance`]: () => ok([row()]),
      }),
    );
    await signInAsAdmin();
    await fireEvent.press((await screen.findAllByText('Trainings'))[0]!);
    await fireEvent.press(await screen.findByTestId(`admin-training-${training.id}`));
    await fireEvent.press(await screen.findByTestId('open-attendance'));
    expect(
      await screen.findByText('Attendance can be recorded once the training has started.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('finalize-attendance')).toBeNull();
  });
});

describe('creating a training', () => {
  it('validates the form and posts local times as ISO instants', async () => {
    const requests = mockApi(
      adminRoutes({
        'GET /admin/trainings': () => offsetPage([]),
        'POST /admin/trainings': (r) => ok({ ...adminTraining(), ...(r.body as object) }, 201),
      }),
    );
    await signInAsAdmin();
    await fireEvent.press((await screen.findAllByText('Trainings'))[0]!);
    await fireEvent.press(await screen.findByTestId('new-training'));
    await fireEvent.changeText(await screen.findByTestId('tf-end'), '18:00');
    await fireEvent.press(screen.getByTestId('save-training'));
    expect(screen.getAllByText('Required')).toHaveLength(2);
    expect(screen.getByText('The end must be after the start')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('tf-title'), 'Thursday club');
    await fireEvent.changeText(screen.getByTestId('tf-location'), 'Hall B');
    await fireEvent.changeText(screen.getByTestId('tf-date'), '2027-03-04');
    await fireEvent.changeText(screen.getByTestId('tf-start'), '19:00');
    await fireEvent.changeText(screen.getByTestId('tf-end'), '20:30');
    await fireEvent.changeText(screen.getByTestId('tf-capacity'), '12');
    await fireEvent.changeText(screen.getByTestId('tf-price'), '12,50');
    await fireEvent.changeText(screen.getByTestId('tf-deadline'), '2');
    await fireEvent.press(screen.getByTestId('save-training'));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.path === '/admin/trainings')).toBe(true),
    );
    const body = requests.find((r) => r.method === 'POST' && r.path === '/admin/trainings')!
      .body as Record<string, unknown>;
    expect(body).toMatchObject({
      title: 'Thursday club',
      location: 'Hall B',
      capacity: 12,
      defaultPriceMinor: 1250,
      description: null,
    });
    expect(body['startsAt']).toBe(new Date(2027, 2, 4, 19, 0).toISOString());
    expect(body['endsAt']).toBe(new Date(2027, 2, 4, 20, 30).toISOString());
    expect(body['reservationDeadline']).toBe(new Date(2027, 2, 4, 17, 0).toISOString());
  });

  it('shows a translated server error', async () => {
    mockApi(
      adminRoutes({
        'GET /admin/trainings': () => offsetPage([]),
        'POST /admin/trainings': () => apiError(400, 'VALIDATION_ERROR'),
      }),
    );
    await signInAsAdmin();
    await fireEvent.press((await screen.findAllByText('Trainings'))[0]!);
    await fireEvent.press(await screen.findByTestId('new-training'));
    await fireEvent.changeText(await screen.findByTestId('tf-title'), 'X');
    await fireEvent.changeText(screen.getByTestId('tf-location'), 'Y');
    await fireEvent.press(screen.getByTestId('save-training'));
    expect(await screen.findByText(/check/i)).toBeTruthy();
  });
});
