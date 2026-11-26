import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, createUser } from '../../../test/fixtures';
import { loginAs, type TestSession } from '../../../test/sessions';

const prisma = useTestDatabase();
const { app } = buildTestApp({ prisma });

let me: TestSession;
let meId: string;

async function notify(userId: string, n: number) {
  for (let i = 0; i < n; i += 1) {
    await prisma.notification.create({
      data: {
        userId,
        type: 'TRAINING_CREATED',
        category: 'TRAININGS',
        params: { title: `T${i}` },
        dedupeKey: `t-${i}`,
      },
    });
  }
}

beforeEach(async () => {
  const u = await createUser(prisma);
  meId = u.id;
  me = await loginAs(app, u);
});

describe('notifications inbox', () => {
  it('lists newest first with a cursor and counts unread', async () => {
    await notify(meId, 3);
    const first = await request(app).get('/api/v1/me/notifications?limit=2').set(me.auth);
    expect(first.body.data.map((n: { params: { title: string } }) => n.params.title)).toEqual([
      'T2',
      'T1',
    ]);
    expect(first.body.meta.page.hasMore).toBe(true);
    const next = await request(app)
      .get(`/api/v1/me/notifications?limit=2&cursor=${first.body.meta.page.nextCursor}`)
      .set(me.auth);
    expect(next.body.data).toHaveLength(1);
    expect(
      (await request(app).get('/api/v1/me/notifications/unread-count').set(me.auth)).body.data,
    ).toEqual({ unread: 3 });
  });

  it('marks selected or all as read, never someone else’s', async () => {
    const other = await createUser(prisma);
    await notify(meId, 2);
    await notify(other.id, 1);
    const [newest] = (await request(app).get('/api/v1/me/notifications').set(me.auth)).body
      .data as { id: string }[];
    expect(
      (
        await request(app)
          .post('/api/v1/me/notifications/read')
          .set(me.auth)
          .send({ ids: [newest!.id] })
      ).body.data,
    ).toEqual({ unread: 1 });
    const otherId = (await prisma.notification.findFirstOrThrow({ where: { userId: other.id } }))
      .id;
    await request(app)
      .post('/api/v1/me/notifications/read')
      .set(me.auth)
      .send({ ids: [otherId] })
      .expect(200);
    expect(await prisma.notification.count({ where: { userId: other.id, readAt: null } })).toBe(1);
    expect(
      (await request(app).post('/api/v1/me/notifications/read').set(me.auth).send({ all: true }))
        .body.data,
    ).toEqual({ unread: 0 });
    expect(
      (await request(app).get('/api/v1/me/notifications?unreadOnly=true').set(me.auth)).body.data,
    ).toEqual([]);
    expect(
      (await request(app).post('/api/v1/me/notifications/read').set(me.auth).send({})).status,
    ).toBe(400);
  });
});
