import { createHash } from 'node:crypto';
import type { Logger } from '../logger/logger';

/** Rejects new passwords that are known from data breaches (ASVS 2.1.7). */
export interface PasswordBreachCheck {
  isBreached(password: string): Promise<boolean>;
}

/**
 * Have I Been Pwned "Pwned Passwords" range API with k-anonymity: only the first 5 hex
 * characters of the password's SHA-1 leave the server, never the password or its full hash.
 * Responses are padded (Add-Padding) so their size reveals nothing either.
 *
 * Fails OPEN: when the service is slow or down, the password is accepted (and a warning is
 * logged). Registration and password changes must not depend on a third party being up.
 */
export class HibpPasswordCheck implements PasswordBreachCheck {
  constructor(
    private readonly logger: Logger,
    private readonly options: { baseUrl?: string; timeoutMs?: number } = {},
  ) {}

  async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await fetch(
        `${this.options.baseUrl ?? 'https://api.pwnedpasswords.com'}/range/${prefix}`,
        {
          headers: { 'Add-Padding': 'true', 'User-Agent': 'training-wallet-api' },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 2500),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      const body = await res.text();
      for (const line of body.split('\n')) {
        const [hashSuffix, count] = line.trim().split(':');
        // Padding entries have a count of 0 and are not real breaches.
        if (hashSuffix?.toUpperCase() === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'breached-password check unavailable; password accepted',
      );
      return false;
    }
  }
}
