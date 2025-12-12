import type { PrismaConfig } from 'prisma'

/**
 * Prisma CLI configuration
 *
 * Uses DIRECT_DATABASE_URL for migrations to bypass PgBouncer connection pooler.
 * PgBouncer doesn't support advisory locks which Prisma Migrate needs.
 *
 * Falls back to DATABASE_URL for local development (usually no pooler).
 */
export default {
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '',
  },
} satisfies PrismaConfig
