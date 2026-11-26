import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../test/db';
import { createUser } from '../../test/fixtures';
import { MemoryObjectStorage } from '../integrations/storage/object-storage';
import { ORPHAN_AVATAR_AGE_MS, purgeOrphanAvatars } from './orphan-avatars';

const prisma = useTestDatabase();
const image = { contentType: 'image/jpeg', contentLength: 1000 };

describe('purgeOrphanAvatars', () => {
  it('deletes only old pictures that no profile uses', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - ORPHAN_AVATAR_AGE_MS - 60_000);
    const user = await createUser(prisma);
    const inUse = `avatars/${user.id}/current.jpg`;
    await prisma.userProfile.update({ where: { userId: user.id }, data: { avatarKey: inUse } });

    const storage = new MemoryObjectStorage();
    storage.put(inUse, image, old); // old but in use: kept
    storage.put(`avatars/${user.id}/abandoned.jpg`, image, old); // never confirmed: deleted
    storage.put(`avatars/${user.id}/uploading-now.jpg`, image, now); // upload in progress: kept
    storage.put('exports/report.csv', image, old); // outside avatars/: never touched

    expect(await purgeOrphanAvatars(prisma, storage, now)).toEqual({ checked: 2, deleted: 1 });
    expect([...storage.objects.keys()].sort()).toEqual(
      [inUse, `avatars/${user.id}/uploading-now.jpg`, 'exports/report.csv'].sort(),
    );
  });
});
