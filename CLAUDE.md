# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vana Source Query** is a Next.js web app that packs multiple GitHub repositories into a single, prompt-friendly context using Repomix, counts tokens with Google Gemini API, and provides an integrated chat interface for asking questions about the packed code.

**Core workflow**: Select → Slice → Pack → Count → Copy (or Chat)

Users select repos from a GitHub org/user, configure glob filters and reducers, pack them with Repomix library API, get authoritative token counts from Gemini, and either copy/download the assembled context OR chat directly with Gemini using the packed context.

## Commands

### Development
```bash
npm run dev          # Start Next.js dev server (http://localhost:3000)
npm run build        # Production build
npm run start        # Start production server
npm run lint         # Run ESLint
npm run test:local   # Test Repomix packing against local fixture repo
```

### Environment Setup
Copy `.env.local.example` to `.env.local` and add:
- `GITHUB_TOKEN`: GitHub PAT (classic or fine-grained)
- `GEMINI_API_KEY`: Google Gemini API key

**Important**: Users can also provide these via the web UI (not persisted).

## Architecture

### Stack
- **Framework**: Next.js 15 (App Router) with Node.js runtime (NOT Edge)
- **Packing Engine**: Repomix library API (direct function calls)
- **Token Counting**: Google Gemini API (authoritative counts)
- **Chat**: Google Gemini API with streaming responses
- **Repo Listing**: Octokit (GitHub REST API)
- **UI**: React 19 + Tailwind CSS 4
- **State**: Client-side only, no database
- **Persistence**: localStorage (settings/selections) + IndexedDB (pack cache, chat history)

### Key Modules

**lib/types.ts** — Single Source of Truth (SSOT) for all data structures:
- `GitHubRepo`, `RepoSelection`, `SliceConfig`, `PackedRepo`, `PackResult`
- `TokenCountRequest`, `TokenCountResult`, `ApiResponse<T>`
- `Conversation`, `Message` — Chat history types
- Helper functions: `createApiSuccess()`, `createApiError()`

**lib/config.ts** — Application configuration:
- Timeouts: GitHub (30s), Repomix (60s/repo)
- Repomix limits: 1MB max file size, 50MB total per repo
- Gemini models and token limits (1M–2M)
- Cache configuration: staleness thresholds, LRU limits, auto-refresh

**lib/repomix.ts** — Repomix library integration:
- `packRemoteRepo(options)`: Pack GitHub repos via archive download (no git binary needed)
- `packLocalRepo(options)`: Pack local directories (for tests only)
- `assemblePackedContext(repos, prompt)`: Combine packed outputs with headers
- `fetchAiIgnorePatterns(repo, branch, token)`: Fetch AI ignore files from repo roots
- Uses `runRemoteAction` for GitHub repos, `runDefaultAction` for local directories
- Extracts stats from XML `<statistics>` section (fileCount, approxTokens)

**lib/github.ts** — GitHub API client (Octokit wrapper)

**lib/gemini.ts** — Gemini API client:
- `countTokens()`: Get authoritative token counts
- `streamChat()`: Stream chat responses with packed context

**lib/cache.ts** — localStorage persistence for user selections/settings

**lib/packCache.ts** — IndexedDB persistence for packed repo results:
- Stores packed outputs with commit SHA tracking
- Staleness detection based on age and SHA changes
- LRU eviction when cache exceeds limits
- Auto-refresh stale entries on next pack

**lib/chatDb.ts** — IndexedDB persistence for chat conversations:
- Stores conversations with messages
- Supports creating, listing, and deleting conversations
- Persists user/assistant message history

**lib/assembly.ts** — Context assembly utilities:
- Combines multiple packed repos with headers
- Formats user prompts and context for Gemini

### API Routes (Next.js)

All routes use `runtime = 'nodejs'` (NOT Edge) to support repomix library dependencies.

**GET /api/repos?org=<name>&type=<org|user>**
- Headers: `X-GitHub-Token`
- Returns: List of repos with name, branch, size, description

**POST /api/pack**
- Headers: `X-GitHub-Token`
- Body: `{ repos: RepoSelection[], sliceConfig: SliceConfig, userPrompt?: string }`
- Packs all repos in parallel using `Promise.all()` with `packRemoteRepo()`
- Returns: `PackResult` with per-repo stats and assembled context

**POST /api/tokens**
- Headers: `X-Gemini-Key`
- Body: `{ modelId: string, contextText: string, userPrompt?: string }`
- Returns: `TokenCountResult` with authoritative token count and status (under/near/over limit)

**POST /api/chat**
- Headers: `X-Gemini-Key`
- Body: `{ modelId: string, contextText: string, conversationHistory: Message[], userMessage: string }`
- Streams Gemini responses using Server-Sent Events (SSE)
- Returns: `text/event-stream` with incremental text chunks

**GET /api/sha?repo=<fullName>&branch=<name>**
- Headers: `X-GitHub-Token`
- Returns: Latest commit SHA for a repo/branch (used for cache invalidation)

### Data Flow

1. **User enters org name** → `GET /api/repos` → List repos (Octokit)
2. **User selects repos + configures globs** → Stored in React state
3. **User clicks "Pack"** → `POST /api/pack`:
   - For each repo: `packRemoteRepo({ repo, branch, githubToken, ...sliceConfig })`
   - Fetches AI ignore patterns from repo root (`.aiignore`, `.cursorignore`, etc.)
   - Uses Repomix `runRemoteAction` → GitHub archive download (no git binary)
   - Extracts stats from XML, assembles combined context
   - Stores result in IndexedDB with commit SHA
4. **Auto-trigger** → `POST /api/tokens`:
   - Calls Gemini `countTokens` API
   - Returns authoritative count + status (green/amber/red)
5. **User copies/downloads OR chats**:
   - **Copy**: Clipboard API or `<a download>`
   - **Chat**: `POST /api/chat` streams responses, stores in IndexedDB

## Critical Design Patterns

### Fail Fast with Partial Success
- Individual repo packing failures don't block others
- `PackResult` includes both successful repos and errors array
- Frontend shows per-repo error badges

### Guarantees Over Guesses (John Carmack)
- Token counts are **always** from Gemini API, never estimates
- Estimates (chars/4) shown in gray while waiting for authoritative count
- Repomix library calls include explicit error handling; never hangs indefinitely

### Simple Made Easy (Rich Hickey)
- No classes; pure functions and plain data (JSON in/out)
- Two functions, two paths: `packRemoteRepo` (GitHub) vs `packLocalRepo` (tests)
- No magic: all config explicit in `lib/config.ts`
- No hidden state: localStorage cache is opt-in and inspectable

### Explicit Over Implicit
- Repomix options mapped 1:1 from `SliceConfig` interface to `CliOptions`
- Function calls (`runRemoteAction`, `runDefaultAction`) make intent crystal clear
- API responses use `ApiResponse<T>` discriminated union (`success: true | false`)

### Smart Caching with Staleness Detection
- Pack results cached in IndexedDB with commit SHA tracking
- Cache hits validated against latest commit SHA (via `GET /api/sha`)
- Stale entries (>7 days old OR SHA changed) marked for auto-refresh
- LRU eviction when cache exceeds limits (100 entries, 50MB total)
- Users can manually clear cache via UI

## Repomix Integration Notes

### Using Repomix as a Library

We use Repomix's programmatic API, not the CLI:

```typescript
import { runRemoteAction, runDefaultAction } from 'repomix'

// Production: Pack GitHub repos via archive download (no git binary needed)
await runRemoteAction('owner/repo', {
  output: outputFile,
  remoteBranch: 'main',
  include: '**/*.ts,**/*.tsx',
  ignore: '**/*.test.ts',
  removeComments: true,
})

// Tests: Pack local directory
await runDefaultAction([directory], process.cwd(), {
  output: outputFile,
  include: '**/*.ts',
})
```

**Key options**:
- `output`: File path to write XML output
- `remoteBranch`: Override default branch (remote only)
- `include`, `ignore`: Comma-separated globs
- `removeComments`, `removeEmptyLines`: Reducers

**Why this works in Vercel**:
- `runRemoteAction` uses GitHub archive API (HTTP download)
- No git binary required - pure Node.js
- Next.js automatically bundles library dependencies

### AI Ignore File Support

The app automatically fetches and respects AI ignore files from repository roots:

**Supported formats** (all use gitignore syntax):
- `.aiignore` — Emerging industry standard (JetBrains)
- `.aiexclude` — Google Gemini Code Assist
- `.cursorignore` — Cursor IDE
- `.codeiumignore` — Codeium
- `.agentignore` — Generic format
- `.geminiignore` — Google Gemini

**Implementation**:
- `fetchAiIgnorePatterns()` fetches all formats from repo root via GitHub API
- Patterns are merged, deduplicated, and passed to Repomix's `ignore` option
- Falls back gracefully if files don't exist (no error)

**Priority Order**:
1. User-specified `ignoreGlobs` (UI input)
2. AI ignore file patterns (repo owner intent)
3. `.gitignore` patterns (if `respectGitignore` enabled)
4. Repomix default patterns

### Output Format
Repomix returns XML-structured text:
```xml
<statistics>
  <total_files>42</total_files>
  <total_chars>125000</total_chars>
  <total_tokens>31250</total_tokens>
</statistics>

<file path="src/index.ts">
... file content ...
</file>
```

Stats are extracted via regex in `extractRepomixStats()`.

## Chat Integration

### How Chat Works

1. User packs repos → context stored in React state
2. User opens chat interface → new conversation created in IndexedDB
3. User sends message → `POST /api/chat` with full context + conversation history
4. Gemini streams response using SSE (Server-Sent Events)
5. Messages stored in IndexedDB for persistence
6. Conversations persist across page reloads

### Chat UI Components

**app/components/Chat.tsx** — Main chat container:
- Displays message list with auto-scroll
- Input field for user messages
- Markdown rendering for assistant responses

**app/components/ChatMessage.tsx** — Individual message component:
- User/assistant role indicators
- Markdown rendering with syntax highlighting (rehype-highlight)
- Math rendering with KaTeX (remark-math, rehype-katex)

**app/components/MarkdownRenderer.tsx** — Shared markdown renderer:
- Supports GFM (tables, strikethrough, task lists)
- Syntax highlighting for code blocks
- Math rendering
- Sanitization (rehype-sanitize, rehype-raw)

### Streaming Implementation

**Server-side** (`app/api/chat/route.ts`):
```typescript
const stream = new ReadableStream({
  async start(controller) {
    for await (const chunk of geminiStream) {
      controller.enqueue(encoder.encode(`data: ${chunk.text()}\n\n`));
    }
    controller.close();
  },
});

return new Response(stream, {
  headers: { 'Content-Type': 'text/event-stream' },
});
```

**Client-side** (`app/page.tsx`):
```typescript
const response = await fetch('/api/chat', { ... });
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const text = decoder.decode(value);
  // Parse SSE format: "data: <chunk>\n\n"
  // Append to assistant message
}
```

## Common Patterns

### Adding a New Reducer
1. Add to `SliceConfig.reducers` in `lib/types.ts`
2. Map to `CliOptions` in `packRemoteRepo()` / `packLocalRepo()` in `lib/repomix.ts`
3. Add UI toggle in `app/page.tsx`
4. Update localStorage cache schema in `lib/cache.ts`

### Changing Timeout Limits
Edit `lib/config.ts`:
```ts
repomix: {
  timeout: 120000, // 2 minutes instead of 60s
}
```

Also update `maxDuration` in `app/api/pack/route.ts` if needed (Vercel limits apply).

### Adding a New Gemini Model
Edit `lib/config.ts`:
```ts
gemini: {
  models: {
    'gemini-3.0-ultra': {
      name: 'Gemini 3.0 Ultra',
      limit: 10_000_000, // 10M tokens
    },
  },
}
```

Frontend model selector reads from `config.gemini.models`.

### Adding a New AI Ignore Format

Edit `lib/repomix.ts`:
```ts
const AI_IGNORE_FILENAMES = [
  '.aiignore',
  '.aiexclude',
  '.cursorignore',
  '.codeiumignore',
  '.agentignore',
  '.geminiignore',
  '.newformat', // Add new format here
] as const;
```

### Working with IndexedDB Cache

**Pack Cache** (`lib/packCache.ts`):
```typescript
// Store packed result
await storePackedRepo(fullName, branch, packedOutput, sha);

// Retrieve (checks staleness)
const cached = await getPackedRepo(fullName, branch);
if (cached && !cached.isStale) {
  // Use cached.output
}

// Clear all cache
await clearPackCache();
```

**Chat Database** (`lib/chatDb.ts`):
```typescript
// Create conversation
const convId = await createConversation(contextText);

// Add messages
await addMessage(convId, 'user', 'Hello');
await addMessage(convId, 'assistant', 'Hi there!');

// List conversations
const convs = await listConversations();

// Delete conversation
await deleteConversation(convId);
```

## Testing

### Local Integration Test
```bash
npm run test:local
```

This:
1. Runs Repomix in **local mode** against `test/fixtures/sample-repo/`
2. Tests include/ignore globs
3. Assembles context with user prompt
4. Validates output structure

**No external APIs required** (GitHub/Gemini).

### Manual Testing Checklist
1. List repos for a public org (no token required)
2. List repos for a private org (with token)
3. Pack single repo with default settings
4. Pack multiple repos with custom globs
5. Test all reducers (compress, remove comments, etc.)
6. Verify token count shows correct status (under/near/over)
7. Copy to clipboard and download `.txt`
8. Start a chat conversation with packed context
9. Verify chat history persists across page reloads
10. Clear pack cache and verify staleness detection

## Troubleshooting

### "Repomix timed out"
- Increase timeout in `lib/config.ts`
- Add more specific `includeGlobs` to reduce file count
- Check repo size (should be <50MB after filtering)

### "GitHub rate limit exceeded"
- Wait for rate limit reset (shown in error message)
- Use authenticated token (5000/hr vs 60/hr for anonymous)
- Reduce parallel packing (pack fewer repos at once)

### "Invalid or expired GitHub token"
- Verify token has `repo` scope (classic) or `Contents: Read` (fine-grained)
- For orgs, ensure token has org access approved

### Chat not streaming / hanging
- Check browser console for SSE errors
- Verify Gemini API key is valid
- Ensure model supports streaming (all current Gemini models do)
- Check network tab for broken SSE connection

### Cache not invalidating
- Cache uses commit SHA for staleness detection
- If SHA lookup fails, cache entry is considered stale
- Manually clear cache via UI if needed
- Check IndexedDB in browser DevTools (Application → IndexedDB)

### Repomix Library Errors

**Now using library API** - no more spawn/child_process issues!

- `packRemoteRepo` uses `runRemoteAction` → GitHub archive download via HTTP
- No git binary required (Vercel limitation solved)
- No symlink issues (not spawning CLI)
- No manual file tracing needed (Next.js handles library deps automatically)
- `serverExternalPackages: ['repomix']` prevents bundling conflicts

## Deployment

### Vercel (Recommended)
1. Install Vercel CLI: `npm install -g vercel`
2. Deploy: `vercel`
3. Add environment variables in dashboard (optional fallbacks):
   - `GITHUB_TOKEN`
   - `GEMINI_API_KEY`
4. Configure:
   - Runtime: **Node.js** (NOT Edge)
   - Max duration: 60s (Hobby), 300s (Pro)

**Critical**: Do NOT use Edge runtime. Repomix library has Node.js dependencies.

### Other Platforms
Any platform supporting:
- Node.js 18+ runtime
- 60s+ execution timeout
- Writable `/tmp` directory (for temp output files)

Examples: Railway, Render, Fly.io, Google Cloud Run

## File Structure (Key Files Only)

```
vana-query/
├── app/
│   ├── page.tsx              # Main UI (repo selection, slice config, results, chat)
│   ├── layout.tsx            # Root layout with metadata
│   ├── components/
│   │   ├── Chat.tsx          # Chat container
│   │   ├── ChatMessage.tsx   # Individual message component
│   │   ├── MarkdownRenderer.tsx  # Shared markdown renderer
│   │   ├── Spinner.tsx       # Loading spinner
│   │   ├── ThemeToggle.tsx   # Dark/light mode toggle
│   │   └── ThemeProvider.tsx # Theme context provider
│   └── api/
│       ├── repos/route.ts    # List org/user repos
│       ├── pack/route.ts     # Pack repos with Repomix
│       ├── tokens/route.ts   # Count tokens with Gemini
│       ├── chat/route.ts     # Stream chat responses
│       └── sha/route.ts      # Get latest commit SHA
├── lib/
│   ├── types.ts              # SSOT for all interfaces
│   ├── config.ts             # Timeouts, limits, model definitions, cache config
│   ├── repomix.ts            # Repomix library integration + AI ignore fetching
│   ├── github.ts             # GitHub API client
│   ├── gemini.ts             # Gemini API client (tokens + chat)
│   ├── assembly.ts           # Context assembly helpers
│   ├── cache.ts              # localStorage persistence
│   ├── packCache.ts          # IndexedDB pack cache
│   └── chatDb.ts             # IndexedDB chat history
├── test/
│   ├── fixtures/sample-repo/ # Test repo for local packing
│   ├── local-test.ts         # Integration test (no external APIs)
│   └── local-runner.js       # Test runner (tsx)
├── next.config.js            # Next.js config (serverExternalPackages)
├── .env.local.example        # Environment template
├── CLAUDE.md                 # This file
└── README.md                 # User-facing docs
```

## Principles

1. **Simple Made Easy**: No abstractions; plain functions and data
2. **Guarantees Over Guesses**: Authoritative token counts only
3. **Explicit Over Implicit**: All config visible, no magic defaults
4. **Fail Fast**: Timeouts, validation, clear errors
5. **Observable**: Console logs at every step for debugging
6. **Progressive Enhancement**: Core workflow (pack → copy) works without chat
