/**
 * Prisma Client Singleton
 *
 * Uses @prisma/adapter-pg for connection pooling with Neon.tech.
 * Only initialized if DATABASE_URL is set (server mode).
 *
 * In development, we cache the client on globalThis to avoid
 * exhausting connections during hot reloads.
 */

import { PrismaClient } from '@/src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

// Check if we're in server mode (DATABASE_URL is set)
const hasDatabase = !!process.env.DATABASE_URL

// Global cache for dev mode (avoids connection exhaustion on hot reload)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  pool: pg.Pool | undefined
}

// Only create pool and client if DATABASE_URL is configured
let prismaClient: PrismaClient | null = null

if (hasDatabase) {
  // Create connection pool (reuse in dev)
  const pool =
    globalForPrisma.pool ??
    new pg.Pool({
      connectionString: process.env.DATABASE_URL,
    })

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.pool = pool
  }

  // Create Prisma adapter
  const adapter = new PrismaPg(pool)

  // Initialize Prisma Client with adapter
  prismaClient = globalForPrisma.prisma ?? new PrismaClient({ adapter })

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prismaClient
  }
}

/**
 * Prisma client instance.
 * null if DATABASE_URL is not set (client-only mode).
 */
export const prisma = prismaClient

/**
 * Check if database is available
 */
export const isServerMode = hasDatabase
