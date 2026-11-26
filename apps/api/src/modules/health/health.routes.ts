import type { HealthCheck } from '@tw/contracts';
import { Router } from 'express';

/** A readiness probe for one dependency. Must reject (or time out) when unhealthy. */
export interface DependencyCheck {
  name: string;
  check: () => Promise<void>;
}

const CHECK_TIMEOUT_MS = 2_000;

async function runWithTimeout(check: DependencyCheck): Promise<'ok' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${check.name} check timed out`)),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export function healthRouter(options: { version: string; checks: DependencyCheck[] }): Router {
  const router = Router();
  const startedAt = Date.now();
  const uptimeSeconds = () => Math.round((Date.now() - startedAt) / 1000);

  // Liveness: the process is up and the event loop responds. Never touches dependencies.
  router.get('/live', (_req, res) => {
    const body: HealthCheck = {
      status: 'ok',
      checks: {},
      version: options.version,
      uptimeSeconds: uptimeSeconds(),
    };
    res.json(body);
  });

  // Readiness: dependencies reachable; load balancers stop routing traffic on 503.
  router.get('/ready', async (req, res) => {
    const results = await Promise.all(
      options.checks.map(async (check) => [check.name, await runWithTimeout(check)] as const),
    );
    const checks = Object.fromEntries(results);
    const healthy = results.every(([, status]) => status === 'ok');
    if (!healthy) req.log.warn({ checks }, 'readiness check failed');

    const body: HealthCheck = {
      status: healthy ? 'ok' : 'down',
      checks,
      version: options.version,
      uptimeSeconds: uptimeSeconds(),
    };
    res.status(healthy ? 200 : 503).json(body);
  });

  return router;
}
