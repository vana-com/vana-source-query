/**
 * Client-side Pack Cache Utilities
 * Browser-only utilities for caching packed repos in IndexedDB
 */

'use client'

import {
  lookupCache,
  storeInCache,
  getCacheStats,
  clearCache as clearCacheDB,
} from './packCache'
import type { SliceConfig, PackResult, PackedRepo, CacheStats, CacheLookupResult } from './types'

/**
 * Fetch current commit SHAs for repos from GitHub API
 */
export async function fetchRepoSHAs(
  repos: Array<{ fullName: string; branch: string }>,
  githubToken?: string
): Promise<Record<string, { sha: string; branch: string }>> {
  if (typeof window === 'undefined') return {}

  try {
    const res = await fetch('/api/sha', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(githubToken && { 'x-github-token': githubToken }),
      },
      body: JSON.stringify({ repos }),
    })

    const json = await res.json()

    if (!json.success) {
      throw new Error(json.error)
    }

    return json.data.shas
  } catch (error) {
    console.error('Failed to fetch SHAs:', error)
    return {}
  }
}

/**
 * Check cache for all repos with current SHAs
 * Returns cached result if ALL repos have fresh cache hits
 * Otherwise returns partial info about cache status
 */
export async function checkPackCache(
  repos: Array<{ fullName: string; branch: string }>,
  sliceConfig: SliceConfig,
  currentSHAs: Record<string, { sha: string; branch: string }>
): Promise<{
  result: PackResult | null
  cacheStatus: 'all-fresh' | 'some-stale' | 'all-miss'
  lookupResults: Record<string, CacheLookupResult>
}> {
  if (typeof window === 'undefined') {
    return { result: null, cacheStatus: 'all-miss', lookupResults: {} }
  }

  try {
    const lookupResults: Record<string, CacheLookupResult> = {}
    const cachedRepos: PackedRepo[] = []

    let freshCount = 0
    let staleCount = 0
    let missCount = 0

    // Check cache for each repo
    for (const repo of repos) {
      const shaInfo = currentSHAs[repo.fullName]
      if (!shaInfo) {
        missCount++
        continue
      }

      const lookupResult = await lookupCache(
        repo.fullName,
        repo.branch,
        shaInfo.sha,
        sliceConfig
      )

      lookupResults[repo.fullName] = lookupResult

      if (lookupResult.status === 'fresh' && lookupResult.cached) {
        freshCount++
        // Convert cached pack to PackedRepo format
        cachedRepos.push({
          repo: lookupResult.cached.repoFullName,
          branch: lookupResult.cached.branch,
          output: lookupResult.cached.packedOutput,
          stats: lookupResult.cached.stats,
        })
      } else if (lookupResult.status === 'stale') {
        staleCount++
      } else {
        missCount++
      }
    }

    // Determine overall cache status
    let cacheStatus: 'all-fresh' | 'some-stale' | 'all-miss'
    if (freshCount === repos.length) {
      cacheStatus = 'all-fresh'
    } else if (freshCount > 0 || staleCount > 0) {
      cacheStatus = 'some-stale'
    } else {
      cacheStatus = 'all-miss'
    }

    // If all repos are fresh, return assembled result
    if (cacheStatus === 'all-fresh') {
      const totalStats = cachedRepos.reduce(
        (acc, repo) => ({
          fileCount: acc.fileCount + repo.stats.fileCount,
          approxChars: acc.approxChars + repo.stats.approxChars,
          approxTokens: acc.approxTokens + repo.stats.approxTokens,
        }),
        { fileCount: 0, approxChars: 0, approxTokens: 0 }
      )

      return {
        result: {
          repos: cachedRepos,
          totalStats,
          errors: [],
        },
        cacheStatus,
        lookupResults,
      }
    }

    // Partial or no cache - return null result (will trigger fresh pack)
    return {
      result: null,
      cacheStatus,
      lookupResults,
    }
  } catch (error) {
    console.error('Cache check failed:', error)
    return { result: null, cacheStatus: 'all-miss', lookupResults: {} }
  }
}

/**
 * Store pack result in cache after successful pack
 */
export async function storePackResult(
  repos: Array<{ fullName: string; branch: string }>,
  sliceConfig: SliceConfig,
  packResult: PackResult,
  currentSHAs: Record<string, { sha: string; branch: string }>
): Promise<void> {
  if (typeof window === 'undefined') return // Server-side bail out

  try {
    // Store each successful repo in cache
    for (const packedRepo of packResult.repos) {
      if (packedRepo.error) continue // Skip failed repos

      const shaInfo = currentSHAs[packedRepo.repo]
      if (!shaInfo) {
        console.warn(`No SHA available for ${packedRepo.repo}, skipping cache`)
        continue
      }

      await storeInCache(
        packedRepo.repo,
        packedRepo.branch,
        shaInfo.sha,
        sliceConfig,
        packedRepo.output,
        packedRepo.stats
      )
    }

    console.log(`Cached ${packResult.repos.filter(r => !r.error).length} repos`)
  } catch (error) {
    console.error('Failed to store pack result in cache:', error)
    // Non-blocking: don't throw
  }
}

/**
 * Get cache statistics for UI display
 */
export async function getPackCacheStats(): Promise<CacheStats> {
  if (typeof window === 'undefined') {
    return { entryCount: 0, totalSizeBytes: 0, totalSizeMB: 0, entries: [] }
  }

  try {
    return await getCacheStats()
  } catch (error) {
    console.error('Failed to get cache stats:', error)
    return { entryCount: 0, totalSizeBytes: 0, totalSizeMB: 0, entries: [] }
  }
}

/**
 * Clear all cached packs
 */
export async function clearPackCache(): Promise<void> {
  if (typeof window === 'undefined') return

  try {
    await clearCacheDB()
  } catch (error) {
    console.error('Failed to clear cache:', error)
    throw error
  }
}
