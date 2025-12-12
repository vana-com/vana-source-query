'use client'

import { SessionProvider } from 'next-auth/react'
import { ReactNode } from 'react'

/**
 * Auth Provider wrapper for NextAuth SessionProvider.
 * Always wrap with SessionProvider so useSession hook works.
 * When DATABASE_URL is not set, session will always be unauthenticated.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>
}
