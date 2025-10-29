import { NextRequest, NextResponse } from 'next/server'
import { createGitHubClient } from '@/lib/github'
import { createApiSuccess, createApiError } from '@/lib/types'

export const runtime = 'nodejs'

/**
 * GET /api/repos/validate?repo=owner/name
 * Validate that a repository exists and is accessible
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const repo = searchParams.get('repo')
    const token = request.headers.get('x-github-token') || process.env.GITHUB_TOKEN

    // Validation
    if (!repo) {
      return NextResponse.json(
        createApiError('Missing required parameter: repo', 'MISSING_PARAM'),
        { status: 400 }
      )
    }

    // Validate format
    if (!repo.includes('/') || repo.split('/').length !== 2) {
      return NextResponse.json(
        createApiError('Invalid repo format. Expected: owner/name', 'INVALID_FORMAT'),
        { status: 400 }
      )
    }

    if (!token) {
      return NextResponse.json(
        createApiError(
          'GitHub token required. Set GITHUB_TOKEN in .env.local and restart server, or provide X-GitHub-Token header.',
          'MISSING_TOKEN'
        ),
        { status: 401 }
      )
    }

    // Create client and fetch repo metadata
    const client = await createGitHubClient(token)
    const repoData = await client.getRepoMetadata(repo)

    return NextResponse.json(
      createApiSuccess({
        exists: true,
        repo: repoData,
      })
    )
  } catch (error) {
    console.error('[api/repos/validate] Error:', error)

    const message = error instanceof Error ? error.message : 'Unknown error'

    // Check if it's a 404 error
    if (message.includes('Not found')) {
      return NextResponse.json(
        createApiError('Repository not found or not accessible', 'NOT_FOUND'),
        { status: 404 }
      )
    }

    return NextResponse.json(
      createApiError(message, 'GITHUB_ERROR'),
      { status: 500 }
    )
  }
}
