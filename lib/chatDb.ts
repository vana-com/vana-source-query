import { openDB, IDBPDatabase } from 'idb'
import { Conversation, Message } from './types'

const DB_NAME = 'vana-chat'
const DB_VERSION = 2 // Incremented for schema change (packHash → id)
const STORE_NAME = 'conversations'

/**
 * IndexedDB wrapper for conversation persistence
 * Conversations are independent of repo selection
 */

let dbPromise: Promise<IDBPDatabase> | null = null

/**
 * Open (or create) the IndexedDB database
 * Singleton pattern - returns the same promise on subsequent calls
 */
async function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1→v2: Recreate store with id as primary key
        if (db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME)
        }
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('lastUpdatedAt', 'lastUpdatedAt')
      },
    })
  }
  return dbPromise
}

/**
 * Generate UUID for conversation ID
 */
function generateId(): string {
  return crypto.randomUUID()
}

/**
 * List all conversations, sorted by most recent first
 */
export async function listConversations(): Promise<Conversation[]> {
  try {
    const db = await getDB()
    const conversations = await db.getAll(STORE_NAME)
    return conversations.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
  } catch (error) {
    console.error('[chatDb] Failed to list conversations:', error)
    return []
  }
}

/**
 * Get a single conversation by ID
 * Returns null if not found
 */
export async function getConversation(id: string): Promise<Conversation | null> {
  try {
    const db = await getDB()
    const conversation = await db.get(STORE_NAME, id)
    return conversation || null
  } catch (error) {
    console.error('[chatDb] Failed to get conversation:', error)
    return null
  }
}

/**
 * Create a new conversation
 * Auto-generates ID and timestamps
 */
export async function createConversation(name?: string): Promise<Conversation> {
  try {
    const db = await getDB()
    const now = Date.now()

    // Auto-generate name if not provided
    const allConversations = await db.getAll(STORE_NAME)
    const defaultName = name || `Chat ${allConversations.length + 1}`

    const conversation: Conversation = {
      id: generateId(),
      name: defaultName,
      messages: [],
      createdAt: now,
      lastUpdatedAt: now,
    }

    await db.put(STORE_NAME, conversation)
    return conversation
  } catch (error) {
    console.error('[chatDb] Failed to create conversation:', error)
    throw error
  }
}

/**
 * Update conversation (name, messages, etc.)
 */
export async function updateConversation(
  id: string,
  updates: Partial<Omit<Conversation, 'id' | 'createdAt'>>
): Promise<void> {
  try {
    const db = await getDB()
    const existing = await db.get(STORE_NAME, id)
    if (!existing) {
      console.warn('[chatDb] Conversation not found:', id)
      return
    }

    const updated: Conversation = {
      ...existing,
      ...updates,
      lastUpdatedAt: Date.now(),
    }

    await db.put(STORE_NAME, updated)
  } catch (error) {
    console.error('[chatDb] Failed to update conversation:', error)
  }
}

/**
 * Add a message to a conversation
 */
export async function addMessage(
  conversationId: string,
  message: Message
): Promise<void> {
  try {
    const db = await getDB()
    const conversation = await db.get(STORE_NAME, conversationId)
    if (!conversation) {
      console.warn('[chatDb] Conversation not found:', conversationId)
      return
    }

    conversation.messages.push(message)
    conversation.lastUpdatedAt = Date.now()

    await db.put(STORE_NAME, conversation)
  } catch (error) {
    console.error('[chatDb] Failed to add message:', error)
  }
}

/**
 * Update all messages in a conversation
 */
export async function saveMessages(
  conversationId: string,
  messages: Message[]
): Promise<void> {
  try {
    await updateConversation(conversationId, { messages })
  } catch (error) {
    console.error('[chatDb] Failed to save messages:', error)
  }
}

/**
 * Delete a conversation
 */
export async function deleteConversation(id: string): Promise<void> {
  try {
    const db = await getDB()
    await db.delete(STORE_NAME, id)
  } catch (error) {
    console.error('[chatDb] Failed to delete conversation:', error)
  }
}

/**
 * Clear all conversations (for testing/debugging)
 */
export async function clearAllConversations(): Promise<void> {
  try {
    const db = await getDB()
    await db.clear(STORE_NAME)
  } catch (error) {
    console.error('[chatDb] Failed to clear conversations:', error)
  }
}
