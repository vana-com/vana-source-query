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

    // Build CLI options
    const cliOptions: CliOptions = {
      output: outputFile,
      style: 'xml',
      remoteBranch: options.branch,
      include: options.includeGlobs?.join(','),
      ignore: options.ignoreGlobs?.join(','),
      removeComments: options.reducers?.removeComments,
      removeEmptyLines: options.reducers?.removeEmptyLines,
      // Explicitly disable git-dependent features (no git in Vercel)
      gitSortByChanges: false,
      includeDiffs: false,
      includeLogs: false,
    }

    // Use runRemoteAction directly - GitHub archive download, no git!
    await runRemoteAction(options.repo, cliOptions)

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
    console.error(`[repomix] ✗ ${options.repo}:`, error)

    return {
      repo: options.repo,
      branch: options.branch || 'main',
      output: '',
      stats: { fileCount: 0, approxChars: 0, approxTokens: 0 },
      error: error instanceof Error ? error.message : 'Unknown error',
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
 */
export function assemblePackedContext(repos: PackedRepo[], userPrompt?: string): string {
  const timestamp = new Date().toISOString().split('T')[0]

  let output = `# Context: Vana Source Query packed code (generated on ${timestamp})\n\n`

  for (const repo of repos) {
    if (repo.error) {
      output += `## Repo: ${repo.repo} (${repo.branch}) — ERROR\n`
      output += `Error: ${repo.error}\n\n`
      continue
    }

    output += `## Repo: ${repo.repo} (${repo.branch})\n`
    output += `- Files included: ${repo.stats.fileCount} | Approx chars: ${repo.stats.approxChars.toLocaleString()}\n\n`
    output += repo.output
    output += `\n\n`
  }

  if (userPrompt && userPrompt.trim()) {
    output += `# Prompt\n${userPrompt}\n\n`
  }

  return output
}
