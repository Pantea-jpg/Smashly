import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  AuthSessionSchema,
  AvatarUploadUrlRequestSchema,
  AvatarUploadUrlSchema,
  ChangePasswordRequestSchema,
  ConfirmAvatarRequestSchema,
  DeleteAccountRequestSchema,
  NotificationPreferencesSchema,
  ProfileSchema,
  SessionUserSchema,
  UpdateNotificationPreferencesRequestSchema,
  UpdateProfileRequestSchema,
} from '@tw/contracts';
import type { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { forbidInViewMode } from '../../core/auth/authenticate';
import { auditContextOf, requireSubjectId } from '../../core/context/request-context';
import { ApiRouter } from '../../core/http/api-router';
import type { AuthService } from '../auth/auth.service';
import type { PaymentsService } from '../payments/payments.service';
import type { WalletQueryService } from '../wallets/wallet-query.service';
import { registerNotificationRoutes } from '../notifications/notifications.routes';
import type { DevicesService } from '../notifications/devices.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { registerMeTrainingRoutes } from '../trainings/trainings.routes';
import type { TrainingsService } from '../trainings/trainings.service';
import { registerMeWalletRoutes } from '../wallets/wallet.routes';
import type { ProfileService } from './profile.service';

/**
 * Endpoints scoped to the signed-in user, or in View-as mode to the viewed user (GET only:
 * the global guard rejects every other method that carries a view-session header).
 * Data is always scoped by `subject`, never by an id from the request.
 */
export function meRouter(deps: {
  registry: OpenAPIRegistry;
  prefix: string;
  auth: AuthService;
  profiles: ProfileService;
  walletQueries: WalletQueryService;
  payments: PaymentsService;
  trainings: TrainingsService;
  notifications: NotificationsService;
  devices: DevicesService;
  authenticate: RequestHandler;
}): Router {
  const api = new ApiRouter(deps.registry, deps.prefix);
  api.router.use(deps.authenticate);
  const tags: [string] = ['Me'];
  const { auth, profiles } = deps;

  api.route(
    {
      method: 'get',
      path: '/',
      summary: 'The signed-in user (or the viewed user in View-as mode)',
      tags,
      auth: 'authenticated',
      response: { status: 200, schema: SessionUserSchema },
    },
    ({ req }) => auth.getSessionUser(requireSubjectId(req)),
  );

  api.route(
    {
      method: 'get',
      path: '/profile',
      summary: 'Profile details incl. a short-lived profile picture URL',
      tags,
      auth: 'authenticated',
      response: { status: 200, schema: ProfileSchema },
    },
    ({ req }) => profiles.getProfile(requireSubjectId(req)),
  );

  api.route(
    {
      method: 'patch',
      path: '/profile',
      summary: 'Update name, phone (null clears it) or preferred language',
      description: 'The preferred language is used for emails and push notifications.',
      tags,
      auth: 'authenticated',
      request: { body: UpdateProfileRequestSchema },
      response: { status: 200, schema: ProfileSchema },
    },
    ({ req, body }) => profiles.updateProfile(requireSubjectId(req), body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'patch',
      path: '/password',
      summary: 'Change the password',
      description:
        'Signs out every other device and returns a fresh session for this one. Replace the stored tokens with the returned ones.',
      tags,
      auth: 'authenticated',
      request: { body: ChangePasswordRequestSchema },
      response: { status: 200, schema: AuthSessionSchema },
      errors: ['INVALID_CREDENTIALS', 'PASSWORD_BREACHED'],
    },
    ({ req, body }) => auth.changePassword(requireSubjectId(req), body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'get',
      path: '/notification-preferences',
      summary: 'Push notification preferences per category',
      tags,
      auth: 'authenticated',
      response: { status: 200, schema: NotificationPreferencesSchema },
    },
    ({ req }) => profiles.getPreferences(requireSubjectId(req)),
  );

  api.route(
    {
      method: 'put',
      path: '/notification-preferences',
      summary: 'Update push notification preferences',
      description: 'In-app notification history is always kept; this only controls push.',
      tags,
      auth: 'authenticated',
      request: { body: UpdateNotificationPreferencesRequestSchema },
      response: { status: 200, schema: NotificationPreferencesSchema },
    },
    ({ req, body }) => profiles.updatePreferences(requireSubjectId(req), body),
  );

  api.route(
    {
      method: 'post',
      path: '/avatar/upload-url',
      summary: 'Get a presigned URL to upload a new profile picture',
      description:
        'PUT the image bytes to `uploadUrl` with exactly the returned `headers`, then confirm with PUT /me/avatar. JPEG or PNG, max 5 MB; the link expires after 5 minutes.',
      tags,
      auth: 'authenticated',
      request: { body: AvatarUploadUrlRequestSchema },
      response: { status: 200, schema: AvatarUploadUrlSchema },
    },
    ({ req, body }) => profiles.createAvatarUpload(requireSubjectId(req), body),
  );

  api.route(
    {
      method: 'put',
      path: '/avatar',
      summary: 'Confirm an uploaded profile picture',
      tags,
      auth: 'authenticated',
      request: { body: ConfirmAvatarRequestSchema },
      response: { status: 200, schema: ProfileSchema },
    },
    ({ req, body }) =>
      profiles.confirmAvatar(requireSubjectId(req), body.objectKey, auditContextOf(req)),
  );

  api.route(
    {
      method: 'delete',
      path: '/avatar',
      summary: 'Remove the profile picture',
      tags,
      auth: 'authenticated',
      response: { status: 200, schema: ProfileSchema },
    },
    ({ req }) => profiles.removeAvatar(requireSubjectId(req), auditContextOf(req)),
  );

  api.route(
    {
      method: 'get',
      path: '/export',
      summary: 'Download all personal data (GDPR)',
      description: 'Not available in View-as mode.',
      tags,
      auth: 'authenticated',
      middleware: [forbidInViewMode],
      response: { status: 200, schema: z.record(z.string(), z.unknown()) },
      errors: ['VIEW_AS_READ_ONLY'],
    },
    ({ req }) => profiles.exportData(requireSubjectId(req), auditContextOf(req)),
  );

  api.route(
    {
      method: 'delete',
      path: '/',
      summary: 'Delete the account',
      description:
        'Requires the password. Personal data is anonymised and all sessions end; financial records are retained without personal data. Refused while the wallet has a balance or outstanding debt.',
      tags,
      auth: 'authenticated',
      request: { body: DeleteAccountRequestSchema },
      response: { status: 204, schema: null },
      errors: ['INVALID_CREDENTIALS', 'ACCOUNT_HAS_BALANCE_OR_DEBT', 'FORBIDDEN'],
    },
    async ({ req, body }) => {
      await profiles.deleteAccount(requireSubjectId(req), body.password, auditContextOf(req));
    },
  );

  registerMeWalletRoutes(api, { queries: deps.walletQueries, payments: deps.payments });
  registerMeTrainingRoutes(api, { trainings: deps.trainings });
  registerNotificationRoutes(api, { notifications: deps.notifications, devices: deps.devices });

  return api.router;
}
