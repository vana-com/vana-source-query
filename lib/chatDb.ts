import { openDB, IDBPDatabase } from 'idb'
import { ConversationRecord, Message } from './types'

const DB_NAME = 'vana-chat'
const DB_VERSION = 1
const STORE_NAME = 'conversations'

/**
 * IndexedDB wrapper for chat conversation persistence
 * Uses idb library (Promise-based wrapper) for clean async API
 */

let dbPromise: Promise<IDBPDatabase> | null = null

/**
 * Open (or create) the IndexedDB database
 * Singleton pattern - returns the same promise on subsequent calls
 */
async function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Create object store with packHash as primary key
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'packHash' })
        }
      },
    })
  }
  return dbPromise
}

/**
 * Save conversation to IndexedDB
 * Overwrites existing conversation with same packHash
 */
export async function saveConversation(
  packHash: string,
  messages: Message[],
  contextSize: number
): Promise<void> {
  try {
    const db = await getDB()
    const record: ConversationRecord = {
      packHash,
      messages,
      lastUpdated: Date.now(),
      contextSize,
    }
    await db.put(STORE_NAME, record)
  } catch (error) {
    console.error('[chatDb] Failed to save conversation:', error)
    // Don't throw - persistence failure shouldn't break the app
  }
}

/**
 * Load conversation from IndexedDB
 * Returns null if not found
 */
export async function loadConversation(
  packHash: string
): Promise<Message[] | null> {
  try {
    const db = await getDB()
    const record = await db.get(STORE_NAME, packHash)
    return record?.messages || null
  } catch (error) {
    console.error('[chatDb] Failed to load conversation:', error)
    return null
  }
}

/**
 * Delete conversation from IndexedDB
 */
export async function deleteConversation(packHash: string): Promise<void> {
  try {
    const db = await getDB()
    await db.delete(STORE_NAME, packHash)
  } catch (error) {
    console.error('[chatDb] Failed to delete conversation:', error)
    // Don't throw - deletion failure shouldn't break the app
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
