import nodemailer, { type Transporter } from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
  verify?(): Promise<void>;
}

/** SMTP delivery (Mailpit locally; Postmark/SES SMTP in staging/production). */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }

  async verify(): Promise<void> {
    await this.transport.verify();
  }
}

/**
 * For test environments without an email provider (SMTP_URL=log://): every email is written
 * to the log, so verification and password-reset links can be copied from the Render logs.
 * Refused in production (config/env.ts), because the links are sign-in secrets.
 */
export class LogMailer implements Mailer {
  constructor(private readonly logger: { info: (obj: object, msg: string) => void }) {}

  send(message: EmailMessage): Promise<void> {
    this.logger.info(
      { mailTo: message.to, subject: message.subject, body: message.text },
      'email not sent (SMTP_URL=log://); content logged for testing',
    );
    return Promise.resolve();
  }
}

/** Builds the mailer for SMTP_URL. */
export function createMailer(
  smtpUrl: string,
  from: string,
  logger: { info: (obj: object, msg: string) => void },
): Mailer {
  return smtpUrl.startsWith('log:') ? new LogMailer(logger) : new SmtpMailer(smtpUrl, from);
}

/** Test double: keeps sent messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  failNext = 0;

  send(message: EmailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('Simulated SMTP failure'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}
