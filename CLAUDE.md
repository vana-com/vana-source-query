# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vana Source Query** is a Next.js web app that packs multiple GitHub repositories into a single, prompt-friendly context using Repomix, then counts tokens with Google Gemini API.

**Core workflow**: Select → Slice → Pack → Count → Copy

Users select repos from a GitHub org/user, configure glob filters and reducers, pack them with Repomix library API, get authoritative token counts from Gemini, and copy/download the assembled context for use with LLMs.

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
- **Repo Listing**: Octokit (GitHub REST API)
- **UI**: React + Tailwind CSS 4
- **State**: Client-side only, with localStorage cache (no database)

### Key Modules

**lib/types.ts** — Single Source of Truth (SSOT) for all data structures:
- `GitHubRepo`, `RepoSelection`, `SliceConfig`, `PackedRepo`, `PackResult`
- `TokenCountRequest`, `TokenCountResult`, `ApiResponse<T>`
- Helper functions: `createApiSuccess()`, `createApiError()`

**lib/config.ts** — Application configuration:
- Timeouts: GitHub (30s), Repomix (60s/repo)
- Repomix limits: 1MB max file size, 50MB total per repo
- Gemini models and token limits (1M–2M)

**lib/repomix.ts** — Repomix library integration:
- `packRemoteRepo(options)`: Pack GitHub repos via archive download (no git binary needed)
- `packLocalRepo(options)`: Pack local directories (for tests only)
- `assemblePackedContext(repos, prompt)`: Combine packed outputs with headers
- Uses `runRemoteAction` for GitHub repos, `runDefaultAction` for local directories
- Extracts stats from XML `<statistics>` section (fileCount, approxTokens)

**lib/github.ts** — GitHub API client (Octokit wrapper)

**lib/gemini.ts** — Gemini API client for token counting

**lib/cache.ts** — localStorage persistence for user selections/settings

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

### Data Flow

1. **User enters org name** → `GET /api/repos` → List repos (Octokit)
2. **User selects repos + configures globs** → Stored in React state
3. **User clicks "Pack"** → `POST /api/pack`:
   - For each repo: `packRemoteRepo({ repo, branch, githubToken, ...sliceConfig })`
   - Uses Repomix `runRemoteAction` → GitHub archive download (no git binary)
   - Extracts stats from XML, assembles combined context
4. **Auto-trigger** → `POST /api/tokens`:
   - Calls Gemini `countTokens` API
   - Returns authoritative count + status (green/amber/red)
5. **User copies or downloads** → Clipboard API or `<a download>`

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
│   ├── page.tsx              # Main UI (repo selection, slice config, results)
│   ├── layout.tsx            # Root layout with metadata
│   └── api/
│       ├── repos/route.ts    # List org/user repos
│       ├── pack/route.ts     # Pack repos with Repomix
│       └── tokens/route.ts   # Count tokens with Gemini
├── lib/
│   ├── types.ts              # SSOT for all interfaces
│   ├── config.ts             # Timeouts, limits, model definitions
│   ├── repomix.ts            # Repomix library integration (runRemoteAction, runDefaultAction)
│   ├── github.ts             # GitHub API client
│   ├── gemini.ts             # Gemini API client
│   └── cache.ts              # localStorage persistence
├── test/
│   ├── fixtures/sample-repo/ # Test repo for local packing
│   ├── local-test.ts         # Integration test (no external APIs)
│   └── local-runner.js       # Test runner (tsx)
├── .env.local.example        # Environment template
└── README.md                 # User-facing docs
```

## Principles

1. **Simple Made Easy**: No abstractions; plain functions and data
2. **Guarantees Over Guesses**: Authoritative token counts only
3. **Explicit Over Implicit**: All config visible, no magic defaults
4. **Fail Fast**: Timeouts, validation, clear errors
5. **Observable**: Console logs at every step for debugging
