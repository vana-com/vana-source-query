import { NextRequest, NextResponse } from 'next/server'
import { GitHubClient } from '@/lib/github'
import { createApiSuccess, createApiError } from '@/lib/types'

export const runtime = 'nodejs'

/**
 * GET /api/repos/branches?repo=owner/repo
 * List all branches for a repository
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const repo = searchParams.get('repo')

    if (!repo) {
      return NextResponse.json(createApiError('repo parameter is required'), { status: 400 })
    }

    // Get GitHub token from header or env
    const token =
      request.headers.get('X-GitHub-Token') || process.env.NEXT_PUBLIC_GITHUB_TOKEN

    if (!token) {
      return NextResponse.json(
        createApiError('GitHub token is required (header or env)'),
        { status: 401 }
      )
    }

    const client = new GitHubClient(token)
    const branches = await client.listBranches(repo)

    return NextResponse.json(createApiSuccess(branches))
  } catch (error) {
    console.error('[API /repos/branches] Error:', error)
    return NextResponse.json(
      createApiError(error instanceof Error ? error.message : 'Failed to list branches'),
      { status: 500 }
    )
  }
}
