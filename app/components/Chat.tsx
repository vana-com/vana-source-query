"use client"

import { useState, useEffect, useRef } from 'react'
import { Message, ChatStreamEvent } from '@/lib/types'
import { saveConversation, loadConversation, deleteConversation } from '@/lib/chatDb'
import { ChatMessage } from './ChatMessage'

interface ChatProps {
  packedContext: string
  packHash: string
  geminiApiKey?: string
}

/**
 * Main chat interface component
 * Handles message state, persistence, streaming, and user interactions
 */
export function Chat({ packedContext, packHash, geminiApiKey }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isVisible, setIsVisible] = useState(true) // Auto-open by default
  const [showExportMenu, setShowExportMenu] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const userHasScrolledRef = useRef(false)
  const streamingMessageIdRef = useRef<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  // Load conversation from IndexedDB on mount
  useEffect(() => {
    async function loadConvo() {
      const saved = await loadConversation(packHash)
      if (saved && saved.length > 0) {
        setMessages(saved)
      }
    }
    loadConvo()
  }, [packHash])

  // Save conversation to IndexedDB whenever messages change
  useEffect(() => {
    if (messages.length > 0) {
      saveConversation(packHash, messages, packedContext.length)
    }
  }, [messages, packHash, packedContext])

  // Auto-scroll to bottom when messages change (but only if user hasn't manually scrolled)
  useEffect(() => {
    if (!userHasScrolledRef.current && streaming) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, streaming])

  // Detect manual scroll
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100
      userHasScrolledRef.current = !isNearBottom
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [])

  // Auto-grow textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [input])

  // Close export menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false)
      }
    }

    if (showExportMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showExportMenu])

  // Stream a message from Gemini
  const sendMessage = async (content: string, messageIndex?: number) => {
    if (!content.trim() || streaming) return

    // Cancel any existing stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    setError(null)
    setStreaming(true)

    try {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: content.trim(),
        timestamp: Date.now(),
      }

      // If editing, delete all messages after this point
      let updatedMessages: Message[]
      if (messageIndex !== undefined) {
        updatedMessages = [...messages.slice(0, messageIndex), userMsg]
      } else {
        updatedMessages = [...messages, userMsg]
      }

      setMessages(updatedMessages)
      setInput('')

      // Add placeholder for model response
      const modelMsg: Message = {
        id: crypto.randomUUID(),
        role: 'model',
        content: '',
        timestamp: Date.now(),
      }
      const messagesWithModel = [...updatedMessages, modelMsg]
      setMessages(messagesWithModel)

      // Track which message we're streaming to
      streamingMessageIdRef.current = modelMsg.id

      // Build conversation history (exclude the current user message and placeholder)
      const conversationHistory = updatedMessages
        .slice(0, -1)
        .map((msg) => ({
          role: msg.role,
          content: msg.content,
        }))

      // Stream response from API
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(geminiApiKey ? { 'X-Gemini-Key': geminiApiKey } : {}),
        },
        signal: abortController.signal,
        body: JSON.stringify({
          contextText: packedContext,
          userMessage: content.trim(),
          conversationHistory:
            conversationHistory.length > 0 ? conversationHistory : undefined,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body')
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const eventData = line.slice(6).trim()
            if (!eventData) continue

            try {
              const event: ChatStreamEvent = JSON.parse(eventData)

              if (event.type === 'chunk' && event.text) {
                setMessages((prev) => {
                  const streamingId = streamingMessageIdRef.current
                  if (!streamingId) return prev

                  const updated = prev.map((msg) => {
                    if (msg.id === streamingId) {
                      return { ...msg, content: msg.content + event.text }
                    }
                    return msg
                  })
                  return updated
                })
              } else if (event.type === 'error') {
                setError(event.error || 'Unknown error occurred')
                setStreaming(false)
                streamingMessageIdRef.current = null
                return
              } else if (event.type === 'complete') {
                setStreaming(false)
                streamingMessageIdRef.current = null
                userHasScrolledRef.current = false // Reset scroll lock
                return
              }
            } catch (parseError) {
              console.error('[Chat] Failed to parse SSE event:', parseError)
            }
          }
        }
      }

      setStreaming(false)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Ignore abort errors
        return
      }

      console.error('[Chat] Error:', err)
      setError(err instanceof Error ? err.message : 'Failed to send message')
      setStreaming(false)
      streamingMessageIdRef.current = null
      userHasScrolledRef.current = false
    }
  }

  const handleEdit = (messageIndex: number, newContent: string) => {
    sendMessage(newContent, messageIndex)
  }

  const handleRetry = (messageIndex: number) => {
    // Get the user message before this model response
    const userMessage = messages[messageIndex - 1]
    if (userMessage && userMessage.role === 'user') {
      // Keep messages up to and including the user message, then resend
      setMessages((prev) => prev.slice(0, messageIndex))
      sendMessage(userMessage.content, messageIndex - 1)
    }
  }

  const handleCopy = (messageIndex: number) => {
    const message = messages[messageIndex]
    const previousMessage = messageIndex > 0 ? messages[messageIndex - 1] : undefined

    // Format as Q&A if there's a previous user message
    let textToCopy = message.content
    if (previousMessage && previousMessage.role === 'user') {
      textToCopy = `**Q:** ${previousMessage.content}\n\n**A:** ${message.content}`
    }

    navigator.clipboard.writeText(textToCopy)
  }

  const handleClear = async () => {
    if (
      window.confirm(
        'Clear this conversation? This action cannot be undone.'
      )
    ) {
      setMessages([])
      await deleteConversation(packHash)
    }
  }

  const handleExportToAI = async (platform: string, url: string) => {
    await navigator.clipboard.writeText(packedContext)
    setShowExportMenu(false)
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleDownloadTxt = () => {
    const blob = new Blob([packedContext], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `packed-repos-${Date.now()}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    setShowExportMenu(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !streaming) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  if (!isVisible) {
    return null
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header with Clear button only */}
      {messages.length > 0 && (
        <div className="flex items-center justify-end mb-4">
          <button onClick={handleClear} className="text-xs text-neutral-500 hover:text-neutral-300 transition cursor-pointer">
            Clear conversation
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mb-4 p-3 bg-danger/10 border border-danger/30 rounded-lg flex items-start gap-2">
          <svg
            className="w-4 h-4 text-danger flex-shrink-0 mt-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <div className="flex-1">
            <p className="text-sm text-danger">{error}</p>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-danger/60 hover:text-danger transition"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Messages - Flex-grow and scroll */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto mb-4">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-neutral-500">
            <div className="text-center">
              <svg
                className="w-12 h-12 mx-auto mb-3 text-neutral-700"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                />
              </svg>
              <p className="text-sm">Ask questions about your packed repositories</p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, index) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                previousMessage={index > 0 ? messages[index - 1] : undefined}
                isLastMessage={index === messages.length - 1}
                isStreaming={streaming}
                onEdit={(newContent) => handleEdit(index, newContent)}
                onRetry={() => handleRetry(index)}
                onCopy={() => handleCopy(index)}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input - Sticky at bottom */}
      <div className="flex-shrink-0 relative bg-neutral-950 pt-3 border-t border-neutral-800">
        {/* Export Dropdown Menu */}
        {showExportMenu && (
          <div
            ref={exportMenuRef}
            className="absolute left-2 bottom-full mb-2 bg-neutral-900 border border-neutral-800 rounded-xl shadow-lg py-2 min-w-[200px] z-50"
          >
            <button
              onClick={() => handleExportToAI('AI Studio', 'https://aistudio.google.com/prompts/new_chat?model=gemini-2.5-pro')}
              className="w-full px-4 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 transition cursor-pointer flex items-center gap-2"
            >
              <span>✨</span> Copy for AI Studio
            </button>
            <button
              onClick={() => handleExportToAI('Gemini', 'https://gemini.google.com/app')}
              className="w-full px-4 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 transition cursor-pointer flex items-center gap-2"
            >
              <span>💎</span> Copy for Gemini
            </button>
            <button
              onClick={() => handleExportToAI('Claude', 'https://claude.ai/new')}
              className="w-full px-4 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 transition cursor-pointer flex items-center gap-2"
            >
              <span>🤖</span> Copy for Claude
            </button>
            <button
              onClick={() => handleExportToAI('ChatGPT', 'https://chatgpt.com')}
              className="w-full px-4 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 transition cursor-pointer flex items-center gap-2"
            >
              <span>🟢</span> Copy for ChatGPT
            </button>
            <div className="border-t border-neutral-800 my-1" />
            <button
              onClick={handleDownloadTxt}
              className="w-full px-4 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 transition cursor-pointer flex items-center gap-2"
            >
              <span>💾</span> Download .txt
            </button>
          </div>
        )}

        {/* Plus Button */}
        <button
          onClick={() => setShowExportMenu(!showExportMenu)}
          className="absolute left-3 top-1/2 -translate-y-1/2 p-2 text-neutral-400 hover:text-neutral-200 transition cursor-pointer"
          title="Export options"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Gemini"
          className="w-full rounded-xl border border-neutral-800 bg-neutral-900 pl-12 pr-12 py-3 text-sm text-neutral-100 placeholder-neutral-500 transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 resize-none overflow-hidden"
          rows={1}
          disabled={streaming}
        />
        <button
          onClick={() => sendMessage(input)}
          disabled={streaming || !input.trim()}
          className="absolute top-1/2 -translate-y-1/2 right-3 p-2 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
        >
          {streaming ? (
            <svg
              className="w-4 h-4 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          ) : (
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
