import { NextRequest, NextResponse } from 'next/server'
import { packRemoteRepo } from '@/lib/repomix'
import { createApiSuccess, createApiError, PackResult, RepoSelection, SliceConfig } from '@/lib/types'
import { GitHubClient } from '@/lib/github'
import { isServerMode } from '@/lib/prisma'
import { CACHE_CONFIG } from '@/lib/config'
import * as serverCache from '@/lib/db/packCache.server'

// Conditionally import auth only in server mode
const getAuth = async () => {
  if (isServerMode) {
    const { auth } = await import('@/lib/auth')
    return auth
  }
  return null
}

export const runtime = 'nodejs'
export const maxDuration = 300 // 5 minutes (adjust based on Vercel plan)

/**
 * Get GitHub token from session or header
 */
async function getGitHubToken(request: NextRequest): Promise<string | null> {
  // 1. Try session (logged-in user with OAuth)
  const auth = await getAuth()
  if (auth) {
    try {
      const session = await auth()
      if (session?.accessToken) {
        console.log('[api/pack] Using GitHub token from session')
        return session.accessToken
      }
    } catch {
      // Auth not available, continue to header
    }
  }

  // 2. Try header (manual entry)
  const headerToken = request.headers.get('x-github-token')
  if (headerToken) {
    console.log('[api/pack] Using GitHub token from header')
    return headerToken
  }

  // 3. Try env fallback
  if (process.env.GITHUB_TOKEN) {
    console.log('[api/pack] Using GitHub token from env')
    return process.env.GITHUB_TOKEN
  }

  return null
}

/**
 * POST /api/pack
 * Pack multiple repositories with Repomix
 *
 * Features:
 * - Shared cache for public repos (Postgres, if DATABASE_URL set)
 * - Uses OAuth token when logged in, falls back to header/env
 */
export async function POST(request: NextRequest) {
  try {
    // Check if request is already aborted
    if (request.signal.aborted) {
      console.log('[api/pack] Request aborted before start')
      return new NextResponse(null, { status: 499 }) // Client closed request
    }

    const body = await request.json()
    const {
      repos,
      sliceConfig,
    }: {
      repos: RepoSelection[]
      sliceConfig: SliceConfig
    } = body

    // Validation
    if (!repos || !Array.isArray(repos) || repos.length === 0) {
      return NextResponse.json(
        createApiError('At least one repo required', 'MISSING_REPOS'),
        { status: 400 }
      )
    }

    const githubToken = await getGitHubToken(request)

    if (!githubToken) {
      return NextResponse.json(
        createApiError('GitHub token required. Sign in or provide token.', 'MISSING_TOKEN'),
        { status: 401 }
      )
    }

    console.log(`[api/pack] Packing ${repos.length} repos:`, repos.map(r => r.fullName).join(', '))

    // Check abort before expensive operation
    if (request.signal.aborted) {
      console.log('[api/pack] Request aborted before packing')
      return new NextResponse(null, { status: 499 })
    }

    // Create GitHub client to fetch SHAs
    const github = new GitHubClient(githubToken)

    // Whitelisted orgs for shared Postgres cache
    const sharedCacheOrgs = new Set(
      CACHE_CONFIG.sharedCacheOrgs.map(o => o.toLowerCase())
    )

    // Pack all repos with caching
    const packPromises = repos.map(async (repo) => {
      const branch = repo.branch || 'main'
      try {
        // Get current SHA for cache lookup
        const currentSHA = await github.fetchCurrentCommitSHA(repo.fullName, branch)

        // Check if repo belongs to a whitelisted org for shared cache
        // Personal repos still use browser IndexedDB, just not shared Postgres
        const repoOwner = repo.fullName.split('/')[0].toLowerCase()
        const useSharedCache = sharedCacheOrgs.has(repoOwner)

        // Check shared cache (Postgres) for whitelisted org repos only
        if (isServerMode && useSharedCache) {
          const cacheResult = await serverCache.lookupCache(
            repo.fullName,
            branch,
            currentSHA,
            sliceConfig
          )

          if (cacheResult.status === 'fresh' && cacheResult.cached) {
            console.log(`[api/pack] Cache HIT for ${repo.fullName}:${branch}`)
            return {
              repo: repo.fullName,
              branch,
              output: cacheResult.cached.packedOutput,
              stats: cacheResult.cached.stats,
              cached: true,
            }
          }

          // Stale cache - could use but we'll refresh
          if (cacheResult.status === 'stale' && cacheResult.cached) {
            console.log(`[api/pack] Cache STALE for ${repo.fullName}:${branch} (${cacheResult.daysBehind} days)`)
            // Continue to pack fresh version
          }
        }

        // Pack via Repomix
        const packed = await packRemoteRepo({
          repo: repo.fullName,
          branch,
          githubToken,
          ...sliceConfig,
        }, request.signal)

        // Store in shared cache for whitelisted org repos only
        if (isServerMode && useSharedCache && !packed.error) {
          await serverCache.storeInCache(
            repo.fullName,
            branch,
            currentSHA,
            sliceConfig,
            packed.output,
            packed.stats
          )
          console.log(`[api/pack] Cached ${repo.fullName}:${branch} in Postgres`)
        } else if (!useSharedCache) {
          console.log(`[api/pack] ${repo.fullName} not in shared cache orgs, using browser cache only`)
        }

        return {
          ...packed,
          cached: false,
        }
      } catch (error) {
        console.error(`[api/pack] Error packing ${repo.fullName}:`, error)
        return {
          repo: repo.fullName,
          branch,
          output: '',
          stats: { fileCount: 0, approxChars: 0, approxTokens: 0 },
          error: error instanceof Error ? error.message : 'Unknown error',
          cached: false,
        }
      }
    })

    const packedRepos = await Promise.all(packPromises)

    // Check abort before assembling
    if (request.signal.aborted) {
      console.log('[api/pack] Request aborted after packing')
      return new NextResponse(null, { status: 499 })
    }

    // Collect errors
    const errors = packedRepos
      .filter(r => r.error)
      .map(r => `${r.repo}: ${r.error}`)

    // Calculate aggregate stats from successful repos
    const successfulRepos = packedRepos.filter(r => !r.error)
    const totalStats = successfulRepos.reduce(
      (acc, repo) => ({
        fileCount: acc.fileCount + repo.stats.fileCount,
        approxChars: acc.approxChars + repo.stats.approxChars,
        approxTokens: acc.approxTokens + repo.stats.approxTokens,
      }),
      { fileCount: 0, approxChars: 0, approxTokens: 0 }
    )

    // Log cache stats
    const cachedCount = packedRepos.filter(r => r.cached).length
    if (cachedCount > 0) {
      console.log(`[api/pack] ${cachedCount}/${repos.length} repos served from cache`)
    }

    const result: PackResult = {
      repos: packedRepos,
      totalStats,
      errors,
    }

    return NextResponse.json(createApiSuccess(result))
  } catch (error) {
    console.error('[api/pack] Error:', error)

    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      createApiError(message, 'PACK_ERROR'),
      { status: 500 }
    )
  }
}
