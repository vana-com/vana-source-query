import { RepoSelection, SliceConfig } from './types'

/**
 * Generate a stable hash from pack configuration
 * Used as the primary key for IndexedDB conversation persistence
 *
 * Same repos + filters = same hash = conversation continues
 * Different repos + filters = different hash = fresh conversation
 */
export function generatePackHash(
  repos: RepoSelection[],
  sliceConfig: SliceConfig
): string {
  // Create deterministic string representation
  const configString = JSON.stringify({
    repos: repos
      .map(r => ({ fullName: r.fullName, branch: r.branch || '' }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)), // Sort for stability
    includeGlobs: sliceConfig.includeGlobs?.sort() || [],
    ignoreGlobs: sliceConfig.ignoreGlobs?.sort() || [],
    respectGitignore: sliceConfig.respectGitignore ?? true,
    respectAiIgnore: sliceConfig.respectAiIgnore ?? true,
    useDefaultPatterns: sliceConfig.useDefaultPatterns ?? true,
    // Reducers excluded intentionally - they don't change the context structure
  })

  // Simple hash function (FNV-1a)
  return simpleHash(configString)
}

/**
 * Simple FNV-1a hash implementation
 * Fast, deterministic, collision-resistant for our use case
 */
function simpleHash(str: string): string {
  let hash = 2166136261 // FNV offset basis

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619) // FNV prime
  }

  // Convert to unsigned 32-bit hex
  return (hash >>> 0).toString(16).padStart(8, '0')
}
