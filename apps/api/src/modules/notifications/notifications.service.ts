import type { Notification } from '@tw/contracts';
import type { PrismaClient } from '../../core/db/prisma';
import { decodeIdCursor, encodeIdCursor } from '../../core/http/pagination';

/** The in-app notification inbox (push delivery of the same rows: push.service.ts). */
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    userId: string,
    query: { limit: number; cursor?: string | undefined; unreadOnly: boolean },
  ): Promise<{ items: Notification[]; page: { nextCursor: string | null; hasMore: boolean } }> {
    const before = query.cursor ? decodeIdCursor(query.cursor) : null;
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(before ? { id: { lt: before } } : {}),
      },
      // UUIDv7 ids sort by creation time.
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((n) => ({
        id: n.id,
        type: n.type,
        category: n.category,
        params: (n.params ?? {}) as Record<string, unknown>,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      page: { nextCursor: hasMore ? encodeIdCursor(page[page.length - 1]!.id) : null, hasMore },
    };
  }

  async unreadCount(userId: string): Promise<{ unread: number }> {
    return {
      unread: await this.prisma.notification.count({
        where: { userId, deletedAt: null, readAt: null },
      }),
    };
  }

  /** Marks the given notifications (only the caller's own) or all of them as read. */
  async markRead(
    userId: string,
    input: { ids?: string[] | undefined; all?: true | undefined },
  ): Promise<{ unread: number }> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...(input.all ? {} : { id: { in: input.ids ?? [] } }) },
      data: { readAt: this.now() },
    });
    return this.unreadCount(userId);
  }
}
