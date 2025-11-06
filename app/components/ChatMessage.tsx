"use client"

import { useState } from 'react'
import { Message } from '@/lib/types'
import { MarkdownRenderer } from './MarkdownRenderer'

interface ChatMessageProps {
  message: Message
  previousMessage?: Message
  isLastMessage: boolean
  isStreaming: boolean
  onEdit: (newContent: string) => void
  onRetry: () => void
  onCopy: () => void
}

/**
 * Individual chat message component
 * Displays user or model messages with appropriate actions
 */
export function ChatMessage({
  message,
  previousMessage,
  isLastMessage,
  isStreaming,
  onEdit,
  onRetry,
  onCopy,
}: ChatMessageProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)
  const [copySuccess, setCopySuccess] = useState(false)

  const handleSaveEdit = () => {
    if (editContent.trim()) {
      onEdit(editContent.trim())
      setIsEditing(false)
    }
  }

  const handleCancelEdit = () => {
    setEditContent(message.content)
    setIsEditing(false)
  }

  const handleCopy = async () => {
    await onCopy()
    setCopySuccess(true)
    setTimeout(() => setCopySuccess(false), 2000)
  }

  if (message.role === 'user') {
    return (
      <div className="mb-6 flex justify-end">
        <div className="flex items-start gap-3 max-w-[80%]">
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <div>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                  rows={3}
                  autoFocus
                />
                <div className="flex gap-2 mt-2">
                  <button onClick={handleSaveEdit} className="btn-primary text-xs cursor-pointer">
                    Save & Regenerate
                  </button>
                  <button onClick={handleCancelEdit} className="btn-secondary text-xs cursor-pointer">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="group text-right">
                <div className="inline-block text-left bg-brand-600/20 rounded-2xl px-4 py-2.5 text-sm text-neutral-200 whitespace-pre-wrap">
                  {message.content}
                </div>
                <button
                  onClick={() => setIsEditing(true)}
                  className="mt-2 text-xs text-neutral-500 hover:text-neutral-300 transition opacity-0 group-hover:opacity-100 cursor-pointer"
                  disabled={isStreaming}
                >
                  ✏️ Edit
                </button>
              </div>
            )}
          </div>
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-white text-sm font-semibold">
            U
          </div>
        </div>
      </div>
    )
  }

  // Model message
  return (
    <div className="mb-6">
      <div className="flex items-start gap-3 max-w-[90%]">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-400 text-sm font-semibold">
          G
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="overflow-hidden">
            <MarkdownRenderer content={message.content} />

            {isStreaming && isLastMessage && (
              <div className="mt-2 flex items-center gap-2 text-xs text-neutral-500">
                <div className="w-2 h-2 bg-brand-500 rounded-full animate-pulse" />
                <span>streaming...</span>
              </div>
            )}

            <div className="flex gap-3 mt-3">
              <button
                onClick={handleCopy}
                className="text-xs text-neutral-500 hover:text-neutral-300 transition flex items-center gap-1 cursor-pointer"
                disabled={isStreaming}
              >
                {copySuccess ? (
                  <>
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                    Copy
                  </>
                )}
              </button>

              <button
                onClick={onRetry}
                className="text-xs text-neutral-500 hover:text-neutral-300 transition flex items-center gap-1 cursor-pointer"
                disabled={isStreaming}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
