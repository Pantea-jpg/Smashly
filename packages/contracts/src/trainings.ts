import { z } from 'zod';
import {
  CursorQuerySchema,
  IdSchema,
  IsoDateTimeSchema,
  MoneySchema,
  OffsetQuerySchema,
} from './common';
import {
  AttendanceStatus,
  ChargeStatus,
  PriceSource,
  ReservationStatus,
  TrainingStatus,
} from './enums';
import { LedgerResultSchema } from './wallet';

const TitleSchema = z.string().trim().min(1).max(120);
const DescriptionSchema = z.string().trim().max(2000);
const LocationSchema = z.string().trim().min(1).max(200);
const ReasonSchema = z.string().trim().min(3, { message: 'required' }).max(500);
const PriceMinorSchema = z.number().int().min(0).max(1_000_000);
const CapacitySchema = z.number().int().min(1).max(10_000);
/** IANA timezone, e.g. "Europe/Amsterdam" (validated on the server). */
const TimeZoneSchema = z.string().min(1).max(64);
const LocalDateSchema = z.iso.date();
const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'HH:MM' });

export const Weekday = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export type Weekday = z.infer<typeof Weekday>;

export const PersonSchema = z.object({
  id: IdSchema,
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
});
export type Person = z.infer<typeof PersonSchema>;

export const ResolvedPriceSchema = z.object({ price: MoneySchema, source: PriceSource });

export const ChargeSummarySchema = z.object({
  id: IdSchema,
  status: ChargeStatus,
  unitPrice: MoneySchema,
  priceSource: PriceSource,
  paidFromWallet: MoneySchema,
  shortfall: MoneySchema,
  createdAt: IsoDateTimeSchema,
});

// ── Trainings ───────────────────────────────────────────────────────────────

export const TrainingSchema = z.object({
  id: IdSchema,
  seriesId: IdSchema.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  timezone: z.string(),
  capacity: z.number().int().nullable(),
  attendingCount: z.number().int(),
  /** null when capacity is unlimited. */
  spotsLeft: z.number().int().nullable(),
  defaultPrice: MoneySchema,
  reservationDeadline: IsoDateTimeSchema,
  deadlinePassed: z.boolean(),
  status: TrainingStatus,
  cancelledAt: IsoDateTimeSchema.nullable(),
  cancellationReason: z.string().nullable(),
  finalizedAt: IsoDateTimeSchema.nullable(),
});
export type Training = z.infer<typeof TrainingSchema>;

/** A training as one member sees it: their price, response, attendance and charge. */
export const MeTrainingSchema = TrainingSchema.extend({
  myPrice: ResolvedPriceSchema,
  myReservation: ReservationStatus.nullable(),
  myAttendance: AttendanceStatus.nullable(),
  myCharge: ChargeSummarySchema.nullable(),
});
export type MeTraining = z.infer<typeof MeTrainingSchema>;

export const MeTrainingQuerySchema = CursorQuerySchema.extend({
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
});

export const ReservationRequestSchema = z.object({ status: ReservationStatus });

export const ReservationResultSchema = z.object({
  training: MeTrainingSchema,
  /** Reserving is allowed with debt (D10); the app shows this warning. */
  warning: z.enum(['OUTSTANDING_DEBT']).nullable(),
});

export const AdminTrainingSchema = TrainingSchema.extend({
  createdById: IdSchema,
  finalizedById: IdSchema.nullable(),
  counts: z.object({
    attending: z.number().int(),
    notAttending: z.number().int(),
    noResponse: z.number().int(),
    present: z.number().int(),
    absent: z.number().int(),
    excused: z.number().int(),
    pending: z.number().int(),
  }),
});
export type AdminTraining = z.infer<typeof AdminTrainingSchema>;

export const AdminTrainingQuerySchema = OffsetQuerySchema.extend({
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  status: TrainingStatus.optional(),
  seriesId: IdSchema.optional(),
});

const trainingTimes = <
  T extends {
    startsAt?: string | undefined;
    endsAt?: string | undefined;
    reservationDeadline?: string | undefined;
  },
>(
  v: T,
  ctx: z.RefinementCtx,
) => {
  if (v.startsAt && v.endsAt && new Date(v.endsAt) <= new Date(v.startsAt)) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'must_be_after_start' });
  }
  if (
    v.startsAt &&
    v.reservationDeadline &&
    new Date(v.reservationDeadline) > new Date(v.startsAt)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['reservationDeadline'],
      message: 'must_not_be_after_start',
    });
  }
};

export const CreateTrainingRequestSchema = z
  .object({
    title: TitleSchema,
    description: DescriptionSchema.optional(),
    location: LocationSchema,
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
    timezone: TimeZoneSchema.default('Europe/Amsterdam'),
    capacity: CapacitySchema.nullable().optional(),
    defaultPriceMinor: PriceMinorSchema,
    /** Defaults to the start time. */
    reservationDeadline: IsoDateTimeSchema.optional(),
  })
  .superRefine(trainingTimes);

export const UpdateTrainingRequestSchema = z
  .object({
    title: TitleSchema,
    description: DescriptionSchema.nullable(),
    location: LocationSchema,
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
    timezone: TimeZoneSchema,
    capacity: CapacitySchema.nullable(),
    defaultPriceMinor: PriceMinorSchema,
    reservationDeadline: IsoDateTimeSchema,
  })
  .partial()
  .superRefine(trainingTimes);

export const CancelTrainingRequestSchema = z.object({ reason: ReasonSchema });

export const CancelTrainingResultSchema = z.object({
  training: AdminTrainingSchema,
  /** Charges reversed because the training was already finalized (D12). */
  reversedCharges: z.number().int(),
});

// ── Series (D7) ─────────────────────────────────────────────────────────────

export const TrainingSeriesSchema = z.object({
  id: IdSchema,
  title: z.string(),
  description: z.string().nullable(),
  location: z.string(),
  rrule: z.string(),
  weekdays: z.array(Weekday),
  intervalWeeks: z.number().int(),
  startTimeLocal: z.string(),
  durationMinutes: z.number().int(),
  timezone: z.string(),
  capacity: z.number().int().nullable(),
  defaultPrice: MoneySchema,
  deadlineOffsetMinutes: z.number().int(),
  startsOn: LocalDateSchema,
  endsOn: LocalDateSchema.nullable(),
  upcomingCount: z.number().int(),
  createdAt: IsoDateTimeSchema,
});
export type TrainingSeries = z.infer<typeof TrainingSeriesSchema>;

export const CreateTrainingSeriesRequestSchema = z
  .object({
    title: TitleSchema,
    description: DescriptionSchema.optional(),
    location: LocationSchema,
    weekdays: z.array(Weekday).min(1).max(7),
    intervalWeeks: z.number().int().min(1).max(8).default(1),
    startTimeLocal: LocalTimeSchema,
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    timezone: TimeZoneSchema.default('Europe/Amsterdam'),
    capacity: CapacitySchema.nullable().optional(),
    defaultPriceMinor: PriceMinorSchema,
    /** Reservation deadline = start − this many minutes (0 = until the start). */
    deadlineOffsetMinutes: z
      .number()
      .int()
      .min(0)
      .max(14 * 24 * 60)
      .default(0),
    startsOn: LocalDateSchema,
    endsOn: LocalDateSchema.optional(),
  })
  .refine((v) => !v.endsOn || v.endsOn >= v.startsOn, {
    path: ['endsOn'],
    message: 'before_start',
  });

/** Applied to the series and to its future sessions that have not been cancelled. */
export const UpdateTrainingSeriesRequestSchema = z
  .object({
    title: TitleSchema,
    description: DescriptionSchema.nullable(),
    location: LocationSchema,
    capacity: CapacitySchema.nullable(),
    defaultPriceMinor: PriceMinorSchema,
    endsOn: LocalDateSchema.nullable(),
  })
  .partial();

export const SeriesChangeResultSchema = z.object({
  series: TrainingSeriesSchema,
  updatedSessions: z.number().int(),
  createdSessions: z.number().int(),
  removedSessions: z.number().int(),
  cancelledSessions: z.number().int(),
});

// ── Reservations (admin) ────────────────────────────────────────────────────

export const AdminReservationRowSchema = z.object({
  user: PersonSchema,
  /** null = no response yet. */
  status: ReservationStatus.nullable(),
  respondedAt: IsoDateTimeSchema.nullable(),
  respondedByAdmin: z.boolean(),
});

export const AdminSetReservationRequestSchema = z.object({
  status: ReservationStatus,
  /** Allow ATTENDING beyond capacity. */
  force: z.boolean().default(false),
});

// ── Pricing ─────────────────────────────────────────────────────────────────

export const TrainingPriceRowSchema = z.object({
  user: PersonSchema,
  price: MoneySchema,
  source: PriceSource,
});

export const PriceRequestSchema = z.object({ priceMinor: PriceMinorSchema });

export const StandingPriceSchema = z.object({
  userId: IdSchema,
  price: MoneySchema.nullable(),
});

// ── Attendance ──────────────────────────────────────────────────────────────

export const AttendanceRowSchema = z.object({
  user: PersonSchema,
  reservation: ReservationStatus.nullable(),
  /** PENDING until marked; also PENDING for ATTENDING members without a row yet. */
  status: AttendanceStatus,
  note: z.string().nullable(),
  markedAt: IsoDateTimeSchema.nullable(),
  price: ResolvedPriceSchema,
  charge: ChargeSummarySchema.nullable(),
});
export type AttendanceRow = z.infer<typeof AttendanceRowSchema>;

export const BulkAttendanceRequestSchema = z.object({
  entries: z
    .array(
      z.object({
        userId: IdSchema,
        status: AttendanceStatus,
        note: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .min(1)
    .max(500)
    .refine((e) => new Set(e.map((x) => x.userId)).size === e.length, {
      message: 'duplicate_user',
    }),
});

export const FinalizeAttendanceRequestSchema = z.object({
  /** Without this, finalization is refused while anyone is still PENDING. */
  pendingAs: z.enum(['ABSENT']).optional(),
});

export const FinalizeResultSchema = z.object({
  training: AdminTrainingSchema,
  charged: z.number().int(),
  totalCharged: MoneySchema,
  paidFromWallets: MoneySchema,
  debtCreated: MoneySchema,
});

export const AttendanceCorrectionRequestSchema = z.object({
  status: z.enum(['PRESENT', 'ABSENT', 'EXCUSED']),
  reason: ReasonSchema,
});

export const AttendanceCorrectionResultSchema = z.object({
  attendance: AttendanceRowSchema,
  reversal: LedgerResultSchema.nullable(),
  charge: LedgerResultSchema.nullable(),
});

export const AttendanceQueueItemSchema = z.object({
  training: TrainingSchema,
  pending: z.number().int(),
  present: z.number().int(),
  hoursSinceEnd: z.number().int(),
});

// ── History ─────────────────────────────────────────────────────────────────

export const TrainingHistoryItemSchema = z.object({
  training: TrainingSchema,
  reservation: ReservationStatus.nullable(),
  attendance: AttendanceStatus.nullable(),
  charge: ChargeSummarySchema.nullable(),
});
export type TrainingHistoryItem = z.infer<typeof TrainingHistoryItemSchema>;

export const UserTrainingHistoryQuerySchema = OffsetQuerySchema;
