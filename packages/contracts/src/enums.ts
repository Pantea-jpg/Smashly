import { z } from 'zod';

/**
 * Domain enums shared by API and app. Values MUST match the Prisma enums in
 * apps/api/prisma/schema.prisma (a test in apps/api enforces this).
 */

export const Role = z.enum(['ADMIN', 'USER']);
export type Role = z.infer<typeof Role>;

export const UserStatus = z.enum(['PENDING_APPROVAL', 'ACTIVE', 'INACTIVE']);
export type UserStatus = z.infer<typeof UserStatus>;

export const TrainingStatus = z.enum(['SCHEDULED', 'CANCELLED', 'COMPLETED']);
export type TrainingStatus = z.infer<typeof TrainingStatus>;

export const ReservationStatus = z.enum(['ATTENDING', 'NOT_ATTENDING']);
export type ReservationStatus = z.infer<typeof ReservationStatus>;

export const AttendanceStatus = z.enum(['PENDING', 'PRESENT', 'ABSENT', 'EXCUSED']);
export type AttendanceStatus = z.infer<typeof AttendanceStatus>;

export const TransactionType = z.enum([
  'ONLINE_TOP_UP',
  'CASH_TOP_UP',
  'TRAINING_PAYMENT',
  'DEBT_PAYMENT',
  'REFUND',
  'ADJUSTMENT',
  'REVERSAL',
]);
export type TransactionType = z.infer<typeof TransactionType>;

export const PaymentMethod = z.enum(['STRIPE', 'CASH', 'WALLET', 'SYSTEM']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const PriceSource = z.enum(['TRAINING_DEFAULT', 'USER_STANDING_PRICE', 'TRAINING_OVERRIDE']);
export type PriceSource = z.infer<typeof PriceSource>;

export const ChargeStatus = z.enum(['ACTIVE', 'REVERSED']);
export type ChargeStatus = z.infer<typeof ChargeStatus>;

export const DebtSource = z.enum(['TRAINING_CHARGE', 'TOP_UP_REVERSAL']);
export type DebtSource = z.infer<typeof DebtSource>;

export const DebtStatus = z.enum(['OPEN', 'SETTLED', 'CANCELLED']);
export type DebtStatus = z.infer<typeof DebtStatus>;

export const PaymentProvider = z.enum(['STRIPE']);
export type PaymentProvider = z.infer<typeof PaymentProvider>;

export const PaymentStatus = z.enum([
  'REQUIRES_PAYMENT',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'REQUIRES_REVIEW',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DISPUTED',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const NotificationType = z.enum([
  'TRAINING_CREATED',
  'TRAINING_UPDATED',
  'TRAINING_CANCELLED',
  'TRAINING_REMINDER',
  'RESERVATION_CONFIRMED',
  'ATTENDANCE_RECORDED',
  'TRAINING_CHARGED',
  'TOP_UP_SUCCEEDED',
  'TOP_UP_FAILED',
  'CASH_PAYMENT_RECORDED',
  'LOW_BALANCE',
  'DEBT_REMINDER',
  'ATTENDANCE_FINALIZATION_REMINDER',
]);
export type NotificationType = z.infer<typeof NotificationType>;

export const NotificationCategory = z.enum(['TRAININGS', 'PAYMENTS', 'REMINDERS']);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

export const DevicePlatform = z.enum(['IOS', 'ANDROID', 'WEB']);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const PushProvider = z.enum(['APNS', 'FCM']);
export type PushProvider = z.infer<typeof PushProvider>;

export const DeliveryStatus = z.enum(['SENT', 'FAILED', 'SKIPPED']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** Every shared enum, keyed by its Prisma enum name. Used by the schema-parity test. */
export const SHARED_ENUMS = {
  Role,
  UserStatus,
  TrainingStatus,
  ReservationStatus,
  AttendanceStatus,
  TransactionType,
  PaymentMethod,
  PriceSource,
  ChargeStatus,
  DebtSource,
  DebtStatus,
  PaymentProvider,
  PaymentStatus,
  NotificationType,
  NotificationCategory,
  DevicePlatform,
  PushProvider,
  DeliveryStatus,
} as const;
