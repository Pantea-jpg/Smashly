import {
  type AuthSession,
  AuthSessionSchema,
  type LoginRequest,
  type RegisterRequest,
  type RegisterResponse,
  RegisterResponseSchema,
  type SessionUser,
  SessionUserSchema,
  VIEW_SESSION_HEADER,
} from '@tw/contracts';
import type { z } from 'zod';
import { create } from 'zustand';
import { ApiError, API_URL, type HttpRequest, httpRequest, isApiError } from '../api/http';
import { secureTokenStorage, type TokenStorage } from './tokenStorage';
import { useViewAsStore } from './viewAs';

export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn';

interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
  /** Memory only; never persisted. */
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
}

const INITIAL_STATE: SessionState = {
  status: 'restoring',
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
};

export const useSessionStore = create<SessionState>()(() => INITIAL_STATE);

/** Sign-out never waits longer than this for best-effort tasks (no network, say). */
const BEFORE_LOGOUT_TIMEOUT_MS = 3_000;

/** Refresh a little before expiry so requests do not race the deadline. */
const EXPIRY_SKEW_MS = 30_000;

/** Errors after which the stored session is dead and the user must sign in again. */
const TERMINAL_REFRESH_ERRORS = new Set([
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'ACCOUNT_INACTIVE',
  'ACCOUNT_PENDING_APPROVAL',
  'VALIDATION_ERROR',
]);

export interface SessionControllerDeps {
  storage: TokenStorage;
  getLanguage: () => string;
  baseUrl?: string;
  now?: () => number;
}

/**
 * Owns the session lifecycle: sign-in, restore on launch, single-flight token refresh,
 * authorised requests with one transparent retry, and sign-out.
 */
export class SessionController {
  private refreshing: Promise<boolean> | null = null;
  private readonly beforeLogout = new Set<() => Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly deps: SessionControllerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private call<S extends z.ZodType | undefined>(request: HttpRequest<S>) {
    return httpRequest(
      { ...request, language: this.deps.getLanguage() },
      this.deps.baseUrl ?? API_URL,
    );
  }

  /** On app launch: exchange a stored refresh token for a fresh session. */
  async restore(): Promise<void> {
    const stored = await this.deps.storage.getRefreshToken();
    if (!stored) {
      useSessionStore.setState({ ...INITIAL_STATE, status: 'signedOut' });
      return;
    }
    try {
      await this.refresh();
    } catch (error) {
      // Offline at launch: keep the stored token so the next launch can restore the session.
      if (!isApiError(error, 'NETWORK_ERROR')) throw error;
    }
    if (useSessionStore.getState().status === 'restoring') {
      useSessionStore.setState({ status: 'signedOut' });
    }
  }

  async login(input: LoginRequest): Promise<SessionUser> {
    const session = await this.call({
      method: 'POST',
      path: '/auth/login',
      body: input,
      schema: AuthSessionSchema,
    });
    await this.apply(session);
    return session.user;
  }

  async register(input: RegisterRequest): Promise<RegisterResponse> {
    const result = await this.call({
      method: 'POST',
      path: '/auth/register',
      body: input,
      schema: RegisterResponseSchema,
    });
    if (result.status === 'ACTIVE') {
      await this.apply({ user: result.user, tokens: result.tokens });
    }
    return result;
  }

  /**
   * Runs `task` at sign-out while the session is still valid (e.g. unregistering the push
   * token). Tasks are best effort and capped at a few seconds. Returns an unsubscribe.
   */
  onBeforeLogout(task: () => Promise<void>): () => void {
    this.beforeLogout.add(task);
    return () => this.beforeLogout.delete(task);
  }

  /** Ends the session on the server (best effort) and always clears it locally. */
  async logout(): Promise<void> {
    await Promise.race([
      Promise.allSettled([...this.beforeLogout].map((task) => task())),
      new Promise((resolve) => setTimeout(resolve, BEFORE_LOGOUT_TIMEOUT_MS)),
    ]);
    const { accessToken } = useSessionStore.getState();
    try {
      if (accessToken) await this.call({ method: 'POST', path: '/auth/logout', accessToken });
    } catch {
      // Ignore: the refresh token is deleted locally and expires server-side anyway.
    }
    await this.clear();
  }

  /**
   * Single-flight refresh: concurrent callers share one network request, because each
   * refresh token works only once (the server treats reuse as theft).
   * Resolves false when the session is gone (user signed out); rejects on network errors.
   */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const refreshToken = await this.deps.storage.getRefreshToken();
    if (!refreshToken) {
      await this.clear();
      return false;
    }
    try {
      const session = await this.call({
        method: 'POST',
        path: '/auth/refresh',
        body: { refreshToken },
        schema: AuthSessionSchema,
      });
      await this.apply(session);
      return true;
    } catch (error) {
      if (error instanceof ApiError && TERMINAL_REFRESH_ERRORS.has(error.code)) {
        await this.clear();
        return false;
      }
      throw error;
    }
  }

  /**
   * An authenticated API call. Refreshes proactively near expiry, and once more if the
   * server reports TOKEN_EXPIRED. A lost session surfaces as UNAUTHENTICATED (user is signed out).
   */
  async request<S extends z.ZodType | undefined = undefined>(
    request: Omit<HttpRequest<S>, 'accessToken' | 'language'> & {
      /** Send as the admin even while viewing as a user (e.g. ending the view session). */
      ignoreViewAs?: boolean;
    },
  ): Promise<S extends z.ZodType ? z.output<S> : undefined> {
    const { ignoreViewAs, ...httpRequestSpec } = request;
    const view = ignoreViewAs ? null : useViewAsStore.getState().session;
    if (view && request.method !== 'GET') {
      // The server rejects this too; failing here keeps the UI honest.
      throw new ApiError('VIEW_AS_READ_ONLY', 403, 'View as user is read-only');
    }
    const spec = view
      ? {
          ...httpRequestSpec,
          headers: { ...httpRequestSpec.headers, [VIEW_SESSION_HEADER]: view.id },
        }
      : httpRequestSpec;
    try {
      return await this.authorizedCall(spec);
    } catch (error) {
      if (view && isApiError(error, 'VIEW_SESSION_INVALID')) {
        useViewAsStore.getState().setSession(null);
      }
      throw error;
    }
  }

  private async authorizedCall<S extends z.ZodType | undefined>(
    request: Omit<HttpRequest<S>, 'accessToken' | 'language'>,
  ): Promise<S extends z.ZodType ? z.output<S> : undefined> {
    const { accessTokenExpiresAt } = useSessionStore.getState();
    if (accessTokenExpiresAt !== null && accessTokenExpiresAt - this.now() < EXPIRY_SKEW_MS) {
      await this.refresh();
    }
    const token = useSessionStore.getState().accessToken;
    if (!token) throw new ApiError('UNAUTHENTICATED', 401, 'Not signed in');

    try {
      return await this.call({ ...request, accessToken: token });
    } catch (error) {
      if (!isApiError(error, 'TOKEN_EXPIRED')) throw error;
      const refreshed = await this.refresh();
      const retryToken = useSessionStore.getState().accessToken;
      if (!refreshed || !retryToken) throw new ApiError('UNAUTHENTICATED', 401, 'Session ended');
      return this.call({ ...request, accessToken: retryToken });
    }
  }

  /** Reloads the signed-in user (e.g. after verifying the email address). */
  async reloadUser(): Promise<SessionUser> {
    const user = await this.request({ method: 'GET', path: '/me', schema: SessionUserSchema });
    useSessionStore.setState({ user });
    return user;
  }

  /** Adopts a session returned by another endpoint (e.g. after a password change). */
  adoptSession(session: AuthSession): Promise<void> {
    return this.apply(session);
  }

  /** Clears the session on this device without calling the server (e.g. account deleted). */
  endLocalSession(): Promise<void> {
    return this.clear();
  }

  private async apply(session: AuthSession): Promise<void> {
    await this.deps.storage.setRefreshToken(session.tokens.refreshToken);
    useSessionStore.setState({
      status: 'signedIn',
      user: session.user,
      accessToken: session.tokens.accessToken,
      accessTokenExpiresAt: Date.parse(session.tokens.accessTokenExpiresAt),
    });
  }

  private async clear(): Promise<void> {
    await this.deps.storage.clear();
    useViewAsStore.getState().setSession(null);
    useSessionStore.setState({ ...INITIAL_STATE, status: 'signedOut' });
  }
}

let currentLanguage = 'en';
/** Kept in sync by I18nProvider so API calls send Accept-Language. */
export function setApiLanguage(language: string): void {
  currentLanguage = language;
}

export const sessionController = new SessionController({
  storage: secureTokenStorage,
  getLanguage: () => currentLanguage,
});

export function useSessionUser(): SessionUser | null {
  return useSessionStore((state) => state.user);
}

export function resetSessionStoreForTests(): void {
  useSessionStore.setState(INITIAL_STATE);
}
