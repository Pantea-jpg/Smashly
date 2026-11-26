import {
  ApnsDeviceTokenSchema,
  DeviceSchema,
  MarkNotificationsReadRequestSchema,
  NotificationQuerySchema,
  NotificationSchema,
  RegisterDeviceRequestSchema,
  UnreadCountSchema,
} from '@tw/contracts';
import { z } from 'zod';
import { requireSubjectId } from '../../core/context/request-context';
import type { ApiRouter } from '../../core/http/api-router';
import type { DevicesService } from './devices.service';
import type { NotificationsService } from './notifications.service';

/** The member's in-app notifications (readable in View-as mode; marking read is a write). */
export function registerNotificationRoutes(
  api: ApiRouter,
  deps: { notifications: NotificationsService; devices: DevicesService },
): void {
  const tags: [string] = ['Me · Notifications'];

  api.cursorList(
    {
      method: 'get',
      path: '/notifications',
      summary: 'My notifications, newest first',
      tags,
      auth: 'authenticated',
      request: { query: NotificationQuerySchema },
      item: NotificationSchema,
    },
    ({ req, query }) => deps.notifications.list(requireSubjectId(req), query),
  );

  api.route(
    {
      method: 'get',
      path: '/notifications/unread-count',
      summary: 'Number of unread notifications (tab badge)',
      tags,
      auth: 'authenticated',
      response: { status: 200, schema: UnreadCountSchema },
    },
    ({ req }) => deps.notifications.unreadCount(requireSubjectId(req)),
  );

  api.route(
    {
      method: 'post',
      path: '/notifications/read',
      summary: 'Mark some or all notifications as read',
      tags,
      auth: 'authenticated',
      request: { body: MarkNotificationsReadRequestSchema },
      response: { status: 200, schema: UnreadCountSchema },
      errors: ['VIEW_AS_READ_ONLY'],
    },
    ({ req, body }) => deps.notifications.markRead(requireSubjectId(req), body),
  );

  // ── Push devices ─────────────────────────────────────────────────────────
  const deviceTags: [string] = ['Me · Devices'];

  api.route(
    {
      method: 'post',
      path: '/devices',
      summary: 'Register this phone for push notifications',
      description:
        'Send the native APNs device token after sign-in and on every app launch. ' +
        'Registering a token that belongs to another account moves it to you.',
      tags: deviceTags,
      auth: 'authenticated',
      request: { body: RegisterDeviceRequestSchema },
      response: { status: 200, schema: DeviceSchema },
      errors: ['VIEW_AS_READ_ONLY'],
    },
    ({ req, body }) => deps.devices.register(requireSubjectId(req), body),
  );

  api.route(
    {
      method: 'delete',
      path: '/devices/:token',
      summary: 'Stop push notifications to this phone (call before signing out)',
      tags: deviceTags,
      auth: 'authenticated',
      request: { params: z.object({ token: ApnsDeviceTokenSchema }) },
      response: { status: 204, schema: null },
      errors: ['VIEW_AS_READ_ONLY'],
    },
    async ({ req, params }) => {
      await deps.devices.unregister(requireSubjectId(req), params.token);
    },
  );
}
