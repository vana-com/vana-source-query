import { NextRequest } from 'next/server'
import { createGeminiClient } from '@/lib/gemini'
import { ChatRequest, ChatStreamEvent } from '@/lib/types'
import { config } from '@/lib/config'

export const runtime = 'nodejs'

/**
 * POST /api/chat
 * Stream chat responses using Server-Sent Events (SSE)
 */
export async function POST(request: NextRequest) {
  try {
    const body: ChatRequest = await request.json()
    const { contextText, userMessage, conversationHistory, modelId, thinkingBudget, systemPrompt } = body

    // Validation
    if (!userMessage) {
      return new Response(
        `data: ${JSON.stringify({ type: 'error', error: 'User message required' } as ChatStreamEvent)}\n\n`,
        {
          status: 400,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        }
      )
    }

    const apiKey = request.headers.get('x-gemini-key') || process.env.GEMINI_API_KEY

    if (!apiKey) {
      return new Response(
        `data: ${JSON.stringify({
          type: 'error',
          error: 'Gemini API key required. Set GEMINI_API_KEY in .env.local or provide X-Gemini-Key header.',
        } as ChatStreamEvent)}\n\n`,
        {
          status: 401,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        }
      )
    }

    const model = modelId || config.gemini.defaultModel
    console.log('[api/chat] Using model:', model, 'with thinking budget:', thinkingBudget)

    // Create client
    const client = createGeminiClient(apiKey)

    // Build conversation context
    // If no context provided, use a general assistant context
    const baseContext = contextText || 'You are a helpful AI assistant specialized in software development and code analysis.'

    let fullContext = baseContext
    if (conversationHistory && conversationHistory.length > 0) {
      const historyText = conversationHistory
        .map((msg) => {
          const role = msg.role === 'user' ? 'User' : 'Assistant'
          return `${role}: ${msg.content}`
        })
        .join('\n\n')
      fullContext = `${baseContext}\n\n# Previous Conversation\n${historyText}`
    }

    // Create SSE stream
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Stream response chunks and capture final usage metadata
          const generator = client.chat(model, fullContext, userMessage, thinkingBudget, systemPrompt)
          let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined

          for await (const chunk of generator) {
            if (typeof chunk === 'string') {
              const event: ChatStreamEvent = { type: 'chunk', text: chunk }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            } else {
              // Final return value is usage metadata
              usageMetadata = chunk
            }
          }

          // Send usage metadata if available
          if (usageMetadata) {
            const usageEvent: ChatStreamEvent = {
              type: 'usage',
              promptTokens: usageMetadata.promptTokenCount,
              outputTokens: usageMetadata.candidatesTokenCount,
              totalTokens: usageMetadata.totalTokenCount,
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageEvent)}\n\n`))
          }

          // Send completion event
          const completeEvent: ChatStreamEvent = { type: 'complete' }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(completeEvent)}\n\n`))
          controller.close()
        } catch (error) {
          console.error('[api/chat] Streaming error:', error)

          const errorMessage = error instanceof Error ? error.message : 'Unknown error'
          const errorEvent: ChatStreamEvent = { type: 'error', error: errorMessage }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`))
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    console.error('[api/chat] Error:', error)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const encoder = new TextEncoder()
    const errorEvent: ChatStreamEvent = { type: 'error', error: errorMessage }

    return new Response(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`), {
      status: 500,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}
