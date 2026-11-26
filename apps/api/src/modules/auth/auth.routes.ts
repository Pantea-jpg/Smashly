import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  AcceptedSchema,
  AuthSessionSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  ResetPasswordRequestSchema,
  VerifyEmailRequestSchema,
} from '@tw/contracts';
import type { RequestHandler, Router } from 'express';
import { auditContextOf, requireActor } from '../../core/context/request-context';
import { AppError } from '../../core/errors/app-error';
import { ApiRouter } from '../../core/http/api-router';
import type { RateLimiters } from '../../core/security/rate-limit';
import type { AuthService } from './auth.service';

export function authRouter(deps: {
  registry: OpenAPIRegistry;
  prefix: string;
  auth: AuthService;
  authenticate: RequestHandler;
  limits: RateLimiters;
}): Router {
  const api = new ApiRouter(deps.registry, deps.prefix);
  const { auth, authenticate, limits } = deps;
  const tags: [string] = ['Auth'];

  api.route(
    {
      method: 'post',
      path: '/register',
      summary: 'Create a user account',
      description:
        'Creates a USER account with an EUR wallet and sends a verification email. Returns a session, or `PENDING_APPROVAL` when admin approval is required.',
      tags,
      auth: 'public',
      middleware: [limits.register],
      request: { body: RegisterRequestSchema },
      response: { status: 201, schema: RegisterResponseSchema },
      errors: ['EMAIL_ALREADY_REGISTERED', 'PASSWORD_BREACHED'],
    },
    ({ req, body }) => auth.register(body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'post',
      path: '/login',
      summary: 'Sign in with email and password',
      tags,
      auth: 'public',
      middleware: [limits.login, limits.loginAccount, limits.loginIp],
      request: { body: LoginRequestSchema },
      response: { status: 200, schema: AuthSessionSchema },
      errors: ['INVALID_CREDENTIALS', 'ACCOUNT_INACTIVE', 'ACCOUNT_PENDING_APPROVAL'],
    },
    ({ req, body }) => auth.login(body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'post',
      path: '/refresh',
      summary: 'Rotate the refresh token and get a new access token',
      description:
        'Each refresh token works once. Presenting a rotated token revokes the whole session (reuse detection), except within a 20-second grace window for lost responses.',
      tags,
      auth: 'public',
      middleware: [limits.refresh],
      request: { body: RefreshRequestSchema },
      response: { status: 200, schema: AuthSessionSchema },
      errors: ['UNAUTHENTICATED', 'ACCOUNT_INACTIVE', 'ACCOUNT_PENDING_APPROVAL'],
    },
    ({ req, body }) => auth.refresh(body.refreshToken, auditContextOf(req)),
  );

  api.route(
    {
      method: 'post',
      path: '/logout',
      summary: 'End the current session',
      tags,
      auth: 'authenticated',
      middleware: [authenticate],
      response: { status: 204, schema: null },
    },
    async ({ req }) => {
      const sessionId = req.context.sessionId;
      if (!sessionId) throw AppError.unauthenticated();
      await auth.logout(sessionId, auditContextOf(req));
    },
  );

  api.route(
    {
      method: 'post',
      path: '/logout-all',
      summary: 'End all sessions on all devices',
      tags,
      auth: 'authenticated',
      middleware: [authenticate],
      response: { status: 204, schema: null },
    },
    async ({ req }) => {
      await auth.logoutAll(requireActor(req).id, auditContextOf(req));
    },
  );

  api.route(
    {
      method: 'post',
      path: '/password/forgot',
      summary: 'Request a password reset email',
      description: 'Always returns 202, whether or not the account exists.',
      tags,
      auth: 'public',
      middleware: [limits.passwordForgot],
      request: { body: ForgotPasswordRequestSchema },
      response: { status: 202, schema: AcceptedSchema },
    },
    async ({ req, body }) => {
      await auth.forgotPassword(body.email, auditContextOf(req));
      return { accepted: true as const };
    },
  );

  api.route(
    {
      method: 'post',
      path: '/password/reset',
      summary: 'Set a new password with a reset token',
      description: 'Signs the user out on all devices.',
      tags,
      auth: 'public',
      middleware: [limits.passwordReset],
      request: { body: ResetPasswordRequestSchema },
      response: { status: 204, schema: null },
      errors: ['INVALID_TOKEN', 'PASSWORD_BREACHED'],
    },
    async ({ req, body }) => {
      await auth.resetPassword(body.token, body.newPassword, auditContextOf(req));
    },
  );

  api.route(
    {
      method: 'post',
      path: '/email/verify',
      summary: 'Confirm an email address',
      tags,
      auth: 'public',
      middleware: [limits.emailVerify],
      request: { body: VerifyEmailRequestSchema },
      response: { status: 204, schema: null },
      errors: ['INVALID_TOKEN'],
    },
    async ({ req, body }) => {
      await auth.verifyEmail(body.token, auditContextOf(req));
    },
  );

  api.route(
    {
      method: 'post',
      path: '/email/resend',
      summary: 'Send a new verification email',
      tags,
      auth: 'authenticated',
      middleware: [authenticate, limits.emailResend],
      response: { status: 202, schema: AcceptedSchema },
    },
    async ({ req }) => {
      await auth.resendVerification(requireActor(req).id);
      return { accepted: true as const };
    },
  );

  return api.router;
}
