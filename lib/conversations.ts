/**
 * Conversation Router
 *
 * Automatically routes conversation operations to either:
 * - IndexedDB (client-side, when not logged in or no database)
 * - API (server-side Postgres, when logged in with database)
 *
 * The caller doesn't need to know which backend is used.
 */

import type { Conversation, Message, RepoSelection } from './types'

// Import IndexedDB functions dynamically to avoid SSR issues
const getIndexedDb = () => import('./chatDb')

/**
 * Check if we should use server-side storage
 * This is called from client components that know auth state
 */
export function shouldUseServerStorage(isAuthenticated: boolean): boolean {
  const hasDatabase = process.env.NEXT_PUBLIC_HAS_DATABASE === 'true'
  return hasDatabase && isAuthenticated
}

/**
 * List all conversations
 */
export async function listConversations(
  isAuthenticated: boolean
): Promise<Conversation[]> {
  if (shouldUseServerStorage(isAuthenticated)) {
    const res = await fetch('/api/conversations')
    if (!res.ok) {
      const error = await res.json()
      throw new Error(error.error || 'Failed to list conversations')
    }
    const data = await res.json()
    return data.conversations
  }

  const idb = await getIndexedDb()
  return idb.listConversations()
}

/**
 * Get a single conversation
 */
export async function getConversation(
  id: string,
  isAuthenticated: boolean
): Promise<Conversation | null> {
  if (shouldUseServerStorage(isAuthenticated)) {
    const res = await fetch(`/api/conversations/${id}`)
    if (res.status === 404) return null
    if (!res.ok) {
      const error = await res.json()
      throw new Error(error.error || 'Failed to get conversation')
    }
    const data = await res.json()
    return data.conversation
  }

  const idb = await getIndexedDb()
  return idb.getConversation(id)
}

/**
 * Create a new conversation
 */
export async function createConversation(
  isAuthenticated: boolean,
  name?: string,
  repoSelections?: RepoSelection[]
): Promise<Conversation> {
  if (shouldUseServerStorage(isAuthenticated)) {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, repoSelections }),
    })
    if (!res.ok) {
      const error = await res.json()
      throw new Error(error.error || 'Failed to create conversation')
    }
    const data = await res.json()
    return data.conversation
  }

  const idb = await getIndexedDb()
  return idb.createConversation(name)
}

/**
 * Update a conversation
 */
export async function updateConversation(
  id: string,
  isAuthenticated: boolean,
  updates: {
    name?: string
    messages?: Message[]
    repoSelections?: RepoSelection[]
    tokenUsage?: Conversation['tokenUsage']
  }
): Promise<void> {
  if (shouldUseServerStorage(isAuthenticated)) {
    const res = await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) {
      const error = await res.json()
      throw new Error(error.error || 'Failed to update conversation')
    }
    return
  }

  const idb = await getIndexedDb()
  await idb.updateConversation(id, updates)
}

/**
 * Add a message to a conversation
 */
export async function addMessage(
  conversationId: string,
  message: Message,
  isAuthenticated: boolean
): Promise<void> {
  if (shouldUseServerStorage(isAuthenticated)) {
    // For server storage, we fetch current messages and append
    // This could be optimized with a dedicated endpoint
    const conversation = await getConversation(conversationId, isAuthenticated)
    if (!conversation) {
      throw new Error('Conversation not found')
    }
    await updateConversation(conversationId, isAuthenticated, {
      messages: [...conversation.messages, message],
    })
    return
  }

  const idb = await getIndexedDb()
  await idb.addMessage(conversationId, message)
}

/**
 * Save all messages (replace)
 */
export async function saveMessages(
  conversationId: string,
  messages: Message[],
  isAuthenticated: boolean
): Promise<void> {
  if (shouldUseServerStorage(isAuthenticated)) {
    await updateConversation(conversationId, isAuthenticated, { messages })
    return
  }

  const idb = await getIndexedDb()
  await idb.saveMessages(conversationId, messages)
}

/**
 * Delete a conversation
 */
export async function deleteConversation(
  id: string,
  isAuthenticated: boolean
): Promise<void> {
  if (shouldUseServerStorage(isAuthenticated)) {
    const res = await fetch(`/api/conversations/${id}`, {
      method: 'DELETE',
    })
    if (!res.ok && res.status !== 404) {
      const error = await res.json()
      throw new Error(error.error || 'Failed to delete conversation')
    }
    return
  }

  const idb = await getIndexedDb()
  await idb.deleteConversation(id)
}

/**
 * Clear all conversations
 */
export async function clearAllConversations(isAuthenticated: boolean): Promise<void> {
  if (shouldUseServerStorage(isAuthenticated)) {
    // Would need a dedicated endpoint for this
    // For now, list and delete each
    const conversations = await listConversations(isAuthenticated)
    await Promise.all(conversations.map((c) => deleteConversation(c.id, isAuthenticated)))
    return
  }

  const idb = await getIndexedDb()
  await idb.clearAllConversations()
}
