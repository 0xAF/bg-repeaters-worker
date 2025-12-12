import { z } from '@hono/zod-openapi'
import { RepeaterSchema } from './RepeaterSchema'

export const RequestStatusEnum = z
  .enum(['pending', 'approved', 'rejected', 'archived'])
  .openapi('GuestRequestStatus')

const RepeaterSuggestionSchema = RepeaterSchema.partial().openapi('RepeaterSuggestion')

export const RequestSubmissionSchema = z
  .object({
    name: z.string().min(2).max(200),
    contact: z.string().min(3).max(320),
    message: z.string().min(5).max(4000).optional(),
    repeater: RepeaterSuggestionSchema.optional(),
    turnstileToken: z.string().min(1).max(10000),
  })
  .openapi('GuestRequestSubmission')

export const RequestPayloadSchema = z
  .object({
    message: z.string().optional(),
    repeater: RepeaterSuggestionSchema.optional(),
  })
  .passthrough()
  .optional()
  .openapi('GuestRequestPayload')

export const RequestRecordSchema = z
  .object({
    id: z.number().int().nonnegative(),
    status: RequestStatusEnum,
    name: z.string(),
    contact: z.string(),
    payload: RequestPayloadSchema,
    ip: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
    cfRay: z.string().nullable().optional(),
    cfCountry: z.string().nullable().optional(),
    adminNotes: z.string().nullable().optional(),
    resolvedAt: z.string().nullable().optional(),
    resolvedBy: z.string().nullable().optional(),
    created: z.string(),
    updated: z.string(),
  })
  .openapi('GuestRequestRecord')

export const RequestSubmissionResponseSchema = z
  .object({
    id: z.number().int().nonnegative(),
    status: RequestStatusEnum,
    rateLimit: z.object({
      limit: z.number().int().positive(),
      remaining: z.number().int().min(0),
      windowMinutes: z.number().int().positive(),
    }),
  })
  .openapi('GuestRequestSubmissionResponse')

export const RequestListQuerySchema = z
  .object({
    status: RequestStatusEnum.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().min(1).optional(),
  })
  .openapi('AdminRequestListQuery')

export const RequestListResponseSchema = z
  .object({
    requests: z.array(RequestRecordSchema),
    nextCursor: z.number().int().min(1).optional().nullable(),
  })
  .openapi('AdminRequestListResponse')

export const RequestIdParamSchema = z
  .object({
    id: z
      .string()
      .regex(/^[0-9]+$/)
      .transform((val) => Number(val)),
  })
  .openapi('RequestIdParam')

export const RequestUpdateSchema = z
  .object({
    status: RequestStatusEnum.optional(),
    adminNotes: z.string().max(4000).optional(),
  })
  .refine((data) => data.status !== undefined || data.adminNotes !== undefined, {
    message: 'Provide at least one field to update.',
    path: ['status'],
  })
  .openapi('AdminRequestUpdate')
