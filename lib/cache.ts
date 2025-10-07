/**
 * Local Storage Cache
 * Persists user customizations across sessions
 */

export interface VanaQueryCache {
  selectedRepos: string[]
  repoBranches: Record<string, string>
  includeGlobs: string
  ignoreGlobs: string
  respectGitignore: boolean
  useDefaultPatterns: boolean
  userPrompt: string
}

const CACHE_KEY = 'vana-query-cache'
const CACHE_VERSION = 1

const defaultCache: VanaQueryCache = {
  selectedRepos: [],
  repoBranches: {},
  includeGlobs: '',
  ignoreGlobs: '**/*.test.ts,**/*.test.tsx,**/*.test.js,**/*.test.jsx,**/generated/**,**/__tests__/**,**/*.spec.ts,**/*.spec.tsx,**/*.spec.js,**/*.spec.jsx',
  respectGitignore: true,
  useDefaultPatterns: true,
  userPrompt: '',
}

/**
 * Load cached state from localStorage
 * Returns defaults if cache is empty or invalid
 */
export function loadCache(): VanaQueryCache {
  try {
    if (typeof window === 'undefined') {
      return defaultCache
    }

    const cached = localStorage.getItem(CACHE_KEY)
    if (!cached) {
      return defaultCache
    }

    const parsed = JSON.parse(cached)

    // Version check (for future migrations)
    if (parsed.version !== CACHE_VERSION) {
      console.log('[cache] Version mismatch, using defaults')
      return defaultCache
    }

    // Validate structure
    if (!parsed.data || typeof parsed.data !== 'object') {
      return defaultCache
    }

    return {
      ...defaultCache,
      ...parsed.data,
    }
  } catch (error) {
    console.error('[cache] Failed to load cache:', error)
    return defaultCache
  }
}

/**
 * Save state to localStorage
 * Handles quota exceeded and other errors gracefully
 */
export function saveCache(cache: VanaQueryCache): void {
  try {
    if (typeof window === 'undefined') {
      return
    }

    const data = {
      version: CACHE_VERSION,
      data: cache,
      timestamp: Date.now(),
    }

    localStorage.setItem(CACHE_KEY, JSON.stringify(data))
  } catch (error) {
    if (error instanceof Error && error.name === 'QuotaExceededError') {
      console.error('[cache] localStorage quota exceeded')
    } else {
      console.error('[cache] Failed to save cache:', error)
    }
  }
}

/**
 * Clear cache (for debugging or reset)
 */
export function clearCache(): void {
  try {
    if (typeof window === 'undefined') {
      return
    }

    localStorage.removeItem(CACHE_KEY)
    console.log('[cache] Cache cleared')
  } catch (error) {
    console.error('[cache] Failed to clear cache:', error)
  }
}
