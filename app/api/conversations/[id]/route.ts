/**
 * Single Conversation API
 *
 * GET    /api/conversations/[id] - Get a conversation
 * PATCH  /api/conversations/[id] - Update a conversation
 * DELETE /api/conversations/[id] - Delete a conversation
 */

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import * as conversationsDb from '@/lib/db/conversations.server'
import type { Message, RepoSelection, Conversation } from '@/lib/types'

export const runtime = 'nodejs'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * Get a single conversation
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const conversation = await conversationsDb.getConversation(id, session.user.id)

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    return NextResponse.json({ conversation })
  } catch (error) {
    console.error('[api/conversations/[id]] GET error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get conversation' },
      { status: 500 }
    )
  }
}

/**
 * Update a conversation
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const body = await req.json()
    const { name, messages, repoSelections, tokenUsage } = body as {
      name?: string
      messages?: Message[]
      repoSelections?: RepoSelection[]
      tokenUsage?: Conversation['tokenUsage']
    }

    const conversation = await conversationsDb.updateConversation(id, session.user.id, {
      name,
      messages,
      repoSelections,
      tokenUsage,
    })

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    return NextResponse.json({ conversation })
  } catch (error) {
    console.error('[api/conversations/[id]] PATCH error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update conversation' },
      { status: 500 }
    )
  }
}

/**
 * Delete a conversation
 */
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const deleted = await conversationsDb.deleteConversation(id, session.user.id)

    if (!deleted) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[api/conversations/[id]] DELETE error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete conversation' },
      { status: 500 }
    )
  }
}
