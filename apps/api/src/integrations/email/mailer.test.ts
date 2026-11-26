import { describe, expect, it, vi } from 'vitest';
import { createMailer, LogMailer, SmtpMailer } from './mailer';

describe('createMailer', () => {
  it('logs emails instead of sending them for SMTP_URL=log://', async () => {
    const logger = { info: vi.fn() };
    const mailer = createMailer('log://', 'TW <no-reply@example.test>', logger);
    expect(mailer).toBeInstanceOf(LogMailer);
    await mailer.send({
      to: 'anna@example.test',
      subject: 'Confirm your email',
      text: 'Open trainingwallet-staging://verify-email?token=abc',
      html: '<p>…</p>',
    });
    expect(logger.info).toHaveBeenCalledWith(
      {
        mailTo: 'anna@example.test',
        subject: 'Confirm your email',
        body: 'Open trainingwallet-staging://verify-email?token=abc',
      },
      expect.stringContaining('not sent'),
    );
  });

  it('uses SMTP for any other URL', () => {
    expect(createMailer('smtp://localhost:1025', 'TW <a@b.c>', { info: vi.fn() })).toBeInstanceOf(
      SmtpMailer,
    );
  });
});
