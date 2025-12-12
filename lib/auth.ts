/**
 * NextAuth.js Configuration
 *
 * GitHub OAuth provider for authentication.
 * Stores access_token in session for GitHub API calls.
 *
 * Only used when DATABASE_URL is set (server mode).
 */

import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { prisma, isServerMode } from './prisma'

// Extend session type to include accessToken
declare module 'next-auth' {
  interface Session {
    accessToken?: string
    user: {
      id: string
      name?: string | null
      email?: string | null
      image?: string | null
      githubLogin?: string | null
    }
  }
}

// Create NextAuth config only if we have a database
function createNextAuth() {
  if (!isServerMode || !prisma) {
    // Return null handlers for client-only mode
    return {
      handlers: {
        GET: async () => new Response('Auth not configured', { status: 404 }),
        POST: async () => new Response('Auth not configured', { status: 404 }),
      },
      auth: null as any,
      signIn: null as any,
      signOut: null as any,
    }
  }

  return NextAuth({
    adapter: PrismaAdapter(prisma),
    providers: [
      GitHub({
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        authorization: {
          params: {
            // Request repo scope for private repo access
            scope: 'read:user user:email repo',
          },
        },
      }),
    ],
    callbacks: {
      async signIn({ user, account, profile }) {
        // Store GitHub-specific fields on user
        // Note: On first sign-in, user may not exist yet (adapter creates it after)
        // So we use upsert-like logic with a try/catch
        if (account?.provider === 'github' && profile && prisma && user.id) {
          const githubProfile = profile as unknown as { id: number; login: string }
          try {
            await prisma.user.update({
              where: { id: user.id },
              data: {
                githubId: githubProfile.id,
                githubLogin: githubProfile.login,
              },
            })
          } catch {
            // User doesn't exist yet - will be created by adapter
            // We'll update on next sign-in, or use a different approach
            console.log('[auth] User not yet created, skipping GitHub profile update')
          }
        }
        return true
      },
      async session({ session, user }) {
        // Add user ID to session
        session.user.id = user.id

        // Fetch GitHub access token from account
        if (prisma) {
          const account = await prisma.account.findFirst({
            where: {
              userId: user.id,
              provider: 'github',
            },
            select: {
              access_token: true,
            },
          })

          if (account?.access_token) {
            session.accessToken = account.access_token
          }

          // Fetch GitHub login
          const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { githubLogin: true },
          })
          if (dbUser?.githubLogin) {
            session.user.githubLogin = dbUser.githubLogin
          }
        }

        return session
      },
    },
    session: {
      strategy: 'database',
      maxAge: 30 * 24 * 60 * 60, // 30 days
    },
    pages: {
      signIn: '/auth/signin',
      error: '/auth/error',
    },
  })
}

const nextAuth = createNextAuth()

export const { handlers, auth, signIn, signOut } = nextAuth
