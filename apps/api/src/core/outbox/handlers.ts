import type { Mailer } from '../../integrations/email/mailer';
import { renderEmail } from '../../integrations/email/templates';
import type { PushService } from '../../modules/notifications/push.service';
import type { OutboxHandlers } from './outbox';

export function createOutboxHandlers(deps: {
  mailer: Mailer;
  push: Pick<PushService, 'deliver'>;
}): OutboxHandlers {
  return {
    'email.send': {
      handle: (job) => deps.mailer.send(renderEmail(job)),
      // One-time links must not linger in the database after delivery.
      redact: (job) => ({
        ...job,
        params: { ...job.params, ...(job.params.link ? { link: '[redacted]' } : {}) },
      }),
    },
    'notification.push': {
      handle: async (job) => {
        await deps.push.deliver(job);
      },
    },
  };
}
