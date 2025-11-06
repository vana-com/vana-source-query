"use client"

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/**
 * Markdown renderer with syntax highlighting
 * Used for rendering Gemini's responses in chat
 */
export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-full overflow-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Custom styling for code blocks
          code(props) {
            const {node, className, children, ...rest} = props
            const isInline = !className
            return isInline ? (
              <code
                className="px-1.5 py-0.5 rounded bg-neutral-800 text-brand-400 font-mono text-xs break-words"
                {...rest}
              >
                {children}
              </code>
            ) : (
              <code className={`${className} block overflow-x-auto max-w-full`} {...rest}>
                {children}
              </code>
            )
          },
          // Wrap pre blocks for proper overflow
          pre(props) {
            const {node, children, ...rest} = props
            return (
              <pre className="overflow-x-auto max-w-full bg-neutral-900 rounded-lg p-3 my-3" {...rest}>
                {children}
              </pre>
            )
          },
          // Custom styling for links
          a(props) {
            const {node, children, ...rest} = props
            return (
              <a
                className="text-brand-400 hover:text-brand-300 underline"
                target="_blank"
                rel="noopener noreferrer"
                {...rest}
              >
                {children}
              </a>
            )
          },
          // Custom styling for headings
          h1(props) {
            const {node, children, ...rest} = props
            return (
              <h1 className="text-xl font-bold mt-6 mb-3 text-neutral-100" {...rest}>
                {children}
              </h1>
            )
          },
          h2(props) {
            const {node, children, ...rest} = props
            return (
              <h2 className="text-lg font-bold mt-5 mb-2 text-neutral-100" {...rest}>
                {children}
              </h2>
            )
          },
          h3(props) {
            const {node, children, ...rest} = props
            return (
              <h3 className="text-base font-semibold mt-4 mb-2 text-neutral-200" {...rest}>
                {children}
              </h3>
            )
          },
          // Custom styling for lists
          ul(props) {
            const {node, children, ...rest} = props
            return (
              <ul className="list-disc list-inside space-y-1 my-3 text-neutral-300" {...rest}>
                {children}
              </ul>
            )
          },
          ol(props) {
            const {node, children, ...rest} = props
            return (
              <ol className="list-decimal list-inside space-y-1 my-3 text-neutral-300" {...rest}>
                {children}
              </ol>
            )
          },
          // Custom styling for paragraphs
          p(props) {
            const {node, children, ...rest} = props
            return (
              <p className="my-3 text-neutral-300 leading-relaxed break-words" {...rest}>
                {children}
              </p>
            )
          },
          // Custom styling for blockquotes
          blockquote(props) {
            const {node, children, ...rest} = props
            return (
              <blockquote
                className="border-l-4 border-brand-600 pl-4 my-3 text-neutral-400 italic"
                {...rest}
              >
                {children}
              </blockquote>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
