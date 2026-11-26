import type { PrismaClient } from '../core/db/prisma';
import type { ObjectStorage } from '../integrations/storage/object-storage';

/** Presigned uploads expire after minutes; anything older and unreferenced was abandoned. */
export const ORPHAN_AVATAR_AGE_MS = 24 * 60 * 60_000;

/**
 * Deletes profile pictures no profile points to: uploads that were never confirmed, and old
 * pictures replaced before the app removed them. Confirmed and replaced pictures share the
 * `avatars/<userId>/` prefix, so a bucket lifecycle rule by prefix would also delete pictures
 * in use; this job checks the database instead (Phase 10, replaces the ADR 0003 lifecycle idea).
 */
export async function purgeOrphanAvatars(
  prisma: PrismaClient,
  storage: ObjectStorage,
  now: Date = new Date(),
): Promise<{ checked: number; deleted: number }> {
  const cutoff = now.getTime() - ORPHAN_AVATAR_AGE_MS;
  const candidates = (await storage.list('avatars/')).filter(
    (o) => o.lastModified.getTime() < cutoff,
  );
  let deleted = 0;
  for (let i = 0; i < candidates.length; i += 500) {
    const batch = candidates.slice(i, i + 500).map((o) => o.key);
    const inUse = new Set(
      (
        await prisma.userProfile.findMany({
          where: { avatarKey: { in: batch } },
          select: { avatarKey: true },
        })
      ).map((p) => p.avatarKey),
    );
    for (const key of batch) {
      if (inUse.has(key)) continue;
      await storage.delete(key);
      deleted += 1;
    }
  }
  return { checked: candidates.length, deleted };
}
