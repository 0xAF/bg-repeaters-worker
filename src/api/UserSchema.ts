import { z } from '@hono/zod-openapi'

// Path params
export const UserRequestSchema = z.object({
  // Allow letters, numbers, underscore, dash and dot to reduce friction
  username: z.string().min(3).regex(/^[A-Za-z0-9._-]+$/).openapi({ example: 'admin' })
}).openapi('UserRequest')

export const UserCreateSchema = z.object({
  username: z.string().min(3).regex(/^[A-Za-z0-9._-]+$/).openapi({ description: 'Unique username (letters, numbers, underscore, dash, dot).', example: 'alice' }),
  password: z.string().min(6).openapi({ description: 'Plain password (will be hashed server-side).', example: 'S3cr3t!' }),
  // Coerce common inputs like 1/0, "true"/"false" to boolean
  enabled: z.coerce.boolean().optional().openapi({ description: 'If omitted defaults to true.' })
}).openapi('UserCreate')

export const UserUpdateSchema = z.object({
  password: z.string().min(6).optional().openapi({ description: 'New password (rehash).', example: 'N3wP@ss!' }),
  enabled: z.coerce.boolean().optional().openapi({ description: 'Enable/disable account.' })
}).openapi('UserUpdate')

export const UserResponseSchema = z.object({
  username: z.string().openapi({ example: 'ALICE' }),
  enabled: z.boolean().openapi({ example: true }),
  created: z.string().optional().openapi({ example: '2025-11-10T00:00:00Z' }),
  updated: z.string().optional().openapi({ example: '2025-11-10T00:00:00Z' })
}).openapi('User')

export const UsersListSchema = z.array(UserResponseSchema).openapi('UsersList')
