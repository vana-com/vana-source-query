import { NextRequest, NextResponse } from 'next/server'
import { createGitHubClient } from '@/lib/github'
import { createApiSuccess, createApiError } from '@/lib/types'
import { isServerMode } from '@/lib/prisma'

// Conditionally import auth only in server mode
const getAuth = async () => {
  if (isServerMode) {
    const { auth } = await import('@/lib/auth')
    return auth
  }
  return null
}

export const runtime = 'nodejs'

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
        return session.accessToken
      }
    } catch {
      // Auth not available, continue to header
    }
  }

  // 2. Try header (manual entry)
  const headerToken = request.headers.get('x-github-token')
  if (headerToken) {
    return headerToken
  }

  // 3. Try env fallback
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN
  }

  return null
}

/**
 * GET /api/repos?org=<org>&type=<org|user>
 * List repositories for an organization or user
 *
 * If org is omitted, returns repos from all orgs the user has access to
 *
 * Token resolution:
 * 1. OAuth session (if logged in)
 * 2. X-GitHub-Token header
 * 3. GITHUB_TOKEN env var
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const org = searchParams.get('org')
    const type = searchParams.get('type') || 'org' // 'org' or 'user'

    const token = await getGitHubToken(request)

    if (!token) {
      return NextResponse.json(
        createApiError(
          'GitHub token required. Sign in with GitHub or provide X-GitHub-Token header.',
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

    // Otherwise, fetch repos from all orgs user has access to + personal repos
    const orgs = await client.listUserOrgs()
    console.log(`[api/repos] Fetching repos from ${orgs.length} orgs + personal repos`)

    // Fetch repos from all orgs + personal repos in parallel
    const [personalRepos, ...orgRepoLists] = await Promise.all([
      // Personal repos
      client.listAuthenticatedUserRepos().catch((error) => {
        console.warn('[api/repos] Failed to fetch personal repos:', error)
        return []
      }),
      // Org repos
      ...orgs.map(async (org) => {
        try {
          return await client.listOrgRepos(org.login)
        } catch (error) {
          console.warn(`[api/repos] Failed to fetch repos for org ${org.login}:`, error)
          return []
        }
      })
    ])

    // Flatten and deduplicate by fullName
    const allRepos = [personalRepos, ...orgRepoLists].flat()
    const uniqueRepos = Array.from(
      new Map(allRepos.map(repo => [repo.fullName, repo])).values()
    )

    console.log(`[api/repos] Fetched ${uniqueRepos.length} unique repos (${personalRepos.length} personal + ${orgs.length} orgs)`)

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
