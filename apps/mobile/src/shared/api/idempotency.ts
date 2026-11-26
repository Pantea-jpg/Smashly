import { IDEMPOTENCY_HEADER } from '@tw/contracts';
import { useCallback, useState } from 'react';

/** A fresh key in the API's format ([A-Za-z0-9_-], 8–128 chars). */
export function newIdempotencyKey(): string {
  const random = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('');
  return `m-${Date.now().toString(36)}-${random}`;
}

/**
 * One key per user intent: it stays the same while the form is open, so a retry after a
 * timeout replays the first request instead of moving money twice. Renew it after success.
 */
export function useIdempotencyKey(): { headers: Record<string, string>; renew: () => void } {
  const [key, setKey] = useState(newIdempotencyKey);
  const renew = useCallback(() => setKey(newIdempotencyKey()), []);
  return { headers: { [IDEMPOTENCY_HEADER]: key }, renew };
}
