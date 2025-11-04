import { z } from '@hono/zod-openapi'

const ChangelogEntrySchema = z.object({
  date: z.string().datetime().openapi({ description: 'Change date (ISO-8601)' }),
  who: z.string().openapi({ description: 'Who made the change', example: 'LZ2SLL' }),
  info: z.string().openapi({ description: 'Change description', example: 'Update LZ0BOT tone' }),
}).openapi('ChangelogEntrySchema')

const ChangelogResponseSchema = z.object({
  lastChanged: z.string().datetime().nullable().openapi({ description: 'Most recent change date (ISO-8601) or null if none' }),
  changes: z.array(ChangelogEntrySchema).openapi({ description: 'Changelog entries ordered by date desc' })
}).openapi('ChangelogResponse')

export { ChangelogEntrySchema, ChangelogResponseSchema }
