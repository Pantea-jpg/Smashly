import { createHash } from 'node:crypto';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { HibpPasswordCheck } from './breached-passwords';

const logger = pino({ level: 'silent' });
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();

function respondWith(body: string, status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(body, { status, headers: { 'content-type': 'text/plain' } }));
}

describe('HibpPasswordCheck (k-anonymity)', () => {
  it('sends only the first 5 hex characters of the SHA-1, with padding requested', async () => {
    const hash = sha1('password123');
    const fetchSpy = respondWith(
      `${hash.slice(5)}:2493390\r\n0000000000000000000000000000000000A:0`,
    );
    expect(await new HibpPasswordCheck(logger).isBreached('password123')).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit | undefined];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(url).not.toContain(hash.slice(5));
    expect((init?.headers as Record<string, string>)['Add-Padding']).toBe('true');
  });

  it('accepts a password whose suffix is absent or only present as padding (count 0)', async () => {
    const hash = sha1('a perfectly fine password');
    respondWith(`${hash.slice(5).toLowerCase()}:0\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:12`);
    expect(await new HibpPasswordCheck(logger).isBreached('a perfectly fine password')).toBe(false);
  });

  it('matches the suffix case-insensitively', async () => {
    const hash = sha1('Summer2026!');
    respondWith(`${hash.slice(5).toLowerCase()}:7`);
    expect(await new HibpPasswordCheck(logger).isBreached('Summer2026!')).toBe(true);
  });

  it('fails open (accepts) and warns when the service errors or is unreachable', async () => {
    const warn = vi.spyOn(logger, 'warn');
    respondWith('busy', 503);
    expect(await new HibpPasswordCheck(logger).isBreached('password123')).toBe(false);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    expect(await new HibpPasswordCheck(logger).isBreached('password123')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    // The password never reaches the logs.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('password123');
  });
});
