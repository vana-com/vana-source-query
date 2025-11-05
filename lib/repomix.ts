import { runRemoteAction, runDefaultAction, type CliOptions } from 'repomix'
import { readFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SliceConfig, PackedRepo } from './types'
import { config } from './config'

/**
 * Monkey-patch fetch to add GitHub authentication
 *
 * Repomix's archive download doesn't pass GITHUB_TOKEN in Authorization header,
 * causing 404 for private repos. This patch injects the token for all GitHub requests.
 *
 * See: https://github.com/vana-com/vana-source-query/issues/XXX
 */
const originalFetch = global.fetch
global.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

  // Add Authorization header for GitHub API/archive requests if GITHUB_TOKEN exists
  if (url.includes('github.com') && process.env.GITHUB_TOKEN) {
    const headers = new Headers(init?.headers || {})

    // Only add if not already present
    if (!headers.has('authorization') && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${process.env.GITHUB_TOKEN}`)
    }

    return originalFetch(input, { ...init, headers })
  }

  return originalFetch(input, init)
} as typeof fetch

/**
 * AI Ignore File Support
 *
 * Fetches and parses .aiignore files from GitHub repos.
 * Respects repo owner's intent about what should be excluded from LLM context.
 */

/**
 * Fetch a single file from GitHub repository
 * @returns File contents as string, or null if file doesn't exist
 */
async function fetchFileFromGitHub(
  repo: string,
  branch: string,
  filename: string,
  token?: string
): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${repo}/contents/${filename}?ref=${branch}`
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3.raw',
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(url, { headers })

    if (response.status === 404) {
      return null // File doesn't exist
    }

    if (!response.ok) {
      console.warn(`[aiignore] Failed to fetch ${filename}: ${response.status}`)
      return null
    }

    return await response.text()
  } catch (error) {
    console.warn(`[aiignore] Error fetching ${filename}:`, error)
    return null
  }
}

/**
 * Parse .aiignore content into patterns array
 * Uses gitignore syntax: lines starting with # are comments, empty lines ignored
 */
function parseAiIgnorePatterns(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
}

/**
 * Get AI ignore patterns from multiple AI ignore files in repo root
 *
 * Checks for multiple ignore file formats used by different AI tools:
 * - .aiignore (emerging industry standard - JetBrains, Cursor proposal)
 * - .aiexclude (Google Gemini Code Assist)
 * - .cursorignore (Cursor IDE)
 * - .codeiumignore (Codeium)
 * - .agentignore (generic)
 * - .geminiignore (Google Gemini)
 *
 * All use gitignore syntax. Patterns are merged if multiple files exist.
 *
 * @returns Array of ignore patterns, empty if no files exist
 */
async function getAiIgnorePatterns(
  repo: string,
  branch: string,
  token?: string
): Promise<string[]> {
  const filenames = [
    '.aiignore',      // Industry standard (JetBrains, proposed standard)
    '.aiexclude',     // Google Gemini Code Assist
    '.cursorignore',  // Cursor IDE
    '.codeiumignore', // Codeium
    '.agentignore',   // Generic
    '.geminiignore',  // Google Gemini
  ]

  // Fetch all files in parallel instead of sequentially
  const results = await Promise.all(
    filenames.map(async (filename) => {
      const content = await fetchFileFromGitHub(repo, branch, filename, token)
      return content ? { filename, patterns: parseAiIgnorePatterns(content) } : null
    })
  )

  // Collect patterns from successful fetches
  const allPatterns: string[] = []
  const foundFiles: string[] = []

  for (const result of results) {
    if (result) {
      allPatterns.push(...result.patterns)
      foundFiles.push(result.filename)
    }
  }

  if (foundFiles.length > 0) {
    console.log(`[aiignore] Found ${allPatterns.length} patterns from: ${foundFiles.join(', ')}`)
  }

  // Deduplicate patterns
  return [...new Set(allPatterns)]
}

/**
 * Repomix Integration
 *
 * Two distinct paths (Simple Made Easy - Rich Hickey):
 * - packRemoteRepo: GitHub repos via archive download (no git binary needed)
 * - packLocalRepo: Local directories (for tests only)
 *
 * Each function has single responsibility, clear contract.
 */

interface BasePackOptions extends SliceConfig {
  // Slice config options inherited
}

export interface RemotePackOptions extends BasePackOptions {
  repo: string // "owner/name"
  branch?: string
  githubToken?: string
}

export interface LocalPackOptions extends BasePackOptions {
  directory: string
}

/**
 * Pack a GitHub repository (production path)
 *
 * Uses runRemoteAction which downloads via GitHub archive API.
 * No git binary required - works in Vercel serverless.
 *
 * Guarantees (Carmack): Archive download always tried first for GitHub repos
 */
export async function packRemoteRepo(
  options: RemotePackOptions,
  signal?: AbortSignal
): Promise<PackedRepo> {
  const startTime = Date.now()

  console.log(`[repomix] Packing ${options.repo} (remote)`)

  // Create temp file for output
  const tempDir = mkdtempSync(join(tmpdir(), 'repomix-'))
  const outputFile = join(tempDir, 'output.xml')

  try {
    // Set GITHUB_TOKEN for private repos
    if (options.githubToken) {
      process.env.GITHUB_TOKEN = options.githubToken
    }

    // Log configuration for debugging intermittent git errors
    console.log(`[repomix] Config for ${options.repo}:`, {
      branch: options.branch || 'main',
      hasToken: !!options.githubToken,
      includeGlobs: options.includeGlobs?.length || 0,
      ignoreGlobs: options.ignoreGlobs?.length || 0,
    })

    // Fetch .aiignore patterns from repo root (if enabled)
    const aiIgnorePatterns = options.respectAiIgnore !== false
      ? await getAiIgnorePatterns(
          options.repo,
          options.branch || 'main',
          options.githubToken
        )
      : []

    // Merge ignore patterns: user globs > .aiignore > repomix defaults
    const allIgnorePatterns = [
      ...(options.ignoreGlobs || []),
      ...aiIgnorePatterns,
    ]

    // Build CLI options
    const cliOptions: CliOptions = {
      output: outputFile,
      style: 'xml',
      remoteBranch: options.branch,
      include: options.includeGlobs?.join(','),
      ignore: allIgnorePatterns.length > 0 ? allIgnorePatterns.join(',') : undefined,
      removeComments: options.reducers?.removeComments,
      removeEmptyLines: options.reducers?.removeEmptyLines,
      // Explicitly disable git-dependent features (no git in Vercel)
      gitSortByChanges: false,
      includeDiffs: false,
      includeLogs: false,
      // Performance: disable security checks and reduce logging
      securityCheck: false,
      quiet: true,
    }

    // Use runRemoteAction directly - GitHub archive download, no git!
    console.log(`[repomix] Calling runRemoteAction for ${options.repo}`)
    await runRemoteAction(options.repo, cliOptions)
    console.log(`[repomix] runRemoteAction completed for ${options.repo}`)

    const duration = Date.now() - startTime

    // Read output from temp file
    const output = readFileSync(outputFile, 'utf-8')
    const stats = extractRepomixStats(output)

    console.log(`[repomix] ✓ ${options.repo} (${duration}ms, ${stats.fileCount} files)`)

    return {
      repo: options.repo,
      branch: options.branch || 'main',
      output,
      stats,
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined

    // Translate common Repomix errors into user-friendly messages
    let errorMessage = rawMessage

    // GitHub archive download failures often manifest as "Git not installed" errors
    // but we're not using git binary - it's actually a GitHub API/network issue
    if (rawMessage.includes('Git') || rawMessage.includes('git')) {
      if (rawMessage.includes('404') || rawMessage.includes('not found')) {
        errorMessage = `Repository not found or invalid branch "${options.branch || 'main'}". Check that the repo exists and the branch name is correct.`
      } else if (rawMessage.includes('401') || rawMessage.includes('403') || rawMessage.includes('Unauthorized')) {
        errorMessage = `Authentication failed. Check that your GitHub token has access to ${options.repo}.`
      } else {
        errorMessage = `Failed to download repository archive: ${rawMessage}. This may be a network issue or GitHub API error.`
      }
    }
    // Handle explicit 404 errors from GitHub API
    else if (rawMessage.includes('404') || rawMessage.includes('not found')) {
      errorMessage = `Repository or branch not found: ${options.repo}@${options.branch || 'main'}. Verify the repository exists and the branch name is correct.`
    }
    // Handle auth errors
    else if (rawMessage.includes('401') || rawMessage.includes('403') || rawMessage.includes('Unauthorized')) {
      errorMessage = `Access denied to ${options.repo}. Ensure your GitHub token has the required permissions.`
    }

    console.error(`[repomix] ✗ ${options.repo} failed:`, {
      rawMessage,
      translatedMessage: errorMessage,
      branch: options.branch || 'main',
      hasToken: !!options.githubToken,
      stack: errorStack,
    })

    return {
      repo: options.repo,
      branch: options.branch || 'main',
      output: '',
      stats: { fileCount: 0, approxChars: 0, approxTokens: 0 },
      error: errorMessage,
    }
  } finally {
    // Cleanup temp file
    try {
      unlinkSync(outputFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Pack a local directory (test path only)
 *
 * Uses runDefaultAction for direct file access.
 * Not used in production.
 */
export async function packLocalRepo(
  options: LocalPackOptions
): Promise<PackedRepo> {
  const tempDir = mkdtempSync(join(tmpdir(), 'repomix-'))
  const outputFile = join(tempDir, 'output.xml')

  try {
    const cliOptions: CliOptions = {
      output: outputFile,
      style: 'xml',
      include: options.includeGlobs?.join(','),
      ignore: options.ignoreGlobs?.join(','),
      removeComments: options.reducers?.removeComments,
      removeEmptyLines: options.reducers?.removeEmptyLines,
      // Disable git features for local tests too
      gitSortByChanges: false,
      includeDiffs: false,
      includeLogs: false,
      // Performance: disable security checks and reduce logging
      securityCheck: false,
      quiet: true,
    }

    await runDefaultAction([options.directory], process.cwd(), cliOptions)

    const output = readFileSync(outputFile, 'utf-8')
    const stats = extractRepomixStats(output)

    return {
      repo: options.directory,
      branch: 'local',
      output,
      stats,
    }
  } catch (error) {
    return {
      repo: options.directory,
      branch: 'local',
      output: '',
      stats: { fileCount: 0, approxChars: 0, approxTokens: 0 },
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  } finally {
    try {
      unlinkSync(outputFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Extract statistics from Repomix XML output
 * Repomix 1.6+ includes <statistics> section with token counts
 */
function extractRepomixStats(output: string): { fileCount: number; approxChars: number; approxTokens: number } {
  // Try to extract from <statistics> section
  const statsMatch = output.match(/<statistics>[\s\S]*?<\/statistics>/)

  if (statsMatch) {
    const statsSection = statsMatch[0]

    const fileCountMatch = statsSection.match(/<total_files>(\d+)<\/total_files>/)
    const charsMatch = statsSection.match(/<total_chars>(\d+)<\/total_chars>/)
    const tokensMatch = statsSection.match(/<total_tokens>(\d+)<\/total_tokens>/)

    return {
      fileCount: fileCountMatch ? parseInt(fileCountMatch[1], 10) : 0,
      approxChars: charsMatch ? parseInt(charsMatch[1], 10) : output.length,
      approxTokens: tokensMatch ? parseInt(tokensMatch[1], 10) : Math.ceil(output.length / 4),
    }
  }

  // Fallback: count files manually and estimate tokens
  const fileHeaderPattern = /<file path="([^"]+)">/g
  const matches = output.match(fileHeaderPattern)

  return {
    fileCount: matches ? matches.length : 0,
    approxChars: output.length,
    approxTokens: Math.ceil(output.length / 4),
  }
}

/**
 * Assemble multiple packed repos into a single prompt-friendly output
 *
 * @deprecated Use lib/assembly.ts directly for client-side usage
 * Re-exported here for backward compatibility
 */
export { assemblePackedContext } from './assembly'
