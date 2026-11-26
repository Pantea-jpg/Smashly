import argon2 from 'argon2';

/** OWASP Password Storage Cheat Sheet (2025): Argon2id, m=19 MiB, t=2, p=1. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed hash: treat as a failed verification rather than a server error.
    return false;
  }
}

/** True when the stored hash uses weaker parameters than the current policy. */
export function passwordNeedsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a verification against a fixed hash so that "unknown email" takes as long as
 * "wrong password" (prevents account enumeration by timing).
 */
export async function burnPasswordVerification(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equaliser-not-a-real-password');
  await verifyPassword(await dummyHash, password);
}
