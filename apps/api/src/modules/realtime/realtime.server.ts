import type { Server as HttpServer } from 'node:http';
import { REALTIME_PATH } from '@tw/contracts';
import pg from 'pg';
import { Server, type Socket } from 'socket.io';
import type { TokenService } from '../../core/auth/tokens';
import type { PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { Logger } from '../../core/logger/logger';
import { REALTIME_CHANNEL, type RealtimeMessage, rooms } from './realtime';

export interface RealtimeDeps {
  tokens: TokenService;
  prisma: PrismaClient;
  databaseUrl: string;
  logger: Logger;
  corsOrigins: string[];
  now?: () => Date;
}

export interface RealtimeServer {
  io: Server;
  /** Resolves once the Postgres listener is subscribed (tests wait for it). */
  ready: Promise<void>;
  close(): Promise<void>;
}

interface SocketData {
  userId: string;
  role: 'ADMIN' | 'USER';
  expiresAt: Date;
}

const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Socket.IO for "this changed, refetch" hints (docs/04-api.md §3).
 *
 * - **Auth:** the handshake carries the access token (`auth: { token }`), verified like REST,
 *   including the database checks (deactivated, signed out everywhere). The socket is closed
 *   when the token expires; the app reconnects with its refreshed token.
 * - **Rooms:** `user:<id>`, `members` and, for admins, `admins`. View-as never joins a user's
 *   room: the handshake only ever identifies the signed-in account.
 * - **Fan-out:** events are published with `pg_notify` in the business transaction. Every
 *   API instance LISTENs and emits to its own sockets, so no shared adapter is needed and a
 *   rolled-back change is never announced. WebSocket transport only, so a load balancer
 *   needs no sticky sessions.
 */
export function attachRealtime(httpServer: HttpServer, deps: RealtimeDeps): RealtimeServer {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger.child({ component: 'realtime' });
  const io = new Server(httpServer, {
    path: REALTIME_PATH,
    serveClient: false,
    transports: ['websocket'],
    // Clients only listen; the largest inbound frame is the auth packet (~1 KB). The 1 MB
    // default would let any connection make the server buffer large frames.
    maxHttpBufferSize: 16 * 1024,
    cors: { origin: deps.corsOrigins.length > 0 ? deps.corsOrigins : false },
  });

  io.use((socket, next) => {
    authenticateSocket(socket, deps)
      .then(() => next())
      .catch((error: unknown) => {
        const code = error instanceof AppError ? error.code : 'UNAUTHENTICATED';
        const err = new Error(code) as Error & { data?: unknown };
        err.data = { code };
        next(err);
      });
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    void socket.join([
      rooms.user(data.userId),
      rooms.members,
      ...(data.role === 'ADMIN' ? [rooms.admins] : []),
    ]);
    // Close at token expiry; the client reconnects with a fresh token.
    const ms = Math.max(0, data.expiresAt.getTime() - now().getTime());
    const timer = setTimeout(() => socket.disconnect(true), Math.min(ms, 2 ** 31 - 1));
    socket.on('disconnect', () => clearTimeout(timer));
  });

  // ── Postgres LISTEN → local sockets ──────────────────────────────────────
  let client: pg.Client | undefined;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const deliver = (payload: string | undefined) => {
    if (!payload) return;
    try {
      for (const message of JSON.parse(payload) as RealtimeMessage[]) {
        io.to(message.room).emit(message.event, message.data);
      }
    } catch (err) {
      log.error({ err }, 'invalid realtime payload');
    }
  };

  const listen = async () => {
    const c = new pg.Client({ connectionString: deps.databaseUrl });
    client = c;
    c.on('notification', (msg) => {
      if (msg.channel === REALTIME_CHANNEL) deliver(msg.payload);
    });
    const retry = (err: unknown) => {
      if (closed || client !== c) return;
      client = undefined;
      void c.end().catch(() => undefined);
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
      log.error({ err, retryInMs: delay }, 'realtime listener lost; reconnecting');
      reconnectTimer = setTimeout(() => void listen(), delay);
    };
    c.on('error', retry);
    try {
      await c.connect();
      await c.query(`LISTEN ${REALTIME_CHANNEL}`);
      attempt = 0;
      resolveReady();
    } catch (err) {
      retry(err);
    }
  };
  void listen();

  return {
    io,
    ready,
    close: async () => {
      closed = true;
      clearTimeout(reconnectTimer);
      io.disconnectSockets(true);
      // Not io.close(): that would also close the HTTP server, which main.ts owns.
      await client?.end().catch(() => undefined);
    },
  };
}

async function authenticateSocket(socket: Socket, deps: RealtimeDeps): Promise<void> {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  const token = typeof auth?.token === 'string' ? auth.token : '';
  if (!token) throw AppError.unauthenticated();
  const claims = await deps.tokens.verifyAccessToken(token);
  const user = await deps.prisma.user.findUnique({
    where: { id: claims.userId },
    select: { role: true, status: true, tokenVersion: true, deletedAt: true },
  });
  if (!user || user.deletedAt || user.tokenVersion !== claims.tokenVersion) {
    throw new AppError('UNAUTHENTICATED', 'Session is no longer valid');
  }
  if (user.status !== 'ACTIVE') throw new AppError('ACCOUNT_INACTIVE', 'Account is not active');
  const data: SocketData = { userId: claims.userId, role: user.role, expiresAt: claims.expiresAt };
  socket.data = data;
}
