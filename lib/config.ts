import { AppConfig } from './types'

/**
 * Application Configuration
 * Single source of truth for all defaults and limits
 */
export const config: AppConfig = {
  github: {
    apiUrl: 'https://api.github.com',
    timeout: 30000, // 30s
  },
  repomix: {
    timeout: 60000, // 60s per repo
    maxFileSize: 1024 * 1024, // 1MB per file
    maxTotalSize: 50 * 1024, // 50MB total per repo (in KB)
  },
  gemini: {
    defaultModel: 'models/gemini-2.5-flash', // Models are fetched dynamically from API
  },
}

/**
 * Cache Configuration
 * Controls packed repo caching behavior
 */
export const CACHE_CONFIG = {
  // Storage limits
  maxTotalSize: 100 * 1024 * 1024, // 100MB total cache
  maxEntrySize: 10 * 1024 * 1024, // 10MB per repo

  // Staleness thresholds
  warnIfCommitsBehind: 5, // Show warning if >5 commits behind
  warnIfDaysOld: 7, // Show warning if >7 days old

  // Auto-refresh
  autoRefreshIfMinutesBehind: 5, // Auto re-pack if packed <5min ago but new commits

  // Housekeeping
  purgeIfNotAccessedDays: 30, // Auto-purge if not accessed in 30 days

  // IndexedDB
  dbName: 'vana-pack-cache',
  dbVersion: 1,
  storeName: 'packs',
}
