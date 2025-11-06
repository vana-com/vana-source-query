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
      .map((model: any) => ({
        name: model.name, // e.g. "models/gemini-2.5-flash"
        displayName: model.displayName || model.name.replace('models/', ''),
        description: model.description,
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
        supportedGenerationMethods: model.supportedGenerationMethods,
      })) || []

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
