/**
 * Conversations API
 *
 * GET  /api/conversations - List all conversations for authenticated user
 * POST /api/conversations - Create a new conversation
 */

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import * as conversationsDb from '@/lib/db/conversations.server'
import type { RepoSelection } from '@/lib/types'

export const runtime = 'nodejs'

/**
 * List all conversations for authenticated user
 */
export async function GET() {
  try {
    const session = await auth()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const conversations = await conversationsDb.listConversations(session.user.id)

    return NextResponse.json({ conversations })
  } catch (error) {
    console.error('[api/conversations] GET error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list conversations' },
      { status: 500 }
    )
  }
}

/**
 * Create a new conversation
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { name, repoSelections } = body as {
      name?: string
      repoSelections?: RepoSelection[]
    }

    const conversation = await conversationsDb.createConversation(
      session.user.id,
      name,
      repoSelections
    )

    return NextResponse.json({ conversation }, { status: 201 })
  } catch (error) {
    console.error('[api/conversations] POST error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create conversation' },
      { status: 500 }
    )
  }
}
