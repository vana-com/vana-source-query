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
    defaultModel: 'gemini-2.5-flash',
    models: {
      'gemini-2.5-flash': {
        name: 'Gemini 2.5 Flash',
        limit: 1_000_000, // 1M tokens
      },
      'gemini-2.5-pro': {
        name: 'Gemini 2.5 Pro',
        limit: 2_000_000, // 2M tokens
      },
      'gemini-2.0-flash': {
        name: 'Gemini 2.0 Flash',
        limit: 1_000_000,
      },
    },
  },
}
