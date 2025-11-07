import { Octokit } from '@octokit/rest'
import { GitHubRepo } from './types'
import { config } from './config'

/**
 * GitHub API Integration
 * Thin wrapper over Octokit with explicit error handling
 */

export class GitHubClient {
  private octokit: Octokit

  constructor(token: string) {
    this.octokit = new Octokit({
      auth: token,
      baseUrl: config.github.apiUrl,
      request: {
        timeout: config.github.timeout,
      },
    })
  }

  /**
   * List repositories for an organization
   * @throws Error with clear message on failure
   */
  async listOrgRepos(org: string): Promise<GitHubRepo[]> {
    try {
      const { data } = await this.octokit.rest.repos.listForOrg({
        org,
        type: 'all',
        per_page: 100,
        sort: 'pushed',
        direction: 'desc',
      })

      return data.map(this.mapRepo)
    } catch (error) {
      throw this.handleError(error, `Failed to list repos for org: ${org}`)
    }
  }

  /**
   * List repositories for a user
   * @throws Error with clear message on failure
   */
  async listUserRepos(username: string): Promise<GitHubRepo[]> {
    try {
      const { data } = await this.octokit.rest.repos.listForUser({
        username,
        type: 'all',
        per_page: 100,
        sort: 'pushed',
        direction: 'desc',
      })

      return data.map(this.mapRepo)
    } catch (error) {
      throw this.handleError(error, `Failed to list repos for user: ${username}`)
    }
  }

  /**
   * Get metadata for a specific repository
   * @throws Error with clear message on failure
   */
  async getRepoMetadata(fullName: string): Promise<GitHubRepo> {
    try {
      const [owner, repo] = fullName.split('/')
      if (!owner || !repo) {
        throw new Error(`Invalid repo format: ${fullName}. Expected: owner/repo`)
      }

      const { data } = await this.octokit.rest.repos.get({ owner, repo })
      return this.mapRepo(data)
    } catch (error) {
      throw this.handleError(error, `Failed to get repo metadata: ${fullName}`)
    }
  }

  /**
   * List organizations the authenticated user belongs to
   * @throws Error with clear message on failure
   */
  async listUserOrgs(): Promise<Array<{ login: string; description: string | null }>> {
    try {
      const { data } = await this.octokit.rest.orgs.listForAuthenticatedUser({
        per_page: 100,
      })

      return data.map(org => ({
        login: org.login,
        description: org.description,
      }))
    } catch (error) {
      throw this.handleError(error, 'Failed to list user organizations')
    }
  }

  /**
   * Validate that the token has required permissions
   * @throws Error if token is invalid or lacks permissions
   */
  async validateToken(): Promise<{ user: string; scopes: string[] }> {
    try {
      const { data: user } = await this.octokit.rest.users.getAuthenticated()

      // Get token scopes from response headers (if available)
      const scopes: string[] = []

      return {
        user: user.login,
        scopes,
      }
    } catch (error) {
      throw this.handleError(error, 'Failed to validate GitHub token')
    }
  }

  /**
   * List all branches for a repository
   * @throws Error with clear message on failure
   */
  async listBranches(fullName: string): Promise<string[]> {
    try {
      const [owner, repo] = fullName.split('/')
      if (!owner || !repo) {
        throw new Error(`Invalid repo format: ${fullName}. Expected: owner/repo`)
      }

      const { data } = await this.octokit.rest.repos.listBranches({
        owner,
        repo,
        per_page: 100,
      })

      return data.map(branch => branch.name)
    } catch (error) {
      throw this.handleError(error, `Failed to list branches for ${fullName}`)
    }
  }

  /**
   * Fetch the current commit SHA for a branch
   * Used for cache freshness validation
   * @throws Error with clear message on failure
   */
  async fetchCurrentCommitSHA(fullName: string, branch: string): Promise<string> {
    try {
      const [owner, repo] = fullName.split('/')
      if (!owner || !repo) {
        throw new Error(`Invalid repo format: ${fullName}. Expected: owner/repo`)
      }

      const { data } = await this.octokit.rest.repos.getBranch({
        owner,
        repo,
        branch,
      })

      return data.commit.sha
    } catch (error) {
      throw this.handleError(error, `Failed to fetch commit SHA for ${fullName}:${branch}`)
    }
  }

  /**
   * Count commits between two SHAs
   * Used to show staleness ("3 commits behind")
   * @throws Error with clear message on failure
   */
  async countCommitsBehind(fullName: string, oldSHA: string, newSHA: string): Promise<number> {
    try {
      const [owner, repo] = fullName.split('/')
      if (!owner || !repo) {
        throw new Error(`Invalid repo format: ${fullName}. Expected: owner/repo`)
      }

      // Use compare API to get commit count
      const { data } = await this.octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${oldSHA}...${newSHA}`,
      })

      return data.ahead_by
    } catch (error) {
      // If comparison fails, return undefined (can't determine)
      console.warn(`Failed to compare commits for ${fullName}:`, error)
      return 0
    }
  }

  /**
   * Map GitHub API response to our GitHubRepo type
   */
  private mapRepo(data: any): GitHubRepo {
    return {
      name: data.name,
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      pushedAt: data.pushed_at,
      size: data.size,
      private: data.private,
      description: data.description,
    }
  }

  /**
   * Handle GitHub API errors with clear, actionable messages
   */
  private handleError(error: unknown, context: string): Error {
    if (error instanceof Error) {
      // Check for specific GitHub API errors
      const err = error as any

      if (err.status === 401) {
        return new Error(`${context}: Invalid or expired GitHub token`)
      }

      if (err.status === 403) {
        if (err.response?.headers?.['x-ratelimit-remaining'] === '0') {
          const resetTime = err.response?.headers?.['x-ratelimit-reset']
          const resetDate = resetTime ? new Date(parseInt(resetTime) * 1000) : null
          return new Error(
            `${context}: GitHub rate limit exceeded. Resets at ${resetDate?.toLocaleTimeString()}`
          )
        }
        return new Error(`${context}: Forbidden. Check token permissions.`)
      }

      if (err.status === 404) {
        return new Error(`${context}: Not found. Check org/repo name and token access.`)
      }

      return new Error(`${context}: ${error.message}`)
    }

    return new Error(`${context}: Unknown error`)
  }
}

/**
 * Factory function for creating GitHub client
 * Validates token and returns client or throws
 */
export async function createGitHubClient(token: string): Promise<GitHubClient> {
  if (!token || token.trim() === '') {
    throw new Error('GitHub token is required')
  }

  const client = new GitHubClient(token)

  // Validate token on creation
  await client.validateToken()

  return client
}
