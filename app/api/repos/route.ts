import { NextRequest, NextResponse } from 'next/server'
import { createGitHubClient } from '@/lib/github'
import { createApiSuccess, createApiError } from '@/lib/types'

export const runtime = 'nodejs'

/**
 * GET /api/repos?org=<org>&type=<org|user>
 * List repositories for an organization or user
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const org = searchParams.get('org')
    const type = searchParams.get('type') || 'org' // 'org' or 'user'
    const token = request.headers.get('x-github-token') || process.env.GITHUB_TOKEN

    // Validation
    if (!org) {
      return NextResponse.json(
        createApiError('Missing required parameter: org', 'MISSING_PARAM'),
        { status: 400 }
      )
    }

    if (!token) {
      return NextResponse.json(
        createApiError('GitHub token required. Provide via X-GitHub-Token header or GITHUB_TOKEN env var', 'MISSING_TOKEN'),
        { status: 401 }
      )
    }

    // Create client and fetch repos
    const client = await createGitHubClient(token)

    const repos = type === 'user'
      ? await client.listUserRepos(org)
      : await client.listOrgRepos(org)

    return NextResponse.json(createApiSuccess(repos))
  } catch (error) {
    console.error('[api/repos] Error:', error)

    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      createApiError(message, 'GITHUB_ERROR'),
      { status: 500 }
    )
  }
}
