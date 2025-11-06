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

      // Get model limit
      const modelConfig = config.gemini.models[modelId]
      if (!modelConfig) {
        throw new Error(`Unknown model: ${modelId}`)
      }

      const modelLimit = modelConfig.limit
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
   * @returns Async generator yielding response chunks
   */
  async *chat(
    modelId: string,
    contextText: string,
    userPrompt: string,
    thinkingBudget?: number
  ): AsyncGenerator<string, void, unknown> {
    try {
      // Build generation config
      const generationConfig: any = {}

      // Only add thinking budget for 2.5 models and if specified
      if (modelId.includes('2.5') && thinkingBudget !== undefined) {
        generationConfig.thinkingBudget = thinkingBudget
      }

      const model = this.client.getGenerativeModel({
        model: modelId,
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {})
      })

      const result = await model.generateContentStream(
        `${contextText}\n\n# User Prompt\n${userPrompt}`
      )

      for await (const chunk of result.stream) {
        const text = chunk.text()
        if (text) {
          yield text
        }
      }
    } catch (error) {
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
