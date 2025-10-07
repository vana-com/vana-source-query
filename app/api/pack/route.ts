import { NextRequest, NextResponse } from 'next/server'
import { packRemoteRepo, assemblePackedContext } from '@/lib/repomix'
import { createApiSuccess, createApiError, PackResult, RepoSelection, SliceConfig } from '@/lib/types'

export const runtime = 'nodejs'
export const maxDuration = 300 // 5 minutes (adjust based on Vercel plan)

/**
 * POST /api/pack
 * Pack multiple repositories with Repomix
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
      userPrompt,
    }: {
      repos: RepoSelection[]
      sliceConfig: SliceConfig
      userPrompt?: string
    } = body

    // Validation
    if (!repos || !Array.isArray(repos) || repos.length === 0) {
      return NextResponse.json(
        createApiError('At least one repo required', 'MISSING_REPOS'),
        { status: 400 }
      )
    }

    const githubToken = request.headers.get('x-github-token') || process.env.GITHUB_TOKEN

    console.log(`[api/pack] Packing ${repos.length} repos:`, repos.map(r => r.fullName).join(', '))

    // Check abort before expensive operation
    if (request.signal.aborted) {
      console.log('[api/pack] Request aborted before packing')
      return new NextResponse(null, { status: 499 })
    }

    // Pack all repos in parallel (with timeout per repo)
    const packPromises = repos.map(repo =>
      packRemoteRepo({
        repo: repo.fullName,
        branch: repo.branch,
        githubToken,
        ...sliceConfig,
      }, request.signal)
    )

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

    // Assemble context
    const combined = assemblePackedContext(
      packedRepos.filter(r => !r.error),
      userPrompt
    )

    const result: PackResult = {
      repos: packedRepos,
      combined: {
        output: combined,
        totalChars: combined.length,
        totalTokens: Math.ceil(combined.length / 4), // estimate
      },
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
