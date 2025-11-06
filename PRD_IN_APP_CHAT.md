# PRD: In-App Chat with Gemini

**Status**: Draft v2
**Target**: v1.1
**Author**: PM
**Date**: 2025-11-05

---

## The Problem

Right now, after packing repos, you have to:
1. Copy the massive context
2. Open AI Studio in a new tab
3. Wait for paste to complete
4. Ask your question
5. **Repeat all this for every follow-up question**

This sucks. You lose flow, you lose the repo structure view, and it's slow.

## The Solution

**Add a chat interface directly in the app.** After packing, you can immediately ask questions and get answers without ever leaving. Follow-up questions just work, instantly, using Gemini's context caching (which makes them basically free).

## Core Value

**"Ask 10 questions in the time it currently takes to ask 1"**

Not about saving money. About staying in flow.

## TL;DR - What We Decided

After ultrathinking:

**Persistence**: IndexedDB with pack hash key
- Same pack = conversation continues (even after refresh)
- Different pack = auto-clears (new context = fresh start)
- Proper database (not localStorage string limits)

**Edit**: ChatGPT-style tree deletion
- Edit message N → deletes messages N+1 onwards
- Clean, predictable, no stale answers

**Retry**: Regenerates single response
- Keeps subsequent messages (they reference new answer)
- Less destructive than edit

**Copy**: Formatted for sharing
- Q&A format with markdown
- Ready to paste in Slack/docs

**Scope**: All in v1.1
- Not splitting across releases
- Ship complete feature, validate adoption

---

## What We're Building (v1.1 MVP)

### The Feature

After you pack repos, a chat interface appears below the token meter:

```
┌─────────────────────────────────────────────────────┐
│ [500K / 1M tokens] ●●●●●●○○ (60%)                   │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Chat                                    [Clear] [×] │
│                                                     │
│  You: How does auth work?              [✏️ Edit]   │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ Gemini: Auth uses JWT. Login flow starts at  │ │
│  │ lib/auth.ts:42. Here's how it works:         │ │
│  │                                               │ │
│  │ 1. User hits /api/auth/login...              │ │
│  │                                               │ │
│  │                         [📋 Copy] [🔄 Retry]  │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  You: What about refresh tokens?       [✏️ Edit]   │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ Gemini: Refresh tokens are stored in...      │ │
│  │ [streaming...]                                │ │
│  │                         [📋 Copy] [🔄 Retry]  │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  [Type a message...]                      [Send]   │
└─────────────────────────────────────────────────────┘
```

### What It Does

- **Streams responses** as they're generated (feels fast)
- **Persists to IndexedDB** (survives page refresh, unlimited storage)
- **Auto-caches context** so follow-ups are instant
- **Renders markdown** with syntax highlighting for code
- **Copy button** on every message (share answers with team)
- **Edit previous messages** and regenerate responses (ChatGPT-style)
- **Stays simple** - no multi-model nonsense, no analytics bloat

### What It Doesn't Do (v1.1)

- ❌ Support multiple models (just Gemini Flash/Pro)
- ❌ Persist across different pack sessions (new pack = fresh start)
- ❌ Share conversations via URL
- ❌ Branch conversations or manage conversation history

---

## Technical Design

### API Endpoint

**`POST /api/chat`**

Request:
```typescript
{
  contextText: string,           // The packed repos
  userMessage: string,           // What they're asking
  conversationHistory?: Array<{  // Previous messages (optional)
    role: "user" | "model",
    content: string
  }>
}
```

Response: Server-Sent Events stream

```
data: {"type":"chunk","text":"Auth uses JWT"}
data: {"type":"chunk","text":" tokens. Here's how"}
data: {"type":"chunk","text":" it works:"}
data: {"type":"complete"}
```

### Implementation

**Backend** (`app/api/chat/route.ts`):
```typescript
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { contextText, userMessage, conversationHistory } = await req.json()

  const apiKey = req.headers.get('x-gemini-key') || process.env.GEMINI_API_KEY
  const client = createGeminiClient(apiKey)

  // Stream response chunks
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of client.chat('gemini-2.5-flash', contextText, userMessage)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({type:'chunk',text:chunk})}\n\n`))
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({type:'complete'})}\n\n`))
      controller.close()
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    }
  })
}
```

**Frontend** (`app/components/Chat.tsx`):
```typescript
interface Message {
  id: string
  role: 'user' | 'model'
  content: string
  timestamp: number
}

function Chat({ packedContext, packHash }: { packedContext: string; packHash: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Load from IndexedDB on mount
  useEffect(() => {
    async function loadConversation() {
      const db = await openDB('vana-chat', 1, {
        upgrade(db) {
          db.createObjectStore('conversations', { keyPath: 'packHash' })
        }
      })

      const stored = await db.get('conversations', packHash)
      if (stored) {
        setMessages(stored.messages)
      }
    }

    loadConversation()
  }, [packHash])

  // Save to IndexedDB whenever messages change
  useEffect(() => {
    async function saveConversation() {
      if (messages.length === 0) return // Don't save empty

      const db = await openDB('vana-chat', 1)
      await db.put('conversations', {
        packHash,
        messages,
        lastUpdated: Date.now(),
        contextSize: packedContext.length
      })
    }

    saveConversation()
  }, [messages, packHash, packedContext])

  const sendMessage = async (content: string, messageIndex?: number) => {
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now()
    }

    // If editing, delete all messages after this point
    if (messageIndex !== undefined) {
      setMessages(prev => [...prev.slice(0, messageIndex), userMsg])
    } else {
      setMessages(prev => [...prev, userMsg])
    }

    setInput('')
    setStreaming(true)

    // Add placeholder for model response
    const modelMsg: Message = { id: crypto.randomUUID(), role: 'model', content: '', timestamp: Date.now() }
    setMessages(prev => [...prev, modelMsg])

    // Stream response
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contextText: packedContext,
        userMessage: content,
        conversationHistory: messages.slice(0, messageIndex)
      })
    })

    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value)
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '))

      for (const line of lines) {
        const data = JSON.parse(line.slice(6))
        if (data.type === 'chunk') {
          setMessages(prev => {
            const updated = [...prev]
            updated[updated.length - 1].content += data.text
            return updated
          })
        } else if (data.type === 'complete') {
          setStreaming(false)
        }
      }
    }
  }

  const handleEdit = (messageIndex: number, newContent: string) => {
    sendMessage(newContent, messageIndex)
    setEditingId(null)
  }

  const handleRetry = (messageIndex: number) => {
    // Get the user message before this model response
    const userMessage = messages[messageIndex - 1]
    if (userMessage && userMessage.role === 'user') {
      // Keep messages up to and including the user message
      setMessages(prev => prev.slice(0, messageIndex))
      sendMessage(userMessage.content, messageIndex - 1)
    }
  }

  const handleCopy = (message: Message, userMessage?: Message) => {
    const text = userMessage
      ? `**Q:** ${userMessage.content}\n\n**A:** ${message.content}`
      : message.content
    navigator.clipboard.writeText(text)
  }

  const handleClear = async () => {
    setMessages([])

    const db = await openDB('vana-chat', 1)
    await db.delete('conversations', packHash)
  }

  return (
    <div className="chat">
      <div className="header">
        <h3>Chat</h3>
        <button onClick={handleClear}>Clear</button>
      </div>
      <div className="messages">
        {messages.map((msg, i) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            onEdit={() => setEditingId(msg.id)}
            onRetry={() => handleRetry(i)}
            onCopy={() => handleCopy(msg, i > 0 ? messages[i-1] : undefined)}
            isEditing={editingId === msg.id}
            onSaveEdit={(content) => handleEdit(i, content)}
          />
        ))}
      </div>
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && !streaming && sendMessage(input)}
        placeholder="Ask a question..."
        disabled={streaming}
      />
    </div>
  )
}
```

### Context Caching

**How it works**: Gemini 2.5 automatically caches repeated context (contexts >1024 tokens). No code needed.

**What this means**:
- First question: Processes full 500K token context
- Follow-up questions: Uses cached context, only processes new message (~20 tokens)
- Result: Follow-ups are instant and cheap

**Do we need to do anything?** Nope. It just works.

**Impact of Edit on Caching:**
- Editing changes conversation history (slightly)
- But context (500K tokens) stays identical
- Cache hit still works because context >> history (500K vs 20 tokens)
- Result: Edits don't break performance

---

## UX Details

### When Chat Appears & Persistence

**Visibility:**
- **Before packing**: Not visible
- **While packing**: Not visible (don't distract)
- **After successful pack**: Chat interface appears below token meter

**Persistence Strategy (IndexedDB):**

Conversations persist in browser database:

```typescript
// Database schema
{
  db: 'vana-chat',
  store: 'conversations',
  keyPath: 'packHash',
  record: {
    packHash: string,     // Primary key: hash of repos + filters
    messages: Message[],  // Array of chat messages
    lastUpdated: number,  // Timestamp
    contextSize: number   // Token count (for reference)
  }
}
```

**Behavior:**
- **Page refresh**: Query by current packHash → restore if exists
- **Re-pack same repos/filters**: Same packHash → conversation continues
- **Re-pack different repos/filters**: Different packHash → fresh conversation
- **User clicks "Clear"**: Delete record for current packHash

**Why IndexedDB over localStorage?**
- ✅ No 5MB limit (conversations can grow indefinitely)
- ✅ Asynchronous (doesn't block UI)
- ✅ Structured storage (no JSON.stringify overhead)
- ✅ Can add indexes later (e.g., search by date, repo name)
- ✅ Could support multiple conversations per pack in future
- ❌ Slightly more complex API (use Dexie.js wrapper to simplify)

**Why packHash as primary key?**
- Automatic lifecycle: different pack = different key = fresh start
- No manual cleanup needed
- Can't accidentally mix conversations from different contexts

### Handling Errors

**Context too large** (>1M tokens for Flash):
- Disable chat input
- Show: "Context too large. Reduce files or switch to Gemini Pro (2M limit)"

**Gemini API error**:
- Show error in chat: "⚠️ Error: [message]. Retry?"
- Don't clear conversation

**Network drops mid-stream**:
- Show partial response
- Add: "⚠️ Connection lost" badge
- Provide "Retry" button

### Edit & Regenerate Flow

**Edit a user message:**
1. Click "✏️ Edit" on any user message
2. Message becomes editable inline (textarea)
3. User edits, presses Enter or clicks "Save"
4. **All messages after this point are deleted** (prevents stale context)
5. Edited message sent as new request
6. Stream new response

**Why delete subsequent messages?**
- Avoids confusion (old answers to old questions)
- ChatGPT-style UX (users expect this)
- Clean conversation tree (no branching complexity)

**Retry a model response:**
1. Click "🔄 Retry" on any model response
2. Resend the same user message that triggered it
3. Stream new response, replace old one
4. Subsequent messages stay intact (only regenerating this one response)

**Edge case - retry changes all follow-ups?**
- No. Retry only replaces that specific response.
- Follow-up messages reference the NEW response in conversation history sent to Gemini
- Gemini's context caching handles this fine (history is tiny vs context)

### Copy Button Behavior

**What gets copied:**
```markdown
**Q:** How does auth work?

**A:** Auth uses JWT. Login flow starts at lib/auth.ts:42...
```

**Why this format:**
- Readable in Slack, email, docs
- Includes question for context
- Markdown formatting preserved
- No app-specific metadata (timestamps, IDs, etc.)

**Copy all conversation:**
- "Download Chat" button at bottom
- Saves as `conversation-{timestamp}.md`
- All Q&A pairs in sequence

### Nice-to-Haves (v1.2+)

- [ ] Download conversation as markdown
- [ ] Jump to file reference links (if Gemini mentions `lib/auth.ts:42`, make it clickable)
- [ ] Conversation search (Cmd+F within chat)
- [ ] Model switcher (Flash ↔ Pro)
- [ ] System instructions field (tell Gemini how to respond)

---

## Open Questions

### Q1: Show token counts in chat?

**Options**:
1. Show per message: "Input: 500K | Output: 1.2K"
2. Show total at bottom: "Conversation: 520K tokens"
3. Don't show (simplify)

**Recommendation**: Option 3 for v1.1. Token meter already shows context size. People just want answers.

---

### Q2: Model selector?

**Options**:
1. Fixed to Flash (simple, cheap, fast)
2. Dropdown: Flash vs Pro (for >1M contexts)
3. Auto-switch to Pro if context >1M

**Recommendation**: Option 3. Smart default, no UI clutter.

---

## Testing Plan

### Manual Testing

**Core Flow:**
- [ ] Pack repos → Chat appears
- [ ] Send message → Streaming works, markdown renders
- [ ] Send follow-up → Uses cached context (instant response)
- [ ] Refresh page → Conversation restores
- [ ] Re-pack same repos → Conversation continues
- [ ] Re-pack different repos → Conversation clears

**Edit/Retry:**
- [ ] Edit message #2 in 5-message convo → Messages 3-5 deleted
- [ ] Edit and resend → New response streams
- [ ] Retry a response → Same question resent, new answer
- [ ] Retry in middle of convo → Subsequent messages reference new answer

**Copy:**
- [ ] Copy model response → Includes Q&A format
- [ ] Copy to Slack → Markdown renders correctly
- [ ] Download conversation → All messages exported as .md

**Edge Cases:**
- [ ] Context >1M → Auto-suggests Pro or blocks chat
- [ ] Network drop → Shows error, retry button works
- [ ] Edit while streaming → Prevents edit
- [ ] Long conversation (10+ turns) → Performance OK, localStorage size OK
- [ ] packHash collision (unlikely) → Conversations don't mix

### What We Won't Test

- Edge cases for enterprise scale (not relevant)
- Cross-browser compatibility beyond Chrome/Firefox
- Accessibility (can add later if needed)

---

## Rollout

### Week 1-2: Ship v1.1
- [ ] Add `idb` dependency (`npm install idb`)
- [ ] `POST /api/chat` endpoint with SSE streaming
- [ ] `<Chat>` component with message list
- [ ] IndexedDB persistence (packHash-based, using `idb` wrapper)
- [ ] Edit message (deletes subsequent)
- [ ] Retry response (regenerates)
- [ ] Copy button (Q&A formatted for Slack)
- [ ] Clear conversation button
- [ ] Markdown rendering with syntax highlighting
- [ ] Error handling (network, API, context too large)
- [ ] Manual testing passed (all scenarios above)

### Week 3+: Monitor
- Do people use it? (track chat API calls vs pack calls)
- Average conversation length? (>3 = success)
- Any bugs/complaints?

**Don't build more features until we validate people actually use it.**

---

## Why This Design

### Simple Made Easy
- No server database (IndexedDB in browser, tied to current pack)
- No auth (uses existing Gemini key)
- No branching conversations (ChatGPT-style tree deletion)
- Hash-based persistence (same pack = same conversation, always)
- Uses `idb` library (Jake Archibald's Promise wrapper, 600 bytes)

### Guarantees Over Guesses
- Streaming gives real-time feedback (no "generating..." spinner lies)
- Gemini's caching guarantees follow-ups are fast
- localStorage syncs on every change (no lost edits)
- Clear errors when things fail

### Focuses on Flow
- Chat appears right where you need it (below token meter)
- No tab switching, no external tools
- Edit anywhere, regenerate instantly
- Copy formatted for Slack/docs
- Survives refresh but not re-pack (intentional: new context = new convo)

### What We're NOT Doing
- Not building ChatGPT (no branching, no conversation library)
- Not optimizing costs (caching is automatic, no cost displays)
- Not adding "features" (temperature sliders, system prompts, etc.)
- Not persisting across packs (pack hash changes = conversation clears)

### Key Trade-offs We Made

**IndexedDB vs Server Database:**
- ✅ Zero server infrastructure
- ✅ Fast read/write (async, doesn't block UI)
- ✅ Works offline
- ✅ No size limits (unlike localStorage's 5MB)
- ✅ Structured data, can add indexes later
- ❌ No sharing across devices
- ❌ No team collaboration
- **Decision**: Worth it. This is a dev tool, not a team chat app.

**IndexedDB vs localStorage:**
- ✅ Much larger storage (GBs vs 5MB)
- ✅ Async API (doesn't block main thread)
- ✅ Can store objects directly (no JSON.stringify)
- ✅ Future-proof (can add search, multiple convos, etc.)
- ❌ Slightly more complex (mitigated by `idb` wrapper library)
- **Decision**: IndexedDB. Conversations can get long, localStorage limits would hurt.

**Edit deletes subsequent messages:**
- ✅ Clean, predictable (ChatGPT UX pattern)
- ✅ No stale answers to old questions
- ❌ Lose follow-up messages
- **Decision**: Right call. Preserving stale messages causes confusion.

**Retry only replaces that response:**
- ✅ Less destructive than edit
- ✅ Follow-ups reference new answer automatically
- ❌ Might create contextual inconsistency (rare)
- **Decision**: Matches user expectation ("try that answer again")

**Pack hash determines conversation lifecycle:**
- ✅ Automatic: same pack = continue, different pack = fresh start
- ✅ No user confusion about when to clear
- ❌ Can't have multiple conversations per pack
- **Decision**: Simplicity > flexibility for v1.1

---

## The Core Insight

**The bottleneck isn't cost. It's context switching and manual copy/paste.**

Even if Gemini were free, you'd still want this feature because:
- It keeps you in flow
- Follow-ups are instant (no re-pasting)
- You keep the repo structure visible
- Everything in one place

Context caching is a nice bonus (makes follow-ups instant), but the real win is eliminating the copy/paste dance.

---

## Success = Adoption

**Good outcome**: 30%+ of packs lead to at least one chat message

**Great outcome**: 50%+ of packs lead to multi-turn conversations (3+ messages)

**Failure**: <10% adoption → People still prefer AI Studio

If people don't use it, we either:
1. Shipped the wrong thing (UX is bad)
2. Solved the wrong problem (copy/paste isn't actually painful)
3. Need better discoverability (they don't see the feature)

**How we'll know**: Log ratio of chat API calls to pack API calls. Simple.

---

## Appendix: Technical Notes

### Gemini SDK Already Supports This

The `GeminiClient` class already has a `chat()` method:

```typescript
async *chat(
  modelId: string,
  contextText: string,
  userPrompt: string
): AsyncGenerator<string, void, unknown> {
  const model = this.client.getGenerativeModel({ model: modelId })

  const result = await model.generateContentStream(
    `${contextText}\n\n# User Prompt\n${userPrompt}`
  )

  for await (const chunk of result.stream) {
    const text = chunk.text()
    if (text) yield text
  }
}
```

**We just need to**:
1. Create the API endpoint that calls this
2. Build the frontend to consume the stream
3. Ship it

### Why Server-Sent Events?

- Simple protocol (just `data: {json}\n\n`)
- Native browser support
- One-way server→client (perfect for our use case)
- Works great with Vercel
- No WebSocket complexity

### Why Not WebSockets?

- Don't need two-way communication
- More complex to deploy
- SSE is simpler and sufficient

### IndexedDB Implementation

**Library**: `idb` by Jake Archibald (https://github.com/jakearchibald/idb)
- 600 bytes gzipped
- Promise-based wrapper around IndexedDB API
- Makes IndexedDB as easy as localStorage

**Raw IndexedDB is painful:**
```typescript
// Without idb (yikes)
const request = indexedDB.open('db', 1)
request.onsuccess = (event) => {
  const db = event.target.result
  const transaction = db.transaction(['store'], 'readwrite')
  const store = transaction.objectStore('store')
  const getRequest = store.get(key)
  getRequest.onsuccess = ...
}
```

**With idb (clean):**
```typescript
import { openDB } from 'idb'

const db = await openDB('db', 1, {
  upgrade(db) {
    db.createObjectStore('store', { keyPath: 'id' })
  }
})

const value = await db.get('store', key)
```

**For our use case:**
```typescript
// Save conversation
await db.put('conversations', {
  packHash,
  messages,
  lastUpdated: Date.now()
})

// Load conversation
const convo = await db.get('conversations', packHash)

// Delete conversation
await db.delete('conversations', packHash)
```

That's it. Three operations, all async, all clean.

---

## Revision History

- **v1** (2025-11-05): Initial draft - too enterprise, too much cost focus, privacy paranoia
- **v2** (2025-11-05): Ultrathought revision based on feedback:
  - ✅ Added IndexedDB persistence (packHash-based lifecycle)
  - ✅ Switched from localStorage to IndexedDB (no size limits, async, future-proof)
  - ✅ Added `idb` library for clean Promise-based API
  - ✅ Added edit functionality (ChatGPT-style tree deletion)
  - ✅ Added retry functionality (regenerate single response)
  - ✅ Added copy button (Q&A formatted for sharing)
  - ✅ Detailed trade-offs and design decisions
  - ✅ All features in v1.1 (not staged across releases)
  - ❌ Removed cost-per-message displays
  - ❌ Removed "users must consent" enterprise nonsense
  - ❌ Removed multi-phase rollout complexity
