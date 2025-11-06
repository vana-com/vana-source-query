import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

/**
 * GET /api/gemini/models
 * Fetch available Gemini models from Google API
 */
export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-gemini-key') || process.env.GEMINI_API_KEY

    if (!apiKey) {
      return Response.json(
        { error: 'Gemini API key required' },
        { status: 401 }
      )
    }

    // Fetch models from Google Gemini API
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.statusText}`)
    }

    const data = await response.json()

    // Filter for generateContent-capable models only
    const models = data.models
      ?.filter((model: any) =>
        model.supportedGenerationMethods?.includes('generateContent')
      )
      .map((model: any) => {
        const modelName = model.baseModelId || model.name.replace('models/', '')
        const supportsThinking = !!model.thinking

        // Determine thinking budget limits based on model name
        // NOTE: Google API doesn't provide these limits, so we infer from naming patterns
        // If new model families are released, update these patterns
        let maxThinkingBudget: number | undefined
        if (supportsThinking) {
          if (modelName.includes('flash-lite')) {
            maxThinkingBudget = 24576 // Flash-Lite: 512-24576
          } else if (modelName.includes('pro')) {
            maxThinkingBudget = 32768 // Pro: 128-32768
          } else if (modelName.includes('flash')) {
            maxThinkingBudget = 24576 // Flash: 0-24576
          } else {
            // Fallback for unknown model families: use Flash limits (safest/most common)
            maxThinkingBudget = 24576
            console.warn('[api/gemini/models] Unknown model pattern:', modelName, '- using Flash limits (24576)')
          }
        }

        return {
          name: modelName,
          displayName: model.displayName || modelName,
          description: model.description,
          inputTokenLimit: model.inputTokenLimit,
          outputTokenLimit: model.outputTokenLimit,
          supportedGenerationMethods: model.supportedGenerationMethods,
          supportsThinking,
          maxThinkingBudget,
        }
      }) || []

    return Response.json({ models })
  } catch (error) {
    console.error('[api/gemini/models] Error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    return Response.json(
      { error: errorMessage },
      { status: 500 }
    )
  }
}
