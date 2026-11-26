/** One push to one device. Text is already rendered in the recipient's language. */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** App icon badge (unread count). */
  badge?: number;
  /** Groups notifications in Notification Center (we use the category). */
  threadId?: string;
  /** Delivered to the app with the notification (ids for navigation on tap). */
  data: Record<string, string>;
  /** APNs drops the push if it cannot be delivered before this (e.g. a reminder after the start). */
  expiresAt?: Date;
}

export type PushResult =
  | { ok: true; providerMessageId: string | null }
  /**
   * `unregistered`: the token is dead (app uninstalled, token rotated, wrong environment) and
   * must not be used again. Otherwise the failure is transient and may be retried.
   */
  | { ok: false; reason: string; unregistered: boolean };

export interface PushProvider {
  readonly name: string;
  send(message: PushMessage): Promise<PushResult>;
  close?(): Promise<void>;
}

/** Development without APNs credentials: logs what would be sent. */
export class LogPushProvider implements PushProvider {
  readonly name = 'log';
  constructor(private readonly log: (message: PushMessage) => void) {}

  send(message: PushMessage): Promise<PushResult> {
    this.log(message);
    return Promise.resolve({ ok: true, providerMessageId: null });
  }
}

/** Tests: records every push and answers per token (default: success). */
export class FakePushProvider implements PushProvider {
  readonly name = 'fake';
  readonly sent: PushMessage[] = [];
  private readonly responses = new Map<string, PushResult>();

  /** Makes every push to `token` answer `result` (e.g. APNs 410 Unregistered). */
  respond(token: string, result: PushResult): void {
    this.responses.set(token, result);
  }

  send(message: PushMessage): Promise<PushResult> {
    const result = this.responses.get(message.token);
    if (!result || result.ok) this.sent.push(message);
    return Promise.resolve(
      result ?? { ok: true, providerMessageId: `fake-${String(this.sent.length)}` },
    );
  }

  reset(): void {
    this.sent.length = 0;
    this.responses.clear();
  }
}
