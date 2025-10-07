/**
 * Vana Source Query Type Definitions
 * Single Source of Truth for all data structures
 */

// ============================================================================
// GitHub Types
// ============================================================================

export interface GitHubRepo {
  name: string
  fullName: string
  defaultBranch: string
  pushedAt: string
  size: number // in KB
  private: boolean
  description?: string | null
}

export interface RepoSelection {
  fullName: string
  branch?: string // optional override; defaults to defaultBranch
}

// ============================================================================
// Repomix/Packing Types
// ============================================================================

export interface SliceConfig {
  includeGlobs?: string[]
  ignoreGlobs?: string[]
  respectGitignore?: boolean
  respectAiIgnore?: boolean
  useDefaultPatterns?: boolean
  reducers?: {
    compress?: boolean
    removeComments?: boolean
    removeEmptyLines?: boolean
    truncateBase64?: boolean
  }
}

export interface PackedRepo {
  repo: string
  branch: string
  output: string
  stats: {
    fileCount: number
    approxChars: number
    approxTokens: number // rough estimate: chars / 4
  }
  error?: string
}

export interface PackResult {
  repos: PackedRepo[]
  combined: {
    output: string
    totalChars: number
    totalTokens: number // estimate until Gemini counts
  }
  errors: string[]
}

// ============================================================================
// Token Counting Types
// ============================================================================

export interface TokenCountRequest {
  modelId: string
  contextText: string
  userPrompt?: string
}

export interface TokenCountResult {
  totalTokens: number
  contextTokens: number
  promptTokens: number
  modelLimit: number
  status: 'ok' | 'near' | 'over' // ok: <90%, near: 90-99%, over: >=100%
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiError {
  error: string
  code?: string
  details?: unknown
}

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string; details?: unknown }

// ============================================================================
// Config Types
// ============================================================================

export interface AppConfig {
  github: {
    apiUrl: string
    timeout: number
  }
  repomix: {
    timeout: number
    maxFileSize: number
    maxTotalSize: number
  }
  gemini: {
    defaultModel: string
    models: Record<string, { limit: number; name: string }>
  }
}

// ============================================================================
// Helpers
// ============================================================================

export function createApiSuccess<T>(data: T): ApiResponse<T> {
  return { success: true, data }
}

export function createApiError(error: string, code?: string, details?: unknown): ApiResponse<never> {
  return { success: false, error, code, details }
}
