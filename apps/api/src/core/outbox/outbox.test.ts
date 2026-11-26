import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../db/prisma';
import { backoffMs, DEFAULT_DISPATCHER_OPTIONS, OutboxDispatcher } from './outbox';

/** The polling loop of the worker, without a database (runOnce is stubbed). */
function dispatcher(results: (number | Error)[]) {
  const logger = pino({ level: 'silent' });
  const error = vi.spyOn(logger, 'error');
  const d = new OutboxDispatcher({} as PrismaClient, {} as never, logger, { pollIntervalMs: 400 });
  const at: number[] = [];
  const runOnce = vi.spyOn(d, 'runOnce').mockImplementation(() => {
    at.push(performance.now());
    const next = results.shift() ?? 0;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { d, runOnce, error, at };
}

describe('OutboxDispatcher loop', () => {
  it('drains back-to-back while there is work, then waits for the poll interval', async () => {
    const { d, runOnce, at } = dispatcher([5, 3, 0]);
    d.start();
    d.start(); // a second start is a no-op, not a second loop
    await vi.waitFor(() => expect(runOnce.mock.calls.length).toBeGreaterThanOrEqual(4), {
      timeout: 2000,
    });
    // Polls 1→2→3 follow immediately (work was found); 3→4 waits the 400 ms interval.
    expect(at[2]! - at[0]!).toBeLessThan(200);
    expect(at[3]! - at[2]!).toBeGreaterThanOrEqual(380);
    await d.stop();
    const calls = runOnce.mock.calls.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(runOnce).toHaveBeenCalledTimes(calls); // nothing runs after stop()
  });

  it('logs a failed poll and keeps polling', async () => {
    const { d, runOnce, error } = dispatcher([new Error('db down'), 0]);
    d.start();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'outbox poll failed',
    );
    await d.stop();
  });

  it('can be stopped before it ever started', async () => {
    const { d, runOnce } = dispatcher([]);
    await d.stop();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('backs off exponentially up to the cap', () => {
    expect([1, 2, 3, 4].map((a) => backoffMs(a, DEFAULT_DISPATCHER_OPTIONS))).toEqual([
      5_000, 10_000, 20_000, 40_000,
    ]);
    expect(backoffMs(50, DEFAULT_DISPATCHER_OPTIONS)).toBe(DEFAULT_DISPATCHER_OPTIONS.maxBackoffMs);
  });
});
