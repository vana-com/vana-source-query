/**
 * Server-side Conversations (Postgres)
 *
 * Per-user conversation storage. Requires authentication.
 */

import { prisma } from '../prisma'
import type { Conversation, Message, RepoSelection } from '../types'

/**
 * List all conversations for a user
 */
export async function listConversations(userId: string): Promise<Conversation[]> {
  if (!prisma) {
    throw new Error('Database not available')
  }

  try {
    const conversations = await prisma.conversation.findMany({
      where: { userId },
      orderBy: { lastUpdatedAt: 'desc' },
    })

    return conversations.map(dbToConversation)
  } catch (error) {
    console.error('[conversations.server] listConversations failed:', error)
    throw error
  }
}

/**
 * Get a single conversation
 */
export async function getConversation(
  id: string,
  userId: string
): Promise<Conversation | null> {
  if (!prisma) {
    throw new Error('Database not available')
  }

  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id, userId },
    })

    return conversation ? dbToConversation(conversation) : null
  } catch (error) {
    console.error('[conversations.server] getConversation failed:', error)
    throw error
  }
}

/**
 * Create a new conversation
 */
export async function createConversation(
  userId: string,
  name?: string,
  repoSelections?: RepoSelection[]
): Promise<Conversation> {
  if (!prisma) {
    throw new Error('Database not available')
  }

  try {
    // Auto-generate name if not provided
    const count = await prisma.conversation.count({ where: { userId } })
    const defaultName = name || `Chat ${count + 1}`

    const conversation = await prisma.conversation.create({
      data: {
        userId,
        name: defaultName,
        messages: JSON.parse(JSON.stringify([])),
        repoSelections: repoSelections ? JSON.parse(JSON.stringify(repoSelections)) : undefined,
      },
    })

    return dbToConversation(conversation)
  } catch (error) {
    console.error('[conversations.server] createConversation failed:', error)
    throw error
  }
}

/**
 * Update conversation
 */
export async function updateConversation(
  id: string,
  userId: string,
  updates: {
    name?: string
    messages?: Message[]
    repoSelections?: RepoSelection[]
    tokenUsage?: Conversation['tokenUsage']
  }
): Promise<Conversation | null> {
  if (!prisma) {
    throw new Error('Database not available')
  }

  try {
    // Verify ownership
    const existing = await prisma.conversation.findFirst({
      where: { id, userId },
    })

    if (!existing) {
      return null
    }

    const conversation = await prisma.conversation.update({
      where: { id },
      data: {
        ...(updates.name !== undefined && { name: updates.name }),
        ...(updates.messages !== undefined && {
          messages: JSON.parse(JSON.stringify(updates.messages)),
        }),
        ...(updates.repoSelections !== undefined && {
          repoSelections: JSON.parse(JSON.stringify(updates.repoSelections)),
        }),
        ...(updates.tokenUsage !== undefined && {
          tokenUsage: JSON.parse(JSON.stringify(updates.tokenUsage)),
        }),
      },
    })

    return dbToConversation(conversation)
  } catch (error) {
    console.error('[conversations.server] updateConversation failed:', error)
    throw error
  }
}

/**
 * Add a message to a conversation
 */
export async function addMessage(
  conversationId: string,
  userId: string,
  message: Message
): Promise<Conversation | null> {
  if (!prisma) {
    throw new Error('Database not available')
  }

  try {
    // Fetch existing, verify ownership
    const existing = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
    })

    if (!existing) {
      return null
    }

    const messages = (existing.messages as unknown as Message[]) || []
    messages.push(message)

    const conversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: { messages: JSON.parse(JSON.stringify(messages)) },
    })

    return dbToConversation(conversation)
  } catch (error) {
    console.error('[conversations.server] addMessage failed:', error)
    throw error
  }
}

/**
 * Delete a conversation
 */
export async function deleteConversation(id: string, userId: string): Promise<boolean> {
  if (!prisma) {
    throw new Error('Database not available')
  }

  try {
    // Verify ownership before delete
    const existing = await prisma.conversation.findFirst({
      where: { id, userId },
    })

    if (!existing) {
      return false
    }

    await prisma.conversation.delete({
      where: { id },
    })

    return true
  } catch (error) {
    console.error('[conversations.server] deleteConversation failed:', error)
    throw error
  }
}

/**
 * Delete all conversations for a user
 */
export async function clearAllConversations(userId: string): Promise<number> {
  if (!prisma) {
    throw new Error('Database not available')
  }

  try {
    const result = await prisma.conversation.deleteMany({
      where: { userId },
    })

    return result.count
  } catch (error) {
    console.error('[conversations.server] clearAllConversations failed:', error)
    throw error
  }
}

/**
 * Convert database record to Conversation type
 */
function dbToConversation(record: {
  id: string
  name: string
  messages: unknown
  repoSelections: unknown
  tokenUsage: unknown
  createdAt: Date
  lastUpdatedAt: Date
}): Conversation {
  return {
    id: record.id,
    name: record.name,
    messages: (record.messages as Message[]) || [],
    repoSelections: (record.repoSelections as RepoSelection[]) || undefined,
    tokenUsage: (record.tokenUsage as Conversation['tokenUsage']) || undefined,
    createdAt: record.createdAt.getTime(),
    lastUpdatedAt: record.lastUpdatedAt.getTime(),
  }
}
