import { NextRequest, NextResponse } from 'next/server'
import { createGitHubClient } from '@/lib/github'
import { createApiSuccess, createApiError } from '@/lib/types'

export const runtime = 'nodejs'

/**
 * GET /api/repos?org=<org>&type=<org|user>
 * List repositories for an organization or user
 *
 * If org is omitted, returns repos from all orgs the user has access to
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const org = searchParams.get('org')
    const type = searchParams.get('type') || 'org' // 'org' or 'user'
    const token = request.headers.get('x-github-token') || process.env.GITHUB_TOKEN

    if (!token) {
      return NextResponse.json(
        createApiError(
          'GitHub token required. Set GITHUB_TOKEN in .env.local and restart server, or provide X-GitHub-Token header.',
          'MISSING_TOKEN'
        ),
        { status: 401 }
      )
    }

    // Create client
    const client = await createGitHubClient(token)

    // If org specified, fetch repos for that org/user only
    if (org) {
      const repos = type === 'user'
        ? await client.listUserRepos(org)
        : await client.listOrgRepos(org)

      return NextResponse.json(createApiSuccess(repos))
    }

    // Otherwise, fetch repos from all orgs user has access to
    const orgs = await client.listUserOrgs()
    console.log(`[api/repos] Fetching repos from ${orgs.length} orgs`)

    // Fetch repos from all orgs in parallel
    const repoLists = await Promise.all(
      orgs.map(async (org) => {
        try {
          return await client.listOrgRepos(org.login)
        } catch (error) {
          console.warn(`[api/repos] Failed to fetch repos for org ${org.login}:`, error)
          return []
        }
      })
    )

    // Flatten and deduplicate by fullName
    const allRepos = repoLists.flat()
    const uniqueRepos = Array.from(
      new Map(allRepos.map(repo => [repo.fullName, repo])).values()
    )

    console.log(`[api/repos] Fetched ${uniqueRepos.length} unique repos from ${orgs.length} orgs`)

    return NextResponse.json(createApiSuccess(uniqueRepos))
  } catch (error) {
    console.error('[api/repos] Error:', error)

    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      createApiError(message, 'GITHUB_ERROR'),
      { status: 500 }
    )
  }
}
