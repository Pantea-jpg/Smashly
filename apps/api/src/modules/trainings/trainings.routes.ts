import {
  AdminReservationRowSchema,
  AdminSetReservationRequestSchema,
  AdminTrainingQuerySchema,
  AdminTrainingSchema,
  AttendanceCorrectionRequestSchema,
  AttendanceCorrectionResultSchema,
  AttendanceQueueItemSchema,
  AttendanceRowSchema,
  BulkAttendanceRequestSchema,
  CancelTrainingRequestSchema,
  CancelTrainingResultSchema,
  CreateTrainingRequestSchema,
  CreateTrainingSeriesRequestSchema,
  CursorQuerySchema,
  FinalizeAttendanceRequestSchema,
  FinalizeResultSchema,
  IdSchema,
  MeTrainingQuerySchema,
  MeTrainingSchema,
  PriceRequestSchema,
  ReservationRequestSchema,
  ReservationResultSchema,
  SeriesChangeResultSchema,
  StandingPriceSchema,
  TrainingHistoryItemSchema,
  TrainingPriceRowSchema,
  TrainingSeriesSchema,
  UpdateTrainingRequestSchema,
  UpdateTrainingSeriesRequestSchema,
  UserIdParamsSchema,
  UserTrainingHistoryQuerySchema,
} from '@tw/contracts';
import { z } from 'zod';
import { auditContextOf, requireSubjectId } from '../../core/context/request-context';
import type { PrismaClient } from '../../core/db/prisma';
import type { ApiRouter } from '../../core/http/api-router';
import { idempotency } from '../../core/idempotency/idempotency';
import type { AttendanceService } from './attendance.service';
import type { PricingService } from './pricing.service';
import type { SeriesService } from './series.service';
import type { TrainingsService } from './trainings.service';

const IdParams = z.object({ id: IdSchema });
const TrainingUserParams = z.object({ id: IdSchema, userId: IdSchema });

/** The member's (or, in View-as mode, the viewed member's) trainings and reservations. */
export function registerMeTrainingRoutes(
  api: ApiRouter,
  deps: { trainings: TrainingsService },
): void {
  const tags: [string] = ['Me · Trainings'];
  const { trainings } = deps;

  api.cursorList(
    {
      method: 'get',
      path: '/trainings',
      summary: 'Upcoming trainings, or past ones I took part in, with my price and status',
      tags,
      auth: 'authenticated',
      request: { query: MeTrainingQuerySchema },
      item: MeTrainingSchema,
    },
    ({ req, query }) => trainings.listMe(requireSubjectId(req), query),
  );

  api.route(
    {
      method: 'get',
      path: '/trainings/:id',
      summary: 'One training with my price, response, attendance and charge',
      tags,
      auth: 'authenticated',
      request: { params: IdParams },
      response: { status: 200, schema: MeTrainingSchema },
      errors: ['NOT_FOUND'],
    },
    ({ req, params }) => trainings.meTraining(requireSubjectId(req), params.id),
  );

  api.route(
    {
      method: 'put',
      path: '/trainings/:id/reservation',
      summary: 'Say whether I attend (idempotent; checks deadline and capacity)',
      description:
        'Reserving with outstanding debt is allowed and returns a warning, unless the admin set a debt limit (D10).',
      tags,
      auth: 'authenticated',
      request: { params: IdParams, body: ReservationRequestSchema },
      response: { status: 200, schema: ReservationResultSchema },
      errors: [
        'NOT_FOUND',
        'TRAINING_FULL',
        'TRAINING_CANCELLED',
        'RESERVATION_DEADLINE_PASSED',
        'ATTENDANCE_FINALIZED',
        'RESERVATION_BLOCKED_BY_DEBT',
        'VIEW_AS_READ_ONLY',
      ],
    },
    ({ req, params, body }) => trainings.reserve(requireSubjectId(req), params.id, body.status),
  );

  api.cursorList(
    {
      method: 'get',
      path: '/attendance',
      summary: 'My attendance history with charges, newest first',
      tags,
      auth: 'authenticated',
      request: { query: CursorQuerySchema },
      item: TrainingHistoryItemSchema,
    },
    ({ req, query }) => trainings.meAttendance(requireSubjectId(req), query),
  );
}

export function registerAdminTrainingRoutes(
  api: ApiRouter,
  deps: {
    prisma: PrismaClient;
    trainings: TrainingsService;
    attendance: AttendanceService;
    pricing: PricingService;
    series: SeriesService;
  },
): void {
  const tags = {
    trainings: ['Admin · Trainings'] as [string],
    series: ['Admin · Training series'] as [string],
    attendance: ['Admin · Attendance'] as [string],
    pricing: ['Admin · Pricing'] as [string],
  };
  const requireKey = idempotency(deps.prisma, { required: true });
  const optionalKey = idempotency(deps.prisma, { required: false });
  const { trainings, attendance, pricing, series } = deps;

  // ── Trainings ────────────────────────────────────────────────────────────

  api.offsetList(
    {
      method: 'get',
      path: '/trainings',
      summary: 'Trainings by date, with response and attendance counts',
      tags: tags.trainings,
      auth: 'admin',
      request: { query: AdminTrainingQuerySchema },
      item: AdminTrainingSchema,
    },
    ({ query }) => trainings.listAdmin(query),
  );

  api.route(
    {
      method: 'post',
      path: '/trainings',
      summary: 'Create a training (members are notified)',
      tags: tags.trainings,
      auth: 'admin',
      idempotencyKey: 'optional',
      middleware: [optionalKey],
      request: { body: CreateTrainingRequestSchema },
      response: { status: 201, schema: AdminTrainingSchema },
    },
    ({ req, body }) => trainings.create(body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'get',
      path: '/trainings/:id',
      summary: 'Training detail with counts and finalization state',
      tags: tags.trainings,
      auth: 'admin',
      request: { params: IdParams },
      response: { status: 200, schema: AdminTrainingSchema },
      errors: ['NOT_FOUND'],
    },
    ({ params }) => trainings.getAdmin(params.id),
  );

  api.route(
    {
      method: 'patch',
      path: '/trainings/:id',
      summary: 'Edit a training (attendees are told about schedule and price changes)',
      description:
        'Existing charges never change. After finalization only title, description and location can be edited.',
      tags: tags.trainings,
      auth: 'admin',
      request: { params: IdParams, body: UpdateTrainingRequestSchema },
      response: { status: 200, schema: AdminTrainingSchema },
      errors: ['NOT_FOUND', 'TRAINING_CANCELLED', 'ATTENDANCE_FINALIZED'],
    },
    ({ req, params, body }) => trainings.update(params.id, body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'post',
      path: '/trainings/:id/cancel',
      summary: 'Cancel a training; if already finalized, every charge is reversed (D12)',
      tags: tags.trainings,
      auth: 'admin',
      idempotencyKey: 'optional',
      middleware: [optionalKey],
      request: { params: IdParams, body: CancelTrainingRequestSchema },
      response: { status: 200, schema: CancelTrainingResultSchema },
      errors: ['NOT_FOUND', 'TRAINING_CANCELLED'],
    },
    ({ req, params, body }) => trainings.cancel(params.id, body.reason, auditContextOf(req)),
  );

  api.route(
    {
      method: 'delete',
      path: '/trainings/:id',
      summary: 'Delete a training nobody responded to (otherwise cancel it)',
      tags: tags.trainings,
      auth: 'admin',
      request: { params: IdParams },
      response: { status: 204, schema: null },
      errors: ['NOT_FOUND', 'CONFLICT'],
    },
    ({ req, params }) => trainings.remove(params.id, auditContextOf(req)),
  );

  // ── Series ───────────────────────────────────────────────────────────────

  api.route(
    {
      method: 'get',
      path: '/training-series',
      summary: 'Recurring trainings',
      tags: tags.series,
      auth: 'admin',
      response: { status: 200, schema: z.array(TrainingSeriesSchema) },
    },
    () => series.list(),
  );

  api.route(
    {
      method: 'post',
      path: '/training-series',
      summary: 'Create a weekly series; sessions are generated 12 weeks ahead (D7)',
      tags: tags.series,
      auth: 'admin',
      idempotencyKey: 'optional',
      middleware: [optionalKey],
      request: { body: CreateTrainingSeriesRequestSchema },
      response: { status: 201, schema: SeriesChangeResultSchema },
    },
    ({ req, body }) => series.create(body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'get',
      path: '/training-series/:id',
      summary: 'One series',
      tags: tags.series,
      auth: 'admin',
      request: { params: IdParams },
      response: { status: 200, schema: TrainingSeriesSchema },
      errors: ['NOT_FOUND'],
    },
    ({ params }) => series.get(params.id),
  );

  api.route(
    {
      method: 'patch',
      path: '/training-series/:id',
      summary: 'Edit a series and its future sessions; an earlier end removes or cancels sessions',
      tags: tags.series,
      auth: 'admin',
      request: { params: IdParams, body: UpdateTrainingSeriesRequestSchema },
      response: { status: 200, schema: SeriesChangeResultSchema },
      errors: ['NOT_FOUND'],
    },
    ({ req, params, body }) => series.update(params.id, body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'delete',
      path: '/training-series/:id',
      summary: 'End a series today: future sessions are removed, or cancelled if members responded',
      tags: tags.series,
      auth: 'admin',
      request: { params: IdParams },
      response: { status: 200, schema: SeriesChangeResultSchema.omit({ series: true }) },
      errors: ['NOT_FOUND'],
    },
    ({ req, params }) => series.remove(params.id, auditContextOf(req)),
  );

  // ── Reservations ─────────────────────────────────────────────────────────

  api.route(
    {
      method: 'get',
      path: '/trainings/:id/reservations',
      summary: 'Every member with their response (null = no response)',
      tags: tags.trainings,
      auth: 'admin',
      request: { params: IdParams },
      response: { status: 200, schema: z.array(AdminReservationRowSchema) },
      errors: ['NOT_FOUND'],
    },
    ({ params }) => trainings.listReservations(params.id),
  );

  api.route(
    {
      method: 'put',
      path: '/trainings/:id/reservations/:userId',
      summary: "Set a member's response (also after the deadline; beyond capacity with force)",
      tags: tags.trainings,
      auth: 'admin',
      request: { params: TrainingUserParams, body: AdminSetReservationRequestSchema },
      response: { status: 204, schema: null },
      errors: ['NOT_FOUND', 'TRAINING_FULL', 'TRAINING_CANCELLED', 'ATTENDANCE_FINALIZED'],
    },
    ({ req, params, body }) =>
      trainings.setReservation(params.id, params.userId, body, auditContextOf(req)),
  );

  // ── Pricing (D5) ─────────────────────────────────────────────────────────

  api.route(
    {
      method: 'get',
      path: '/trainings/:id/prices',
      summary: "Every member's final price for this training and its source",
      tags: tags.pricing,
      auth: 'admin',
      request: { params: IdParams },
      response: { status: 200, schema: z.array(TrainingPriceRowSchema) },
      errors: ['NOT_FOUND'],
    },
    ({ params }) => pricing.list(params.id),
  );

  api.route(
    {
      method: 'put',
      path: '/trainings/:id/price-overrides/:userId',
      summary: 'Set a price for one member for this training (0 = free)',
      tags: tags.pricing,
      auth: 'admin',
      request: { params: TrainingUserParams, body: PriceRequestSchema },
      response: { status: 204, schema: null },
      errors: ['NOT_FOUND'],
    },
    ({ req, params, body }) =>
      pricing.setOverride(params.id, params.userId, body.priceMinor, auditContextOf(req)),
  );

  api.route(
    {
      method: 'delete',
      path: '/trainings/:id/price-overrides/:userId',
      summary: 'Remove the per-training price for one member',
      tags: tags.pricing,
      auth: 'admin',
      request: { params: TrainingUserParams },
      response: { status: 204, schema: null },
      errors: ['NOT_FOUND'],
    },
    ({ req, params }) => pricing.setOverride(params.id, params.userId, null, auditContextOf(req)),
  );

  api.route(
    {
      method: 'get',
      path: '/users/:id/standing-price',
      summary: "A member's standing price (used for every training without an override)",
      tags: tags.pricing,
      auth: 'admin',
      request: { params: UserIdParamsSchema },
      response: { status: 200, schema: StandingPriceSchema },
      errors: ['NOT_FOUND'],
    },
    ({ params }) => pricing.getStanding(params.id),
  );

  api.route(
    {
      method: 'put',
      path: '/users/:id/standing-price',
      summary: "Set a member's standing price",
      tags: tags.pricing,
      auth: 'admin',
      request: { params: UserIdParamsSchema, body: PriceRequestSchema },
      response: { status: 200, schema: StandingPriceSchema },
      errors: ['NOT_FOUND'],
    },
    ({ req, params, body }) => pricing.setStanding(params.id, body.priceMinor, auditContextOf(req)),
  );

  api.route(
    {
      method: 'delete',
      path: '/users/:id/standing-price',
      summary: "Remove a member's standing price",
      tags: tags.pricing,
      auth: 'admin',
      request: { params: UserIdParamsSchema },
      response: { status: 200, schema: StandingPriceSchema },
      errors: ['NOT_FOUND'],
    },
    ({ req, params }) => pricing.setStanding(params.id, null, auditContextOf(req)),
  );

  // ── Attendance ───────────────────────────────────────────────────────────

  api.route(
    {
      method: 'get',
      path: '/trainings/:id/attendance',
      summary: 'Participants (reserved + walk-ins) with status, price and charge',
      tags: tags.attendance,
      auth: 'admin',
      request: { params: IdParams },
      response: { status: 200, schema: z.array(AttendanceRowSchema) },
      errors: ['NOT_FOUND'],
    },
    ({ params }) => attendance.list(params.id),
  );

  api.route(
    {
      method: 'put',
      path: '/trainings/:id/attendance',
      summary: 'Mark attendance in bulk before finalization; unknown members are added as walk-ins',
      tags: tags.attendance,
      auth: 'admin',
      request: { params: IdParams, body: BulkAttendanceRequestSchema },
      response: { status: 200, schema: z.array(AttendanceRowSchema) },
      errors: ['NOT_FOUND', 'TRAINING_CANCELLED', 'ATTENDANCE_FINALIZED', 'TRAINING_NOT_STARTED'],
    },
    ({ req, params, body }) => attendance.mark(params.id, body.entries, auditContextOf(req)),
  );

  api.route(
    {
      method: 'post',
      path: '/trainings/:id/attendance/finalize',
      summary: 'Charge every PRESENT participant at their price, atomically',
      description:
        'Refused with ATTENDANCE_HAS_PENDING while anyone is pending, unless `pendingAs: "ABSENT"` is given. Only PRESENT is charged.',
      tags: tags.attendance,
      auth: 'admin',
      idempotencyKey: 'required',
      middleware: [requireKey],
      request: { params: IdParams, body: FinalizeAttendanceRequestSchema },
      response: { status: 200, schema: FinalizeResultSchema },
      errors: [
        'NOT_FOUND',
        'TRAINING_CANCELLED',
        'ATTENDANCE_FINALIZED',
        'ATTENDANCE_HAS_PENDING',
        'TRAINING_NOT_STARTED',
        'IDEMPOTENCY_KEY_REUSED',
      ],
    },
    ({ req, params, body }) => attendance.finalize(params.id, body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'post',
      path: '/trainings/:id/attendance/:userId/correction',
      summary: 'Correct attendance after finalization: reverses or adds the charge (D11)',
      tags: tags.attendance,
      auth: 'admin',
      idempotencyKey: 'required',
      middleware: [requireKey],
      request: { params: TrainingUserParams, body: AttendanceCorrectionRequestSchema },
      response: { status: 200, schema: AttendanceCorrectionResultSchema },
      errors: ['NOT_FOUND', 'TRAINING_CANCELLED', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED'],
    },
    ({ req, params, body }) =>
      attendance.correct(params.id, params.userId, body, auditContextOf(req)),
  );

  api.route(
    {
      method: 'get',
      path: '/attendance/queue',
      summary: 'Past trainings still waiting for finalization, oldest first',
      tags: tags.attendance,
      auth: 'admin',
      response: { status: 200, schema: z.array(AttendanceQueueItemSchema) },
    },
    () => attendance.queue(),
  );

  api.offsetList(
    {
      method: 'get',
      path: '/users/:id/trainings',
      summary: "A member's trainings: response, attendance and charge",
      tags: tags.trainings,
      auth: 'admin',
      request: { params: UserIdParamsSchema, query: UserTrainingHistoryQuerySchema },
      item: TrainingHistoryItemSchema,
    },
    ({ params, query }) => trainings.history(params.id, query),
  );
}
