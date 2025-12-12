/**
 * Server-side Pack Cache (Postgres)
 *
 * Shared cache across all users for public repos.
 * Same repo + branch + SHA + configHash = same output (deterministic).
 */

import { prisma } from '../prisma'
import type { CachedPack, CacheLookupResult, CacheStats, SliceConfig } from '../types'
import { CACHE_CONFIG } from '../config'

/**
 * FNV-1a hash function (deterministic, same as client-side)
 */
function fnv1aHash(str: string): string {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Hash slice config for cache key (same as client-side)
 */
export function hashSliceConfig(config: SliceConfig): string {
  const normalized = {
    includeGlobs: [...(config.includeGlobs || [])].sort(),
    ignoreGlobs: [...(config.ignoreGlobs || [])].sort(),
    respectGitignore: config.respectGitignore ?? true,
    respectAiIgnore: config.respectAiIgnore ?? true,
    useDefaultPatterns: config.useDefaultPatterns ?? true,
    reducers: {
      compress: config.reducers?.compress ?? false,
      removeComments: config.reducers?.removeComments ?? false,
      removeEmptyLines: config.reducers?.removeEmptyLines ?? false,
      truncateBase64: config.reducers?.truncateBase64 ?? false,
    },
  }
  return fnv1aHash(JSON.stringify(normalized))
}

/**
 * Build cache key
 */
export function buildCacheKey(
  repo: string,
  branch: string,
  commitSHA: string,
  sliceConfig: SliceConfig
): string {
  const configHash = hashSliceConfig(sliceConfig)
  return `${repo}:${branch}:${commitSHA}:${configHash}`
}

/**
 * Look up cache entry (shared across all users)
 * Cache is deterministic: same repo + branch + SHA + config = same output
 */
export async function lookupCache(
  repo: string,
  branch: string,
  currentSHA: string,
  sliceConfig: SliceConfig
): Promise<CacheLookupResult> {
  if (!prisma) {
    return { status: 'miss', currentSHA }
  }

  try {
    const configHash = hashSliceConfig(sliceConfig)
    const exactKey = buildCacheKey(repo, branch, currentSHA, sliceConfig)

    // Try exact match first
    const exactMatch = await prisma.packCache.findUnique({
      where: { key: exactKey },
    })

    if (exactMatch) {
      // Update last accessed time
      await prisma.packCache.update({
        where: { key: exactKey },
        data: { lastAccessedAt: new Date() },
      })

      return {
        status: 'fresh',
        cached: dbToCachedPack(exactMatch),
        currentSHA,
      }
    }

    // Try finding stale version (different SHA, same repo+branch+config)
    const staleMatch = await prisma.packCache.findFirst({
      where: {
        repoFullName: repo,
        branch,
        sliceConfigHash: configHash,
      },
      orderBy: { cachedAt: 'desc' },
    })

    if (staleMatch) {
      const ageMs = Date.now() - staleMatch.cachedAt.getTime()
      const daysBehind = Math.floor(ageMs / (1000 * 60 * 60 * 24))

      // Update last accessed
      await prisma.packCache.update({
        where: { key: staleMatch.key },
        data: { lastAccessedAt: new Date() },
      })

      return {
        status: 'stale',
        cached: dbToCachedPack(staleMatch),
        currentSHA,
        daysBehind,
      }
    }

    return { status: 'miss', currentSHA }
  } catch (error) {
    console.error('[packCache.server] Lookup failed:', error)
    return { status: 'miss', currentSHA }
  }
}

/**
 * Store packed output in cache
 */
export async function storeInCache(
  repo: string,
  branch: string,
  commitSHA: string,
  sliceConfig: SliceConfig,
  packedOutput: string,
  stats: { fileCount: number; approxChars: number; approxTokens: number },
  isPublic: boolean = true,
  geminiTokens?: number
): Promise<void> {
  if (!prisma) {
    console.warn('[packCache.server] No database connection, skipping cache store')
    return
  }

  try {
    const key = buildCacheKey(repo, branch, commitSHA, sliceConfig)
    const sizeBytes = Buffer.byteLength(packedOutput, 'utf8')

    // Skip if too large
    if (sizeBytes > CACHE_CONFIG.maxEntrySize) {
      console.warn(
        `[packCache.server] Entry too large (${(sizeBytes / 1024 / 1024).toFixed(1)}MB), skipping`
      )
      return
    }

    // Upsert (handles race conditions)
    await prisma.packCache.upsert({
      where: { key },
      create: {
        key,
        repoFullName: repo,
        branch,
        commitSha: commitSHA,
        sliceConfigHash: hashSliceConfig(sliceConfig),
        packedOutput,
        stats,
        geminiTokens,
        sizeBytes,
        isPublic,
      },
      update: {
        packedOutput,
        stats,
        geminiTokens,
        sizeBytes,
        lastAccessedAt: new Date(),
      },
    })

    console.log(
      `[packCache.server] Cached ${repo}:${branch} (${(sizeBytes / 1024).toFixed(1)}KB, public=${isPublic})`
    )
  } catch (error) {
    console.error('[packCache.server] Store failed:', error)
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<CacheStats> {
  if (!prisma) {
    return { entryCount: 0, totalSizeBytes: 0, totalSizeMB: 0, entries: [] }
  }

  try {
    const entries = await prisma.packCache.findMany({
      select: {
        repoFullName: true,
        branch: true,
        commitSha: true,
        cachedAt: true,
        sizeBytes: true,
      },
      orderBy: { cachedAt: 'desc' },
    })

    const totalSizeBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0)

    return {
      entryCount: entries.length,
      totalSizeBytes,
      totalSizeMB: parseFloat((totalSizeBytes / 1024 / 1024).toFixed(2)),
      entries: entries.map((e) => ({
        repoFullName: e.repoFullName,
        branch: e.branch,
        commitSHA: e.commitSha,
        cachedAt: e.cachedAt.getTime(),
        sizeBytes: e.sizeBytes,
        isCurrent: false, // Caller can update this with GitHub API
      })),
    }
  } catch (error) {
    console.error('[packCache.server] getCacheStats failed:', error)
    return { entryCount: 0, totalSizeBytes: 0, totalSizeMB: 0, entries: [] }
  }
}

/**
 * Clear all cache entries (admin only)
 */
export async function clearCache(): Promise<void> {
  if (!prisma) return

  try {
    await prisma.packCache.deleteMany()
    console.log('[packCache.server] Cache cleared')
  } catch (error) {
    console.error('[packCache.server] Clear failed:', error)
  }
}

/**
 * Purge LRU entries to free space
 */
export async function purgeLRU(bytesNeeded: number): Promise<void> {
  if (!prisma) return

  try {
    const entries = await prisma.packCache.findMany({
      orderBy: { lastAccessedAt: 'asc' },
      select: { key: true, sizeBytes: true },
    })

    let freedBytes = 0
    const keysToDelete: string[] = []

    for (const entry of entries) {
      if (freedBytes >= bytesNeeded) break
      keysToDelete.push(entry.key)
      freedBytes += entry.sizeBytes
    }

    if (keysToDelete.length > 0) {
      await prisma.packCache.deleteMany({
        where: { key: { in: keysToDelete } },
      })
      console.log(
        `[packCache.server] Purged ${keysToDelete.length} entries, freed ${(freedBytes / 1024 / 1024).toFixed(1)}MB`
      )
    }
  } catch (error) {
    console.error('[packCache.server] PurgeLRU failed:', error)
  }
}

/**
 * Convert database record to CachedPack type
 */
function dbToCachedPack(record: {
  repoFullName: string
  branch: string
  commitSha: string
  sliceConfigHash: string
  packedOutput: string
  stats: unknown
  geminiTokens: number | null
  cachedAt: Date
  lastAccessedAt: Date
  sizeBytes: number
}): CachedPack {
  const stats = record.stats as { fileCount: number; approxChars: number; approxTokens: number }
  return {
    repoFullName: record.repoFullName,
    branch: record.branch,
    commitSHA: record.commitSha,
    sliceConfigHash: record.sliceConfigHash,
    packedOutput: record.packedOutput,
    stats,
    geminiTokens: record.geminiTokens ?? undefined,
    cachedAt: record.cachedAt.getTime(),
    lastAccessedAt: record.lastAccessedAt.getTime(),
    sizeBytes: record.sizeBytes,
  }
}
