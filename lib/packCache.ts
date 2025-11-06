/**
 * Pack Cache Layer
 * Intelligent caching of packed repo outputs in IndexedDB
 */

import { openDB, type IDBPDatabase } from 'idb'
import type { CachedPack, CacheLookupResult, CacheStats, SliceConfig } from './types'
import { CACHE_CONFIG } from './config'

let dbInstance: IDBPDatabase | null = null

/**
 * FNV-1a hash function (browser-safe, deterministic)
 * Used for config hashing in cache keys
 */
function fnv1aHash(str: string): string {
  let hash = 2166136261 // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  // Convert to unsigned 32-bit, then to base36 for compact string
  return (hash >>> 0).toString(36)
}

/**
 * Initialize IndexedDB for pack caching
 */
export async function initPackCache(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance

  try {
    dbInstance = await openDB(CACHE_CONFIG.dbName, CACHE_CONFIG.dbVersion, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(CACHE_CONFIG.storeName)) {
          const store = db.createObjectStore(CACHE_CONFIG.storeName, { keyPath: 'key' })
          store.createIndex('byRepo', 'repoFullName')
          store.createIndex('byLastAccessed', 'lastAccessedAt')
          store.createIndex('byCachedAt', 'cachedAt')
        }
      },
    })
    return dbInstance
  } catch (error) {
    console.error('Failed to initialize pack cache:', error)
    throw error
  }
}

/**
 * Build deterministic cache key
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
 * Hash slice config for cache key
 * Uses FNV-1a hash (deterministic, browser-safe)
 */
export function hashSliceConfig(config: SliceConfig): string {
  // Normalize config for deterministic hashing
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

  const json = JSON.stringify(normalized)
  return fnv1aHash(json)
}

/**
 * Look up cache entry
 * Returns fresh hit, stale hit with metadata, or miss
 */
export async function lookupCache(
  repo: string,
  branch: string,
  currentSHA: string,
  sliceConfig: SliceConfig
): Promise<CacheLookupResult> {
  try {
    const db = await initPackCache()
    const configHash = hashSliceConfig(sliceConfig)

    // Try exact match (fresh hit)
    const exactKey = buildCacheKey(repo, branch, currentSHA, sliceConfig)
    const exactMatch = await db.get(CACHE_CONFIG.storeName, exactKey)

    if (exactMatch) {
      // Update last accessed time for LRU
      exactMatch.lastAccessedAt = Date.now()
      await db.put(CACHE_CONFIG.storeName, exactMatch)

      return {
        status: 'fresh',
        cached: exactMatch,
        currentSHA,
      }
    }

    // Try finding stale version (different SHA, same repo+branch+config)
    const allEntries = await db.getAllFromIndex(CACHE_CONFIG.storeName, 'byRepo', repo)
    const staleMatches = allEntries
      .filter((entry) => entry.branch === branch && entry.sliceConfigHash === configHash)
      .sort((a, b) => b.cachedAt - a.cachedAt) // Most recent first

    if (staleMatches.length > 0) {
      const stale = staleMatches[0]

      // Calculate staleness
      const ageMs = Date.now() - stale.cachedAt
      const daysBehind = Math.floor(ageMs / (1000 * 60 * 60 * 24))

      // Update last accessed time
      stale.lastAccessedAt = Date.now()
      await db.put(CACHE_CONFIG.storeName, stale)

      return {
        status: 'stale',
        cached: stale,
        currentSHA,
        daysBehind,
        // commitsBehind will be filled in by caller (requires GitHub API)
      }
    }

    // Cache miss
    return {
      status: 'miss',
      currentSHA,
    }
  } catch (error) {
    console.error('Cache lookup failed, returning miss:', error)
    return {
      status: 'miss',
      currentSHA,
    }
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
  geminiTokens?: number
): Promise<void> {
  try {
    const db = await initPackCache()
    const key = buildCacheKey(repo, branch, commitSHA, sliceConfig)
    const sizeBytes = new Blob([packedOutput]).size

    // Check if entry exceeds max size
    if (sizeBytes > CACHE_CONFIG.maxEntrySize) {
      console.warn(`Cache entry too large (${(sizeBytes / 1024 / 1024).toFixed(1)}MB), skipping cache`)
      return
    }

    // Check storage quota and purge if needed
    const totalSize = await getTotalCacheSize()
    if (totalSize + sizeBytes > CACHE_CONFIG.maxTotalSize) {
      await purgeLRU(sizeBytes)
    }

    const entry: CachedPack & { key: string } = {
      key,
      repoFullName: repo,
      branch,
      commitSHA,
      sliceConfigHash: hashSliceConfig(sliceConfig),
      packedOutput,
      stats,
      geminiTokens,
      cachedAt: Date.now(),
      lastAccessedAt: Date.now(),
      sizeBytes,
    }

    await db.put(CACHE_CONFIG.storeName, entry)

    // Verify the write succeeded
    const verify = await db.get(CACHE_CONFIG.storeName, key)
    if (!verify) {
      console.error(`Cache write failed verification for ${repo}:${branch}`)
      return
    }

    console.log(`Cached pack for ${repo}:${branch} (${(sizeBytes / 1024).toFixed(1)}KB)`)
  } catch (error) {
    console.error('Failed to store in cache:', error)
    // Non-blocking: cache failure doesn't fail the pack operation
  }
}

/**
 * Get total cache size in bytes
 */
export async function getTotalCacheSize(): Promise<number> {
  try {
    const db = await initPackCache()
    const allEntries = await db.getAll(CACHE_CONFIG.storeName)
    return allEntries.reduce((sum, entry) => sum + (entry.sizeBytes || 0), 0)
  } catch (error) {
    console.error('Failed to get cache size:', error)
    return 0
  }
}

/**
 * Purge least recently used entries to make room
 */
export async function purgeLRU(bytesNeeded: number): Promise<void> {
  try {
    const db = await initPackCache()
    const allEntries = await db.getAllFromIndex(CACHE_CONFIG.storeName, 'byLastAccessed')
    let freedBytes = 0

    console.log(`Purging LRU cache entries to free ${(bytesNeeded / 1024 / 1024).toFixed(1)}MB...`)

    for (const entry of allEntries) {
      if (freedBytes >= bytesNeeded) break
      await db.delete(CACHE_CONFIG.storeName, entry.key)
      freedBytes += entry.sizeBytes || 0
      console.log(`  Purged ${entry.repoFullName}:${entry.branch} (${(entry.sizeBytes / 1024).toFixed(1)}KB)`)
    }

    console.log(`Freed ${(freedBytes / 1024 / 1024).toFixed(1)}MB from cache`)
  } catch (error) {
    console.error('Failed to purge LRU cache:', error)
  }
}

/**
 * Clear all cache entries
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await initPackCache()
    await db.clear(CACHE_CONFIG.storeName)
    console.log('Cache cleared')
  } catch (error) {
    console.error('Failed to clear cache:', error)
    throw error
  }
}

/**
 * Clear cache entry for specific repo
 */
export async function clearCacheEntry(
  repo: string,
  branch: string,
  commitSHA: string,
  sliceConfig: SliceConfig
): Promise<void> {
  try {
    const db = await initPackCache()
    const key = buildCacheKey(repo, branch, commitSHA, sliceConfig)
    await db.delete(CACHE_CONFIG.storeName, key)
    console.log(`Cleared cache for ${repo}:${branch}`)
  } catch (error) {
    console.error('Failed to clear cache entry:', error)
    throw error
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<CacheStats> {
  try {
    const db = await initPackCache()
    const allEntries = await db.getAll(CACHE_CONFIG.storeName)

    const totalSizeBytes = allEntries.reduce((sum, entry) => sum + (entry.sizeBytes || 0), 0)

    return {
      entryCount: allEntries.length,
      totalSizeBytes,
      totalSizeMB: parseFloat((totalSizeBytes / 1024 / 1024).toFixed(2)),
      entries: allEntries.map((entry) => ({
        repoFullName: entry.repoFullName,
        branch: entry.branch,
        commitSHA: entry.commitSHA,
        cachedAt: entry.cachedAt,
        sizeBytes: entry.sizeBytes,
        isCurrent: false, // Will be updated by caller with GitHub API check
      })),
    }
  } catch (error) {
    console.error('Failed to get cache stats:', error)
    return {
      entryCount: 0,
      totalSizeBytes: 0,
      totalSizeMB: 0,
      entries: [],
    }
  }
}

/**
 * Purge stale cache entries (not accessed in N days)
 */
export async function purgeStaleEntries(): Promise<number> {
  try {
    const db = await initPackCache()
    const allEntries = await db.getAll(CACHE_CONFIG.storeName)
    const cutoffTime = Date.now() - CACHE_CONFIG.purgeIfNotAccessedDays * 24 * 60 * 60 * 1000

    let purgedCount = 0
    for (const entry of allEntries) {
      if (entry.lastAccessedAt < cutoffTime) {
        await db.delete(CACHE_CONFIG.storeName, entry.key)
        purgedCount++
      }
    }

    if (purgedCount > 0) {
      console.log(`Purged ${purgedCount} stale cache entries (not accessed in ${CACHE_CONFIG.purgeIfNotAccessedDays} days)`)
    }

    return purgedCount
  } catch (error) {
    console.error('Failed to purge stale entries:', error)
    return 0
  }
}
