"use client"

import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

/**
 * Code block with copy button and language label
 */
function CodeBlock({
  code,
  language,
  children
}: {
  code: string
  language?: string
  children?: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative group">
      {/* Language label and copy button */}
      <div className="flex items-center justify-between px-4 py-2 bg-card border border-border border-b-0 rounded-t-lg">
        <span className="text-xs text-muted-foreground font-mono">
          {language || 'text'}
        </span>
        <button
          onClick={handleCopy}
          className="text-xs text-muted-foreground hover:text-foreground transition flex items-center gap-1.5 cursor-pointer"
        >
          {copied ? (
            <>
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
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
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
      </div>
      {/* Code content - render highlighted children directly */}
      <pre className="!mt-0 bg-card border border-border rounded-b-lg p-4 overflow-x-auto">
        {children}
      </pre>
    </div>
  )
}

/**
 * Parse incomplete markdown formatting during streaming
 * Auto-closes bold, italic, strikethrough, inline code
 */
function parseIncompleteMarkdown(text: string): string {
  let result = text

  // Count unclosed bold markers
  const boldCount = (result.match(/\*\*/g) || []).length
  if (boldCount % 2 !== 0) result += '**'

  // Count unclosed italic markers
  const italicCount = (result.match(/(?<!\*)\*(?!\*)/g) || []).length
  if (italicCount % 2 !== 0) result += '*'

  // Count unclosed strikethrough markers
  const strikeCount = (result.match(/~~/g) || []).length
  if (strikeCount % 2 !== 0) result += '~~'

  // Count unclosed inline code markers
  const codeCount = (result.match(/`/g) || []).length
  if (codeCount % 2 !== 0) result += '`'

  return result
}

/**
 * Markdown renderer optimized for chat UI readability
 * Prioritizes density and scannability over blog-post aesthetics
 * Custom styling matches ChatGPT/Claude/Gemini readability patterns
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  isStreaming = false
}: {
  content: string
  isStreaming?: boolean
}) {
  // Auto-close incomplete formatting during streaming
  const processedContent = isStreaming ? parseIncompleteMarkdown(content) : content

  return (
    <div className="text-foreground text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          // Headings: Clear hierarchy without dominating
          h1: ({ node, ...props }) => (
            <h1 className="text-lg font-semibold text-foreground mt-4 mb-2 first:mt-0" {...props} />
          ),
          h2: ({ node, ...props }) => (
            <h2 className="text-base font-semibold text-foreground mt-3 mb-2 first:mt-0" {...props} />
          ),
          h3: ({ node, ...props }) => (
            <h3 className="text-sm font-semibold text-foreground mt-3 mb-1.5 first:mt-0" {...props} />
          ),

          // Paragraphs: Moderate spacing, not blog-generous
          p: ({ node, ...props }) => (
            <p className="mb-3 last:mb-0 leading-normal [li>&]:mb-0 break-words" {...props} />
          ),

          // Lists: TIGHT spacing like ChatGPT/Claude
          ol: ({ node, ...props }) => (
            <ol className="list-decimal list-outside ml-6 my-2 space-y-0.5" {...props} />
          ),
          ul: ({ node, ...props }) => (
            <ul className="list-disc list-outside ml-6 my-2 space-y-0.5" {...props} />
          ),
          li: ({ node, children, ...props }) => {
            // Check if this is a task list item (GFM checkbox)
            const childArray = Array.isArray(children) ? children : [children]
            const firstChild = childArray[0]
            const isTaskList =
              firstChild &&
              typeof firstChild === 'object' &&
              'props' in firstChild &&
              (firstChild as any).props?.type === 'checkbox'

            if (isTaskList) {
              return (
                <li className="flex items-start gap-2 pl-1 leading-normal list-none -ml-6" {...props}>
                  {children}
                </li>
              )
            }
            return <li className="pl-1 leading-normal [&>p]:mb-0" {...props}>{children}</li>
          },
          // Task list checkboxes (GFM)
          input: ({ node, ...props }) => {
            if (props.type === 'checkbox') {
              return (
                <input
                  type="checkbox"
                  disabled
                  className="mt-1 rounded border-border bg-secondary text-brand-500 focus:ring-0 cursor-not-allowed"
                  {...props}
                />
              )
            }
            return <input {...props} />
          },

          // Code blocks: With copy button and language label
          pre: ({ children }) => {
            // Extract raw code and language from the code element
            const codeElement = children as any
            const className = codeElement?.props?.className || ''
            const language = className.replace('language-', '')

            // Extract raw text recursively from React elements
            const extractText = (node: any): string => {
              if (typeof node === 'string') return node
              if (typeof node === 'number') return String(node)
              if (Array.isArray(node)) return node.map(extractText).join('')
              if (node?.props?.children) return extractText(node.props.children)
              return ''
            }

            const rawCode = extractText(codeElement?.props?.children || '').trim()

            return <CodeBlock code={rawCode} language={language}>{children}</CodeBlock>
          },
          code: ({ node, className, children, ...props }) => {
            const isInline = !className
            return isInline ? (
              <code className="bg-secondary/60 text-foreground px-1 py-0.5 rounded text-xs font-mono break-words" {...props}>
                {children}
              </code>
            ) : (
              // Block code is handled by pre component
              <code className={className} {...props}>{children}</code>
            )
          },

          // Links: Secure and visible
          a: ({ node, ...props }) => (
            <a
              className="text-brand-400 hover:text-brand-300 underline underline-offset-2 break-all"
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            />
          ),

          // Blockquotes: Subtle but clear
          blockquote: ({ node, ...props }) => (
            <blockquote className="border-l-3 border-border pl-3 my-2 text-muted-foreground italic" {...props} />
          ),

          // Tables: GFM support
          table: ({ node, ...props }) => (
            <div className="my-3 overflow-x-auto">
              <table className="min-w-full border-collapse" {...props} />
            </div>
          ),
          th: ({ node, ...props }) => (
            <th className="border border-border bg-card px-3 py-1.5 text-left font-semibold" {...props} />
          ),
          td: ({ node, ...props }) => (
            <td className="border border-border px-3 py-1.5" {...props} />
          ),

          // Horizontal rule
          hr: ({ node, ...props }) => (
            <hr className="border-border my-4" {...props} />
          ),

          // Strong/Bold: Proper weight
          strong: ({ node, ...props }) => (
            <strong className="font-semibold text-foreground" {...props} />
          ),

          // Emphasis/Italic
          em: ({ node, ...props }) => (
            <em className="italic text-foreground" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
