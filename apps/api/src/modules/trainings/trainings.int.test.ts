import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';
import { loginAs, type TestSession } from '../../../test/sessions';
import { createTrainingViaApi, HOUR, member, testClock } from '../../../test/trainings';

const prisma = useTestDatabase();
const clock = testClock();
const { app } = buildTestApp({ prisma, now: clock.now });

let admin: TestSession;
let adminId: string;

beforeEach(async () => {
  clock.set(Date.now());
  const a = await createUser(prisma, { role: 'ADMIN' });
  adminId = a.id;
  admin = await loginAs(app, a);
});

const training = (input: Record<string, unknown> & { startsInMs: number }) =>
  createTrainingViaApi(app, admin, { clockMs: clock.ms, ...input });

describe('admin: trainings', () => {
  it('creates a training, defaults the deadline to the start and notifies members', async () => {
    const m = await member(prisma, app);
    const t = await training({ startsInMs: 24 * HOUR, capacity: 12 });
    expect(t).toMatchObject({
      capacity: 12,
      spotsLeft: 12,
      status: 'SCHEDULED',
      defaultPrice: { amountMinor: 1000, currency: 'EUR' },
      counts: { attending: 0, noResponse: 1, pending: 0 },
    });
    expect(t.reservationDeadline).toBe(t.startsAt);
    expect(
      await prisma.notification.count({ where: { userId: m.id, type: 'TRAINING_CREATED' } }),
    ).toBe(1);
  });

  it('validates times, timezone and that the deadline is not after the start', async () => {
    const start = new Date(clock.ms + HOUR).toISOString();
    const base = { title: 'X', location: 'Y', defaultPriceMinor: 0, startsAt: start };
    const post = (body: Record<string, unknown>) =>
      request(app)
        .post('/api/v1/admin/trainings')
        .set(admin.auth)
        .send({ ...base, ...body });
    expect((await post({ endsAt: start })).status).toBe(400);
    expect(
      (
        await post({
          endsAt: new Date(clock.ms + 2 * HOUR).toISOString(),
          reservationDeadline: new Date(clock.ms + 1.5 * HOUR).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          endsAt: new Date(clock.ms + 2 * HOUR).toISOString(),
          timezone: 'Mars/Olympus',
        })
      ).status,
    ).toBe(400);
  });

  it('tells attendees about schedule changes and moves a start-time deadline along', async () => {
    const m = await member(prisma, app);
    const t = await training({ startsInMs: 24 * HOUR });
    await request(app)
      .put(`/api/v1/me/trainings/${t.id}/reservation`)
      .set(m.session.auth)
      .send({ status: 'ATTENDING' })
      .expect(200);
    const newStart = new Date(clock.ms + 48 * HOUR);
    const res = await request(app)
      .patch(`/api/v1/admin/trainings/${t.id}`)
      .set(admin.auth)
      .send({
        startsAt: newStart.toISOString(),
        endsAt: new Date(newStart.getTime() + HOUR).toISOString(),
      });
    expect(res.status).toBe(200);
    expect(res.body.data.reservationDeadline).toBe(newStart.toISOString());
    const note = await prisma.notification.findFirstOrThrow({
      where: { userId: m.id, type: 'TRAINING_UPDATED' },
    });
    expect(note.params).toMatchObject({ changes: expect.arrayContaining(['startsAt', 'endsAt']) });
  });

  it('notifies a price change only to attendees whose price changes (D6)', async () => {
    const [a, b] = [await member(prisma, app), await member(prisma, app)];
    const t = await training({ startsInMs: 24 * HOUR });
    for (const m of [a, b]) {
      await request(app)
        .put(`/api/v1/me/trainings/${t.id}/reservation`)
        .set(m.session.auth)
        .send({ status: 'ATTENDING' })
        .expect(200);
    }
    await request(app)
      .put(`/api/v1/admin/users/${b.id}/standing-price`)
      .set(admin.auth)
      .send({ priceMinor: 700 })
      .expect(200);
    await request(app)
      .patch(`/api/v1/admin/trainings/${t.id}`)
      .set(admin.auth)
      .send({ defaultPriceMinor: 1200 })
      .expect(200);
    expect(
      await prisma.notification.count({ where: { userId: a.id, type: 'TRAINING_UPDATED' } }),
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { userId: b.id, type: 'TRAINING_UPDATED' } }),
    ).toBe(0);
  });

  it('deletes only untouched trainings; others must be cancelled', async () => {
    const m = await member(prisma, app);
    const untouched = await training({ startsInMs: 24 * HOUR });
    await request(app)
      .delete(`/api/v1/admin/trainings/${untouched.id}`)
      .set(admin.auth)
      .expect(204);
    expect(
      (await request(app).get(`/api/v1/admin/trainings/${untouched.id}`).set(admin.auth)).status,
    ).toBe(404);

    const used = await training({ startsInMs: 24 * HOUR });
    await request(app)
      .put(`/api/v1/me/trainings/${used.id}/reservation`)
      .set(m.session.auth)
      .send({ status: 'NOT_ATTENDING' })
      .expect(200);
    expect(
      (await request(app).delete(`/api/v1/admin/trainings/${used.id}`).set(admin.auth)).body.error
        .code,
    ).toBe('CONFLICT');
  });

  it('cancels once, notifies attendees and blocks further changes', async () => {
    const m = await member(prisma, app);
    const t = await training({ startsInMs: 24 * HOUR });
    await request(app)
      .put(`/api/v1/me/trainings/${t.id}/reservation`)
      .set(m.session.auth)
      .send({ status: 'ATTENDING' })
      .expect(200);
    const res = await request(app)
      .post(`/api/v1/admin/trainings/${t.id}/cancel`)
      .set(admin.auth)
      .send({ reason: 'Hall unavailable' });
    expect(res.body.data).toMatchObject({
      training: { status: 'CANCELLED', cancellationReason: 'Hall unavailable' },
      reversedCharges: 0,
    });
    expect(
      await prisma.notification.count({ where: { userId: m.id, type: 'TRAINING_CANCELLED' } }),
    ).toBe(1);
    expect(
      (
        await request(app)
          .post(`/api/v1/admin/trainings/${t.id}/cancel`)
          .set(admin.auth)
          .send({ reason: 'again' })
      ).body.error.code,
    ).toBe('TRAINING_CANCELLED');
    expect(
      (
        await request(app)
          .patch(`/api/v1/admin/trainings/${t.id}`)
          .set(admin.auth)
          .send({ title: 'New' })
      ).body.error.code,
    ).toBe('TRAINING_CANCELLED');
    expect(
      (
        await request(app)
          .put(`/api/v1/me/trainings/${t.id}/reservation`)
          .set(m.session.auth)
          .send({ status: 'NOT_ATTENDING' })
      ).body.error.code,
    ).toBe('TRAINING_CANCELLED');
  });

  it('lists with filters and pagination', async () => {
    await training({ startsInMs: 24 * HOUR });
    await training({ startsInMs: 48 * HOUR });
    await training({ startsInMs: 72 * HOUR });
    const res = await request(app)
      .get(
        `/api/v1/admin/trainings?from=${new Date(clock.ms + 30 * HOUR).toISOString()}&pageSize=1`,
      )
      .set(admin.auth);
    expect(res.body.meta.page).toEqual({ page: 1, pageSize: 1, total: 2 });
    expect(res.body.data).toHaveLength(1);
  });
});

describe('reservations', () => {
  it('never overfills a training under concurrent requests (row lock)', async () => {
    const t = await training({ startsInMs: 24 * HOUR, capacity: 5 });
    const members = await Promise.all(Array.from({ length: 15 }, () => member(prisma, app)));
    const results = await Promise.all(
      members.map((m) =>
        request(app)
          .put(`/api/v1/me/trainings/${t.id}/reservation`)
          .set(m.session.auth)
          .send({ status: 'ATTENDING' }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.body.error?.code === 'TRAINING_FULL')).toHaveLength(10);
    expect(
      await prisma.trainingReservation.count({ where: { trainingId: t.id, status: 'ATTENDING' } }),
    ).toBe(5);
  });

  it('is an idempotent upsert, and freeing a spot lets someone else in', async () => {
    const t = await training({ startsInMs: 24 * HOUR, capacity: 1 });
    const [a, b] = [await member(prisma, app), await member(prisma, app)];
    const reserve = (m: typeof a, status: string) =>
      request(app)
        .put(`/api/v1/me/trainings/${t.id}/reservation`)
        .set(m.session.auth)
        .send({ status });
    expect((await reserve(a, 'ATTENDING')).body.data.training).toMatchObject({
      myReservation: 'ATTENDING',
      spotsLeft: 0,
    });
    expect((await reserve(a, 'ATTENDING')).status).toBe(200);
    expect((await reserve(b, 'ATTENDING')).body.error.code).toBe('TRAINING_FULL');
    await reserve(a, 'NOT_ATTENDING').expect(200);
    expect((await reserve(b, 'ATTENDING')).status).toBe(200);
    expect(await prisma.trainingReservation.count({ where: { trainingId: t.id } })).toBe(2);
  });

  it('enforces the deadline to the millisecond; admins can still set responses', async () => {
    const m = await member(prisma, app);
    // Kept within the 15-minute access-token lifetime of the test clock.
    const start = new Date(clock.ms + 10 * 60_000);
    const t = await training({
      startsInMs: 10 * 60_000,
      reservationDeadline: new Date(start.getTime() - 5 * 60_000).toISOString(),
    });
    const deadline = new Date(t.reservationDeadline).getTime();
    const reserve = () =>
      request(app)
        .put(`/api/v1/me/trainings/${t.id}/reservation`)
        .set(m.session.auth)
        .send({ status: 'ATTENDING' });

    clock.set(deadline - 1);
    expect((await reserve()).status).toBe(200);
    clock.set(deadline);
    expect((await reserve()).body.error.code).toBe('RESERVATION_DEADLINE_PASSED');

    await request(app)
      .put(`/api/v1/admin/trainings/${t.id}/reservations/${m.id}`)
      .set(admin.auth)
      .send({ status: 'NOT_ATTENDING' })
      .expect(204);
    expect(
      await prisma.notification.count({ where: { userId: m.id, type: 'RESERVATION_CONFIRMED' } }),
    ).toBe(1);
  });

  it('lets an admin exceed capacity only with force', async () => {
    const t = await training({ startsInMs: 24 * HOUR, capacity: 1 });
    const [a, b] = [await member(prisma, app), await member(prisma, app)];
    await request(app)
      .put(`/api/v1/me/trainings/${t.id}/reservation`)
      .set(a.session.auth)
      .send({ status: 'ATTENDING' })
      .expect(200);
    const set = (force: boolean) =>
      request(app)
        .put(`/api/v1/admin/trainings/${t.id}/reservations/${b.id}`)
        .set(admin.auth)
        .send({ status: 'ATTENDING', force });
    expect((await set(false)).body.error.code).toBe('TRAINING_FULL');
    expect((await set(true)).status).toBe(204);
    const list = await request(app)
      .get(`/api/v1/admin/trainings/${t.id}/reservations`)
      .set(admin.auth);
    expect(list.body.data.find((r: { user: { id: string } }) => r.user.id === b.id)).toMatchObject({
      status: 'ATTENDING',
      respondedByAdmin: true,
    });
  });

  it('warns about debt (D10) and blocks above the configured limit', async () => {
    const m = await member(prisma, app);
    await prisma.wallet.updateMany({ where: { userId: m.id }, data: {} });
    // Give the member €5 of debt through the ledger: an unfunded charge on a past training.
    const past = await training({ startsInMs: -2 * HOUR, defaultPriceMinor: 500 });
    await request(app)
      .put(`/api/v1/admin/trainings/${past.id}/attendance`)
      .set(admin.auth)
      .send({ entries: [{ userId: m.id, status: 'PRESENT' }] })
      .expect(200);
    await request(app)
      .post(`/api/v1/admin/trainings/${past.id}/attendance/finalize`)
      .set(admin.auth)
      .set('idempotency-key', `fin-${past.id}`)
      .send({})
      .expect(200);

    const t = await training({ startsInMs: 24 * HOUR });
    const reserve = () =>
      request(app)
        .put(`/api/v1/me/trainings/${t.id}/reservation`)
        .set(m.session.auth)
        .send({ status: 'ATTENDING' });
    expect((await reserve()).body.data.warning).toBe('OUTSTANDING_DEBT');

    await request(app)
      .put(`/api/v1/me/trainings/${t.id}/reservation`)
      .set(m.session.auth)
      .send({ status: 'NOT_ATTENDING' })
      .expect(200);
    await request(app)
      .patch('/api/v1/admin/settings')
      .set(admin.auth)
      .send({ reservationDebtBlockMinor: 400 })
      .expect(200);
    expect((await reserve()).body.error).toMatchObject({
      code: 'RESERVATION_BLOCKED_BY_DEBT',
      details: { debt: { amountMinor: 500 } },
    });
    // Saying "not attending" is always possible.
    expect(
      (
        await request(app)
          .put(`/api/v1/me/trainings/${t.id}/reservation`)
          .set(m.session.auth)
          .send({ status: 'NOT_ATTENDING' })
      ).status,
    ).toBe(200);
    await request(app)
      .patch('/api/v1/admin/settings')
      .set(admin.auth)
      .send({ reservationDebtBlockMinor: null })
      .expect(200);
    expect((await reserve()).status).toBe(200);
  });

  it('refuses admins (no wallet) and shows members their own price', async () => {
    const t = await training({ startsInMs: 24 * HOUR });
    expect(
      (
        await request(app)
          .put(`/api/v1/me/trainings/${t.id}/reservation`)
          .set(admin.auth)
          .send({ status: 'ATTENDING' })
      ).status,
    ).toBe(403);

    const m = await member(prisma, app);
    await request(app)
      .put(`/api/v1/admin/trainings/${t.id}/price-overrides/${m.id}`)
      .set(admin.auth)
      .send({ priceMinor: 0 })
      .expect(204);
    const mine = await request(app).get(`/api/v1/me/trainings/${t.id}`).set(m.session.auth);
    expect(mine.body.data.myPrice).toEqual({
      price: { amountMinor: 0, currency: 'EUR' },
      source: 'TRAINING_OVERRIDE',
    });
  });
});

describe('member training feed', () => {
  it('pages upcoming trainings by start time and lists past ones I took part in', async () => {
    const m = await member(prisma, app);
    for (const h of [5, 1, 3]) await training({ startsInMs: h * HOUR });
    const past = await training({ startsInMs: -5 * HOUR });
    await training({ startsInMs: -6 * HOUR }); // not involved: not in my past list
    await request(app)
      .put(`/api/v1/admin/trainings/${past.id}/reservations/${m.id}`)
      .set(admin.auth)
      .send({ status: 'ATTENDING', force: true })
      .expect(204);

    const first = await request(app).get('/api/v1/me/trainings?limit=2').set(m.session.auth);
    expect(
      first.body.data.map((t: { startsAt: string }) => new Date(t.startsAt).getTime() - clock.ms),
    ).toEqual([HOUR, 3 * HOUR]);
    expect(first.body.meta.page.hasMore).toBe(true);
    const second = await request(app)
      .get(`/api/v1/me/trainings?limit=2&cursor=${first.body.meta.page.nextCursor}`)
      .set(m.session.auth);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.meta.page.hasMore).toBe(false);

    const history = await request(app).get('/api/v1/me/trainings?scope=past').set(m.session.auth);
    expect(history.body.data.map((t: { id: string }) => t.id)).toEqual([past.id]);
  });
});

describe('pricing (D5)', () => {
  it('resolves override → standing → default for every member', async () => {
    const [a, b, c] = [
      await member(prisma, app),
      await member(prisma, app),
      await member(prisma, app),
    ];
    const t = await training({ startsInMs: 24 * HOUR });
    await request(app)
      .put(`/api/v1/admin/users/${b.id}/standing-price`)
      .set(admin.auth)
      .send({ priceMinor: 800 })
      .expect(200);
    await request(app)
      .put(`/api/v1/admin/users/${c.id}/standing-price`)
      .set(admin.auth)
      .send({ priceMinor: 800 })
      .expect(200);
    await request(app)
      .put(`/api/v1/admin/trainings/${t.id}/price-overrides/${c.id}`)
      .set(admin.auth)
      .send({ priceMinor: 1200 })
      .expect(204);
    const prices = (
      await request(app).get(`/api/v1/admin/trainings/${t.id}/prices`).set(admin.auth)
    ).body.data as {
      user: { id: string };
      price: { amountMinor: number };
      source: string;
    }[];
    const of = (id: string) => prices.find((p) => p.user.id === id);
    expect(of(a.id)).toMatchObject({ price: { amountMinor: 1000 }, source: 'TRAINING_DEFAULT' });
    expect(of(b.id)).toMatchObject({ price: { amountMinor: 800 }, source: 'USER_STANDING_PRICE' });
    expect(of(c.id)).toMatchObject({ price: { amountMinor: 1200 }, source: 'TRAINING_OVERRIDE' });

    await request(app)
      .delete(`/api/v1/admin/trainings/${t.id}/price-overrides/${c.id}`)
      .set(admin.auth)
      .expect(204);
    expect(
      (await request(app).delete(`/api/v1/admin/users/${c.id}/standing-price`).set(admin.auth)).body
        .data.price,
    ).toBeNull();
    expect(
      await prisma.auditLog.count({ where: { action: { startsWith: 'price_override' } } }),
    ).toBe(2);
    expect(adminId).toBeTruthy();
  });
});

describe('series (D7)', () => {
  it('generates weekly sessions at local time across DST and extends idempotently', async () => {
    // Pretend today is Monday 2026-03-16; sessions every Tuesday 19:00 Amsterdam.
    clock.set(Date.parse('2026-03-16T08:00:00Z'));
    admin = await loginAs(app, await createUser(prisma, { role: 'ADMIN' }));
    const res = await request(app)
      .post('/api/v1/admin/training-series')
      .set(admin.auth)
      .send({
        title: 'Tuesday club',
        location: 'Hall A',
        weekdays: ['TU'],
        startTimeLocal: '19:00',
        durationMinutes: 90,
        defaultPriceMinor: 1000,
        deadlineOffsetMinutes: 120,
        startsOn: '2026-03-16',
        endsOn: '2026-04-07',
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      createdSessions: 4,
      series: { rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU', upcomingCount: 4 },
    });
    const sessions = await prisma.training.findMany({
      where: { seriesId: res.body.data.series.id },
      orderBy: { startsAt: 'asc' },
    });
    expect(sessions.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-03-17T18:00:00.000Z',
      '2026-03-24T18:00:00.000Z',
      '2026-03-31T17:00:00.000Z', // after the switch to summer time: still 19:00 local
      '2026-04-07T17:00:00.000Z',
    ]);
    expect(sessions[0]!.reservationDeadline.toISOString()).toBe('2026-03-17T16:00:00.000Z');

    // Extending the end date adds sessions; running the job again adds nothing.
    const seriesId = res.body.data.series.id as string;
    const longer = await request(app)
      .patch(`/api/v1/admin/training-series/${seriesId}`)
      .set(admin.auth)
      .send({ endsOn: '2026-04-21' });
    expect(longer.body.data.createdSessions).toBe(2);
    const { SeriesService } = await import('./series.service');
    expect(await new SeriesService(prisma, clock.now).extendAll()).toBe(0);
  });

  it('applies edits to future sessions and removes or cancels sessions when ended', async () => {
    clock.set(Date.parse('2026-03-16T08:00:00Z'));
    admin = await loginAs(app, await createUser(prisma, { role: 'ADMIN' }));
    const m = await member(prisma, app);
    const created = await request(app)
      .post('/api/v1/admin/training-series')
      .set(admin.auth)
      .send({
        title: 'Thursday club',
        location: 'Hall A',
        weekdays: ['TH'],
        startTimeLocal: '19:00',
        durationMinutes: 60,
        defaultPriceMinor: 900,
        startsOn: '2026-03-16',
      });
    const seriesId = created.body.data.series.id as string;
    expect(created.body.data.createdSessions).toBe(12); // 12-week horizon
    const [first, second] = await prisma.training.findMany({
      where: { seriesId },
      orderBy: { startsAt: 'asc' },
      take: 2,
    });
    await request(app)
      .put(`/api/v1/me/trainings/${second!.id}/reservation`)
      .set(m.session.auth)
      .send({ status: 'ATTENDING' })
      .expect(200);

    const edited = await request(app)
      .patch(`/api/v1/admin/training-series/${seriesId}`)
      .set(admin.auth)
      .send({ location: 'Hall B' });
    expect(edited.body.data.updatedSessions).toBe(12);
    expect(
      await prisma.notification.count({ where: { userId: m.id, type: 'TRAINING_UPDATED' } }),
    ).toBe(1);

    const ended = await request(app)
      .delete(`/api/v1/admin/training-series/${seriesId}`)
      .set(admin.auth);
    expect(ended.body.data).toMatchObject({ removedSessions: 11, cancelledSessions: 1 });
    expect((await prisma.training.findUniqueOrThrow({ where: { id: second!.id } })).status).toBe(
      'CANCELLED',
    );
    expect(
      (await prisma.training.findUniqueOrThrow({ where: { id: first!.id } })).deletedAt,
    ).not.toBeNull();
    expect(
      (await request(app).get('/api/v1/admin/training-series').set(admin.auth)).body.data,
    ).toEqual([]);
  });
});
