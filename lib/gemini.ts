import { GoogleGenerativeAI } from '@google/generative-ai'
import { TokenCountResult } from './types'
import { config } from './config'

/**
 * Gemini API Integration
 * Token counting with caching and clear error handling
 */

export class GeminiClient {
  private client: GoogleGenerativeAI

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  /**
   * Count tokens in text using Gemini's authoritative counter
   * @returns TokenCountResult with total, context, and prompt token counts
   * @throws Error with clear message on failure
   */
  async countTokens(
    modelId: string,
    contextText: string,
    userPrompt?: string
  ): Promise<TokenCountResult> {
    try {
      console.log(`[gemini] Counting tokens with model: ${modelId}`)
      const model = this.client.getGenerativeModel({ model: modelId })

      // Combine context and prompt
      const fullText = userPrompt
        ? `${contextText}\n\n# User Prompt\n${userPrompt}`
        : contextText

      console.log(`[gemini] Text length: ${fullText.length} chars`)

      // Get authoritative token count from Gemini
      const result = await model.countTokens(fullText)
      const totalTokens = result.totalTokens

      console.log(`[gemini] Token count: ${totalTokens}`)

      // Estimate breakdown (Gemini doesn't separate context vs prompt in count)
      const contextTokens = userPrompt
        ? Math.floor((contextText.length / fullText.length) * totalTokens)
        : totalTokens
      const promptTokens = totalTokens - contextTokens

      // Get model limit (fallback to 1M if unknown)
      // Most Gemini models have 1M or 2M token limits
      const modelLimit = 1_000_000 // Default safe fallback
      const ratio = totalTokens / modelLimit

      // Determine status
      let status: 'ok' | 'near' | 'over'
      if (ratio >= 1.0) {
        status = 'over'
      } else if (ratio >= 0.9) {
        status = 'near'
      } else {
        status = 'ok'
      }

      return {
        totalTokens,
        contextTokens,
        promptTokens,
        modelLimit,
        status,
      }
    } catch (error) {
      throw this.handleError(error, 'Failed to count tokens')
    }
  }

  /**
   * Chat with Gemini using packed context
   * @returns Async generator yielding response chunks, final value is usage metadata
   */
  async *chat(
    modelId: string,
    contextText: string,
    userPrompt: string,
    thinkingBudget?: number,
    systemPrompt?: string
  ): AsyncGenerator<string, { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | void, unknown> {
    try {
      console.log(`[gemini] Starting chat with model: ${modelId}, thinkingBudget: ${thinkingBudget}`)

      // Build generation config
      const generationConfig: any = {}

      // Only add thinking budget if specified (frontend filters by model capability)
      if (thinkingBudget !== undefined) {
        generationConfig.thinkingConfig = { thinkingBudget }
      }

      // Use provided system prompt or sensible default
      const defaultSystemPrompt = `You are a helpful assistant that explains code clearly to diverse audiences - from engineers to product managers to executives. The user has provided source code from GitHub repositories. Explain concepts at the appropriate level for the question asked. Be clear, accurate, and helpful.`

      const modelConfig: any = {
        model: modelId,
        systemInstruction: systemPrompt || defaultSystemPrompt,
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {})
      }
      console.log(`[gemini] Model config:`, modelConfig)

      const model = this.client.getGenerativeModel(modelConfig)

      const result = await model.generateContentStream(
        `${contextText}\n\n# User Prompt\n${userPrompt}`
      )

      for await (const chunk of result.stream) {
        const text = chunk.text()
        if (text) {
          yield text
        }
      }

      // Get usage metadata from final response
      const response = await result.response
      const usageMetadata = response.usageMetadata
      if (usageMetadata) {
        console.log('[gemini] Usage metadata:', usageMetadata)
        return {
          promptTokenCount: usageMetadata.promptTokenCount,
          candidatesTokenCount: usageMetadata.candidatesTokenCount,
          totalTokenCount: usageMetadata.totalTokenCount,
        }
      }
    } catch (error) {
      console.error('[gemini] Raw error:', error)
      console.error('[gemini] Error type:', error?.constructor?.name)
      console.error('[gemini] Error message:', (error as any)?.message)
      console.error('[gemini] Error stack:', (error as any)?.stack)
      throw this.handleError(error, 'Failed to generate response')
    }
  }

  /**
   * Handle Gemini API errors with clear messages
   */
  private handleError(error: unknown, context: string): Error {
    if (error instanceof Error) {
      const err = error as any

      // Check for specific error types
      if (err.message?.includes('API key')) {
        return new Error(`${context}: Invalid Gemini API key`)
      }

      if (err.message?.includes('quota') || err.message?.includes('rate limit')) {
        return new Error(`${context}: Gemini API quota exceeded or rate limited`)
      }

      if (err.message?.includes('exceeds the maximum') || err.message?.includes('token count') || err.message?.includes('too large')) {
        return new Error(`${context}: Content exceeds Gemini's token limit for counting. Try reducing file count or adding more specific include globs.`)
      }

      if (err.message?.includes('model')) {
        return new Error(`${context}: Invalid or unavailable model`)
      }

      return new Error(`${context}: ${error.message}`)
    }

    return new Error(`${context}: Unknown error`)
  }
}

/**
 * Factory function for creating Gemini client
 */
export function createGeminiClient(apiKey: string): GeminiClient {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('Gemini API key is required')
  }

  return new GeminiClient(apiKey)
}
