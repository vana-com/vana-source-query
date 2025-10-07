import { NextRequest, NextResponse } from 'next/server'
import { createGeminiClient } from '@/lib/gemini'
import { createApiSuccess, createApiError, TokenCountRequest } from '@/lib/types'
import { config } from '@/lib/config'

export const runtime = 'nodejs'

/**
 * POST /api/tokens
 * Count tokens using Gemini API (authoritative)
 */
export async function POST(request: NextRequest) {
  try {
    const body: TokenCountRequest = await request.json()
    const { modelId, contextText, userPrompt } = body

    // Validation
    if (!contextText) {
      return NextResponse.json(
        createApiError('Context text required', 'MISSING_CONTEXT'),
        { status: 400 }
      )
    }

    const apiKey = request.headers.get('x-gemini-key') || process.env.GEMINI_API_KEY

    if (!apiKey) {
      return NextResponse.json(
        createApiError('Gemini API key required. Provide via X-Gemini-Key header or GEMINI_API_KEY env var', 'MISSING_KEY'),
        { status: 401 }
      )
    }

    const model = modelId || config.gemini.defaultModel

    // Create client and count tokens
    const client = createGeminiClient(apiKey)
    const result = await client.countTokens(model, contextText, userPrompt)

    return NextResponse.json(createApiSuccess(result))
  } catch (error) {
    console.error('[api/tokens] Error:', error)

    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      createApiError(message, 'TOKEN_COUNT_ERROR'),
      { status: 500 }
    )
  }
}
