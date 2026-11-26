import type { ObjectStorage } from '../../integrations/storage/object-storage';

/** Download links for profile pictures are short-lived; clients refetch the profile to renew. */
export const AVATAR_URL_TTL_SECONDS = 60 * 60;

export function avatarObjectPrefix(userId: string): string {
  return `avatars/${userId}/`;
}

export async function avatarUrl(
  storage: ObjectStorage,
  key: string | null | undefined,
): Promise<string | null> {
  return key ? storage.presignGet(key, AVATAR_URL_TTL_SECONDS) : null;
}
