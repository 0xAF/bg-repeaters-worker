import { z } from '@hono/zod-openapi'


const ErrorSchema = z.object({
  failure: z
    .boolean()
    .openapi({
      description: "Indicates Operation Failure",
      example: true,
    }),
  errors: z
    .object({})
    .openapi({
      description: "The errors",
      example: { "SQL": "Error in SQL" }
    }),
  code: z
    .number()
    .optional()
    .openapi({
      description: "HTTP code",
      example: 422
    })
}).openapi('Error')

export { ErrorSchema }