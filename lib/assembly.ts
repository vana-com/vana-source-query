/**
 * Context Assembly Utilities
 *
 * Pure functions for assembling packed repos into prompt-friendly output.
 * Works in both client and server environments (no Node.js dependencies).
 */

import { PackedRepo } from './types'

/**
 * Assemble multiple packed repos into a single prompt-friendly output
 *
 * Can be called client-side or server-side.
 * Separated from lib/repomix.ts to avoid Node.js dependencies in browser.
 */
export function assemblePackedContext(repos: PackedRepo[], userPrompt?: string): string {
  const timestamp = new Date().toISOString().split('T')[0]

  let output = ''

  // Add user prompt at the top if provided
  if (userPrompt?.trim()) {
    output += `# User Prompt\n\n${userPrompt.trim()}\n\n---\n\n`
  }

  output += `# Context: Vana Source Query packed code (generated on ${timestamp})\n\n`

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

  return output
}

/**
 * Calculate total character count for assembled context
 * Used for estimating token counts before calling Gemini API
 */
export function calculateTotalChars(repos: PackedRepo[], userPrompt?: string): number {
  // Estimate: sum of repo outputs + headers + prompt
  const repoChars = repos.reduce((acc, repo) => acc + repo.stats.approxChars, 0)
  const promptChars = userPrompt?.trim().length || 0
  const headerChars = 200 // rough estimate for headers and formatting

  return repoChars + promptChars + headerChars
}
