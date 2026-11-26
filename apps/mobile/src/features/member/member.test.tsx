import { presentPaymentSheet } from '@stripe/stripe-react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { MeTraining, Payment } from '@tw/contracts';
import * as SecureStore from 'expo-secure-store';
import {
  apiError,
  mockApi,
  type MockRequest,
  type MockResponse,
  ok,
  session,
} from '../../../test/api';
import {
  cursorPage,
  eur,
  meTraining,
  notification,
  transaction,
  uuid,
  wallet,
} from '../../../test/money';
import { App } from '../../app/App';
import { resetSessionStoreForTests } from '../../shared/auth/session';
import { useViewAsStore } from '../../shared/auth/viewAs';
import { usePreferencesStore } from '../../stores/preferences.store';

const keychain = (SecureStore as unknown as { __store: Map<string, string> }).__store;
jest.setTimeout(20_000);
type Routes = Record<string, (r: MockRequest) => MockResponse | Promise<MockResponse>>;

function memberRoutes(extra: Routes = {}, training: MeTraining = meTraining()): Routes {
  return {
    'POST /auth/login': () => ok(session()),
    'GET /me/wallet': () => ok(wallet()),
    'GET /me/trainings': () => cursorPage([training]),
    [`GET /me/trainings/${training.id}`]: () => ok(training),
    'GET /me/transactions': () => cursorPage([transaction()]),
    'GET /me/debts': () => ok([]),
    'GET /me/notifications/unread-count': () => ok({ unread: 0 }),
    'GET /me/notifications': () => cursorPage([]),
    ...extra,
  };
}

async function signIn() {
  await render(<App />);
  await fireEvent.changeText(await screen.findByTestId('field-email'), 'anna@example.test');
  await fireEvent.changeText(screen.getByTestId('field-password'), 'correct horse battery');
  await fireEvent.press(screen.getByTestId('login-submit'));
  await screen.findByTestId('home-screen');
}

beforeEach(() => {
  keychain.clear();
  resetSessionStoreForTests();
  useViewAsStore.setState({ session: null });
  usePreferencesStore.setState({ language: 'en', appearance: 'system' });
  jest.mocked(presentPaymentSheet).mockResolvedValue({});
});

describe('member home', () => {
  it('shows the wallet first, the debt banner, the next training and unread notifications', async () => {
    mockApi(
      memberRoutes({
        'GET /me/wallet': () => ok(wallet({ balance: eur(0), debt: eur(400) })),
        'GET /me/notifications/unread-count': () => ok({ unread: 2 }),
      }),
    );
    await signIn();
    expect(await screen.findByText('Hi Anna')).toBeTruthy();
    expect(await screen.findByTestId('debt-banner')).toBeTruthy();
    expect(screen.getByText(/You have €4.00 outstanding/)).toBeTruthy();
    expect(screen.getByTestId('home-debt')).toHaveTextContent('€4.00');
    expect(await screen.findByTestId('next-training')).toBeTruthy();
    expect(await screen.findByText('2 unread notifications')).toBeTruthy();
    expect(await screen.findByText('Cash payment')).toBeTruthy();
  });

  it('shows a retry state when the wallet cannot load', async () => {
    let fail = true;
    mockApi(
      memberRoutes({
        'GET /me/wallet': () => (fail ? apiError(500, 'INTERNAL_ERROR') : ok(wallet())),
      }),
    );
    await signIn();
    // React Query retries twice before showing the error.
    const retry = await screen.findByTestId('retry', {}, { timeout: 10_000 });
    fail = false;
    await fireEvent.press(retry);
    expect(await screen.findByTestId('home-balance', {}, { timeout: 5000 })).toHaveTextContent(
      '€25.00',
    );
  }, 20_000);

  it('switches to Dutch', async () => {
    usePreferencesStore.setState({ language: 'nl', appearance: 'system' });
    mockApi(memberRoutes());
    await signIn();
    expect(await screen.findByText('Hoi Anna')).toBeTruthy();
    expect(await screen.findByText('Saldo')).toBeTruthy();
    expect(await screen.findByTestId('home-balance')).toHaveTextContent('€ 25,00');
  });
});

describe('trainings and reservations', () => {
  it('reserves from the detail screen and shows the debt warning', async () => {
    const training = meTraining();
    const requests = mockApi(
      memberRoutes(
        {
          [`PUT /me/trainings/${training.id}/reservation`]: () =>
            ok({
              training: { ...training, myReservation: 'ATTENDING', spotsLeft: 7 },
              warning: 'OUTSTANDING_DEBT',
            }),
        },
        training,
      ),
    );
    await signIn();
    await fireEvent.press(await screen.findByTestId('next-training'));
    expect(await screen.findByTestId('training-detail')).toBeTruthy();
    expect(screen.getByTestId('my-price')).toHaveTextContent('€10.00');
    expect(screen.getByText('Standard price')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('reserve-attending'));
    expect(await screen.findByTestId('debt-warning')).toBeTruthy();
    expect(screen.getByTestId('training-state')).toHaveTextContent('Attending');
    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({ status: 'ATTENDING' });
  });

  it('shows a full training and translated errors', async () => {
    const training = meTraining({ spotsLeft: 0 });
    mockApi(
      memberRoutes(
        { [`PUT /me/trainings/${training.id}/reservation`]: () => apiError(409, 'TRAINING_FULL') },
        training,
      ),
    );
    await signIn();
    await fireEvent.press(await screen.findByTestId('next-training'));
    expect(await screen.findByText('Full')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('reserve-not-attending'));
    expect(await screen.findByText('This training is full.')).toBeTruthy();
  });

  it('hides the buttons after the deadline and shows the charge after finalization', async () => {
    const training = meTraining({
      deadlinePassed: true,
      finalizedAt: new Date().toISOString(),
      myReservation: 'ATTENDING',
      myAttendance: 'PRESENT',
      myCharge: {
        id: '0192f6d2-7a3c-7b1e-9f00-00000000c001',
        status: 'ACTIVE',
        unitPrice: eur(1000),
        priceSource: 'TRAINING_DEFAULT',
        paidFromWallet: eur(600),
        shortfall: eur(400),
        createdAt: new Date().toISOString(),
      },
    });
    mockApi(memberRoutes({}, training));
    await signIn();
    await fireEvent.press(await screen.findByTestId('next-training'));
    expect(await screen.findByTestId('my-charge')).toHaveTextContent(
      'Charged €10.00, of which €4.00 is outstanding',
    );
    expect(screen.getByTestId('my-attendance')).toHaveTextContent('Present');
    expect(screen.queryByTestId('reserve-attending')).toBeNull();
  });
});

describe('top-up with PaymentSheet', () => {
  const PAYMENT_ID = '0192f6d2-7a3c-7b1e-9f00-0000000a0001';
  const intent = {
    paymentId: PAYMENT_ID,
    clientSecret: 'pi_1_secret_x',
    publishableKey: 'pk_test_x',
    amount: eur(2500),
  };
  const payment = (status: Payment['status']): Payment => ({
    id: PAYMENT_ID,
    status,
    amount: eur(2500),
    refundedAmount: eur(0),
    methodType: 'card',
    failureCode: null,
    createdAt: new Date().toISOString(),
    succeededAt: status === 'SUCCEEDED' ? new Date().toISOString() : null,
  });

  async function openTopUp() {
    await signIn();
    await fireEvent.press(await screen.findByTestId('home-top-up'));
    await screen.findByTestId('top-up-screen');
  }

  it('pays a preset, waits for the webhook-confirmed payment, then reports success', async () => {
    let polls = 0;
    const requests = mockApi(
      memberRoutes({
        'POST /me/wallet/top-ups': () => ok(intent, 201),
        [`GET /me/payments/${PAYMENT_ID}`]: () =>
          ok(payment((polls += 1) < 2 ? 'PROCESSING' : 'SUCCEEDED')),
      }),
    );
    await openTopUp();
    await fireEvent.press(screen.getByTestId('preset-2500'));
    expect(screen.getByTestId('top-up-pay')).toHaveTextContent('Pay €25.00');
    await fireEvent.press(screen.getByTestId('top-up-pay'));
    expect(await screen.findByText('Confirming your payment…')).toBeTruthy();
    expect(await screen.findByTestId('top-up-success', {}, { timeout: 6000 })).toHaveTextContent(
      /€25.00 has been added to your wallet./,
    );

    const create = requests.find((r) => r.path === '/me/wallet/top-ups')!;
    expect(create.body).toEqual({ amountMinor: 2500, currency: 'EUR' });
    expect(create.headers['idempotency-key']).toMatch(/^m-/);
  }, 15_000);

  it('validates a custom amount against the limits', async () => {
    mockApi(memberRoutes());
    await openTopUp();
    await fireEvent.changeText(screen.getByTestId('top-up-custom'), '2,50');
    expect(screen.getByText('Enter an amount between €5.00 and €500.00')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('top-up-custom'), '12,50');
    expect(screen.getByTestId('top-up-pay')).toHaveTextContent('Pay €12.50');
  });

  it('reports a cancelled sheet without charging', async () => {
    jest
      .mocked(presentPaymentSheet)
      .mockResolvedValue({ error: { code: 'Canceled', message: 'x' } } as never);
    mockApi(memberRoutes({ 'POST /me/wallet/top-ups': () => ok(intent, 201) }));
    await openTopUp();
    await fireEvent.press(screen.getByTestId('preset-1000'));
    await fireEvent.press(screen.getByTestId('top-up-pay'));
    expect(await screen.findByTestId('top-up-canceled')).toBeTruthy();
  });
});

describe('wallet', () => {
  it('shows balance, debt, outstanding amounts and the history, and opens a transaction', async () => {
    const trainingId = uuid('t');
    const charge = transaction({
      type: 'TRAINING_PAYMENT',
      amount: eur(1000),
      walletDelta: eur(-700),
      debtDelta: eur(300),
      balanceAfter: eur(0),
      debtAfter: eur(300),
      paymentMethod: 'WALLET',
      description: 'Training',
      trainingId,
    });
    const reversed = transaction({ status: 'REVERSED', reason: 'Entered twice' });
    mockApi(
      memberRoutes({
        'GET /me/wallet': () => ok(wallet({ balance: eur(0), debt: eur(300) })),
        'GET /me/transactions': () => cursorPage([charge, reversed]),
        [`GET /me/transactions/${reversed.id}`]: () => ok(reversed),
        'GET /me/debts': () =>
          ok([
            {
              id: uuid('d'),
              source: 'TRAINING_CHARGE',
              status: 'OPEN',
              originalAmount: eur(300),
              outstandingAmount: eur(300),
              trainingId,
              createdAt: new Date().toISOString(),
              settledAt: null,
            },
          ]),
      }),
    );
    await signIn();
    await fireEvent.press(screen.getByTestId('tab-wallet'));
    expect(await screen.findByTestId('wallet-balance')).toHaveTextContent('€0.00');
    expect(screen.getByTestId('wallet-debt')).toHaveTextContent('€3.00');
    expect(await screen.findByText('Outstanding amounts')).toBeTruthy();
    expect(await screen.findByTestId(`tx-${charge.id}`)).toBeTruthy();
    expect(screen.getByTestId('wallet-top-up')).toBeTruthy();

    await fireEvent.press(screen.getByTestId(`tx-${reversed.id}`));
    expect(await screen.findByTestId('transaction-detail')).toBeTruthy();
    expect(screen.getAllByText('Reversed').length).toBeGreaterThan(0);
    expect(screen.getByText('Entered twice')).toBeTruthy();
  });

  it('asks an unverified member to confirm the email before topping up, and shows an empty history', async () => {
    mockApi(
      memberRoutes({
        'GET /me/wallet': () => ok(wallet({ canTopUp: false })),
        'GET /me/transactions': () => cursorPage([]),
      }),
    );
    await signIn();
    await fireEvent.press(screen.getByTestId('tab-wallet'));
    expect(await screen.findByText('Confirm your email address to top up online.')).toBeTruthy();
    expect(screen.queryByTestId('wallet-top-up')).toBeNull();
    expect(await screen.findByTestId('empty-state')).toBeTruthy();
  });
});

describe('notifications', () => {
  it('renders translated notifications and marks all as read', async () => {
    let unread = 2;
    const requests = mockApi(
      memberRoutes({
        'GET /me/notifications/unread-count': () => ok({ unread }),
        'GET /me/notifications': () =>
          cursorPage([
            notification(),
            notification({
              type: 'TRAINING_CHARGED',
              params: {
                trainingTitle: 'Tuesday training',
                amountMinor: 1000,
                shortfallMinor: 400,
                currency: 'EUR',
              },
            }),
          ]),
        'POST /me/notifications/read': () => {
          unread = 0;
          return ok({ unread: 0 });
        },
      }),
    );
    await signIn();
    await fireEvent.press((await screen.findAllByText('Notifications'))[0]!);
    expect(await screen.findByText('€25.00 has been added to your wallet.')).toBeTruthy();
    expect(screen.getByText('€10.00 for Tuesday training. €4.00 is outstanding.')).toBeTruthy();
    await fireEvent.press(await screen.findByTestId('mark-all-read'));
    await waitFor(() =>
      expect(requests.some((r) => r.path === '/me/notifications/read')).toBe(true),
    );
    expect(requests.find((r) => r.path === '/me/notifications/read')?.body).toEqual({ all: true });
  });
});

describe('View as User', () => {
  it('hides top-up and reservation controls', async () => {
    const training = meTraining();
    mockApi(memberRoutes({}, training));
    await signIn();
    useViewAsStore.setState({
      session: {
        id: '0192f6d2-7a3c-7b1e-9f00-00000000f001',
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        subject: session().user,
      },
    });
    await waitFor(() => expect(screen.queryByTestId('home-top-up')).toBeNull());
    await fireEvent.press(await screen.findByTestId('next-training'));
    await screen.findByTestId('training-detail');
    expect(screen.queryByTestId('reserve-attending')).toBeNull();
  });
});
