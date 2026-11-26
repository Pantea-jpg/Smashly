import { QuietHoursSchema } from '@tw/contracts';
import { z } from 'zod';
import { type Db, Prisma } from '../../core/db/prisma';

/**
 * Business settings editable by admins (Admin → Settings, Phase 4+).
 * Each key has a schema and a default; a missing or invalid stored value falls back to the default.
 */
const minor = z.number().int().nonnegative().max(1_000_000_00);

export const SETTING_DEFINITIONS = {
  /** D2: new registrations need admin approval before they can sign in. */
  'registration.requireApproval': { schema: z.boolean(), default: false },
  /** D14: per online top-up limits and the maximum wallet balance (minor units, EUR). */
  'wallet.topUpMinMinor': { schema: minor, default: 500 },
  'wallet.topUpMaxMinor': { schema: minor, default: 50_000 },
  'wallet.maxBalanceMinor': { schema: minor, default: 100_000 },
  'wallet.topUpPresetsMinor': {
    schema: z.array(minor).max(8),
    default: [1000, 2500, 5000, 10_000],
  },
  /** D21: a push when the balance drops below this (at most once per 7 days). */
  'wallet.lowBalanceThresholdMinor': { schema: minor, default: 1000 },
  /** D10: optionally refuse new reservations while debt exceeds this amount (null = never). */
  'reservations.blockWhenDebtAboveMinor': { schema: minor.nullable(), default: null },
  /** D22: no pushes in this window, in each user's own timezone (null = off). */
  'notifications.quietHours': {
    schema: QuietHoursSchema.nullable(),
    default: { start: '22:00', end: '08:00' } as { start: string; end: string } | null,
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFINITIONS)[K]['schema']>;

export class SettingsService {
  constructor(private readonly db: Db) {}

  async get<K extends SettingKey>(key: K, db: Db = this.db): Promise<SettingValue<K>> {
    const definition = SETTING_DEFINITIONS[key];
    const row = await db.appSetting.findUnique({ where: { key } });
    if (!row) return definition.default as SettingValue<K>;
    const parsed = definition.schema.safeParse(row.value);
    return (parsed.success ? parsed.data : definition.default) as SettingValue<K>;
  }

  async set<K extends SettingKey>(
    key: K,
    value: SettingValue<K>,
    updatedById: string | null,
    db: Db = this.db,
  ): Promise<void> {
    const parsed = SETTING_DEFINITIONS[key].schema.parse(value);
    // A JSON null ("not set", e.g. no debt limit) must be stored as Prisma.JsonNull.
    const json = parsed === null ? Prisma.JsonNull : parsed;
    await db.appSetting.upsert({
      where: { key },
      create: { key, value: json, updatedById },
      update: { value: json, updatedById },
    });
  }
}
