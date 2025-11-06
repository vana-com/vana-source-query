import { NextRequest, NextResponse } from 'next/server'
import { GitHubClient } from '@/lib/github'
import { createApiSuccess, createApiError } from '@/lib/types'

export const runtime = 'nodejs'

/**
 * POST /api/sha
 * Fetch current commit SHAs for multiple repos
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      repos,
    }: {
      repos: Array<{ fullName: string; branch: string }>
    } = body

    if (!repos || !Array.isArray(repos) || repos.length === 0) {
      return NextResponse.json(
        createApiError('At least one repo required', 'MISSING_REPOS'),
        { status: 400 }
      )
    }

    const githubToken = request.headers.get('x-github-token') || process.env.GITHUB_TOKEN

    if (!githubToken) {
      return NextResponse.json(
        createApiError('GitHub token required', 'MISSING_TOKEN'),
        { status: 401 }
      )
    }

    const client = new GitHubClient(githubToken)

    // Fetch SHAs in parallel
    const shaPromises = repos.map(async (repo) => {
      try {
        const sha = await client.fetchCurrentCommitSHA(repo.fullName, repo.branch)
        return {
          fullName: repo.fullName,
          branch: repo.branch,
          sha,
          error: null,
        }
      } catch (error) {
        return {
          fullName: repo.fullName,
          branch: repo.branch,
          sha: null,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      }
    })

    const results = await Promise.all(shaPromises)

    // Separate successful and failed fetches
    const shas: Record<string, { sha: string; branch: string }> = {}
    const errors: string[] = []

    for (const result of results) {
      if (result.sha) {
        shas[result.fullName] = { sha: result.sha, branch: result.branch }
      } else if (result.error) {
        errors.push(`${result.fullName}: ${result.error}`)
      }
    }

    return NextResponse.json(
      createApiSuccess({
        shas,
        errors,
      })
    )
  } catch (error) {
    console.error('[api/sha] Error:', error)

    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(createApiError(message, 'SHA_ERROR'), { status: 500 })
  }
}
