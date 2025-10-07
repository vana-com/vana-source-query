import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Vana Source Query',
  description: 'Ask smart questions across selected GitHub repos. Pack multiple repos with Repomix and count tokens with Gemini.',
  manifest: '/manifest.json',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
