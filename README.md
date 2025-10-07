# Vana Source Query

**Select → Slice → Pack → Count → Copy**

Ask smart questions across selected GitHub repos with a gorgeous, zero-bloat web app. Powered by Repomix for slicing/packing and Gemini for token accounting/answers.

---

## Quick Start

### 1. Prerequisites

- **Node.js** 18+ (20+ recommended)
- **npm** or **pnpm**
- **GitHub Personal Access Token** ([create one](https://github.com/settings/tokens/new))
- **Gemini API Key** ([create one](https://aistudio.google.com/app/apikey))

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Copy the example env file and add your keys:

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and add your tokens:

```bash
GITHUB_TOKEN=ghp_your_token_here
GEMINI_API_KEY=your_gemini_key_here
```

> **Note**: See `.env.local.example` for detailed instructions on GitHub token types (classic vs fine-grained).

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 5. Test Locally (Without External APIs)

```bash
npm run test:local
```

This runs Repomix against a local fixture repo to verify packing works.

---

## Architecture

### Stack

- **Framework**: Next.js 14 (App Router)
- **Runtime**: Node.js (for repomix library dependencies)
- **Styling**: Tailwind CSS
- **Packing**: Repomix (CLI tool)
- **Token Counting**: Google Gemini API
- **Repo Listing**: Octokit (GitHub REST API)

### Project Structure

```
vana-query/
├── app/
│   ├── page.tsx              # Main UI
│   ├── layout.tsx            # Root layout
│   ├── globals.css           # Tailwind styles
│   └── api/
│       ├── repos/route.ts    # GET /api/repos - List org/user repos
│       ├── pack/route.ts     # POST /api/pack - Pack repos with Repomix
│       └── tokens/route.ts   # POST /api/tokens - Count tokens with Gemini
├── lib/
│   ├── types.ts              # Type definitions (SSOT)
│   ├── config.ts             # App configuration
│   ├── github.ts             # GitHub API client (Octokit wrapper)
│   ├── repomix.ts            # Repomix CLI wrapper
│   └── gemini.ts             # Gemini API client
├── components/               # (Future: extract UI components)
├── test/
│   ├── fixtures/             # Test data
│   ├── local-test.ts         # Local integration test
│   └── local-runner.js       # Test runner
├── .env.local.example        # Environment template
└── README.md                 # This file
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  User enters org name, GitHub token, Gemini key             │
└─────────────────────────────────────────────────────────────┘
                        │
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  GET /api/repos?org=acme                                     │
│  • Octokit lists repos                                      │
│  • Returns: name, branch, size, last updated                │
└─────────────────────────────────────────────────────────────┘
                        │
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  User selects repos, configures globs, enters prompt        │
└─────────────────────────────────────────────────────────────┘
                        │
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  POST /api/pack                                             │
│  • For each repo: packRemoteRepo (runRemoteAction)          │
│  • Assemble outputs into single context                     │
│  • Return: combined text + stats                            │
└─────────────────────────────────────────────────────────────┘
                        │
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  POST /api/tokens                                           │
│  • Call Gemini countTokens API                              │
│  • Return: total tokens, limit, status (under/near/over)    │
└─────────────────────────────────────────────────────────────┘
                        │
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  User copies to clipboard or downloads .txt                 │
└─────────────────────────────────────────────────────────────┘
```

---

## API Reference

### `GET /api/repos?org=<name>&type=<org|user>`

List repositories for an organization or user.

**Headers**:
- `X-GitHub-Token`: Your GitHub PAT

**Query Params**:
- `org` (required): Organization or username
- `type` (optional): `org` or `user` (default: `org`)

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "name": "repo-name",
      "fullName": "org/repo-name",
      "defaultBranch": "main",
      "pushedAt": "2025-01-15T10:30:00Z",
      "size": 12345,
      "private": false,
      "description": "A cool repo"
    }
  ]
}
```

---

### `POST /api/pack`

Pack multiple repositories using Repomix.

**Headers**:
- `X-GitHub-Token`: Your GitHub PAT

**Body**:
```json
{
  "repos": [
    { "fullName": "org/repo-a", "branch": "main" },
    { "fullName": "org/repo-b" }
  ],
  "sliceConfig": {
    "includeGlobs": ["**/*.ts", "**/*.tsx"],
    "ignoreGlobs": ["**/*.test.ts"],
    "respectGitignore": true,
    "useDefaultPatterns": true,
    "reducers": {
      "compress": false,
      "removeComments": false,
      "removeEmptyLines": false
    }
  },
  "userPrompt": "Explain the authentication flow"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "repos": [
      {
        "repo": "org/repo-a",
        "branch": "main",
        "output": "... packed content ...",
        "stats": {
          "fileCount": 42,
          "approxChars": 125000,
          "approxTokens": 31250
        }
      }
    ],
    "combined": {
      "output": "... assembled context ...",
      "totalChars": 125000,
      "totalTokens": 31250
    },
    "errors": []
  }
}
```

---

### `POST /api/tokens`

Count tokens using Gemini API (authoritative).

**Headers**:
- `X-Gemini-Key`: Your Gemini API key

**Body**:
```json
{
  "modelId": "gemini-1.5-flash",
  "contextText": "... your packed context ...",
  "userPrompt": "Optional user prompt"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "totalTokens": 31458,
    "contextTokens": 31250,
    "promptTokens": 208,
    "modelLimit": 1000000,
    "status": "under"
  }
}
```

**Status Values**:
- `under`: < 70% of model limit (green)
- `near`: 70-95% of model limit (amber)
- `over`: > 95% of model limit (red)

---

## Configuration

### Repomix Options

Controlled via `lib/config.ts`:

- **Timeout**: 60s per repo (adjust for large repos)
- **Max file size**: 1MB per file
- **Max total size**: 50MB per repo

### Gemini Models

Supported models (configured in `lib/config.ts`):

- `gemini-1.5-flash`: 1M token limit
- `gemini-1.5-pro`: 2M token limit
- `gemini-2.0-flash-exp`: 1M token limit

### AI Ignore Files

Vana Source Query automatically respects AI ignore files in repository roots. This allows repo owners to exclude sensitive files, build artifacts, or noise from LLM context.

**Supported formats** (all use gitignore syntax):
- `.aiignore` — Emerging industry standard (JetBrains, proposed universal format)
- `.aiexclude` — Google Gemini Code Assist
- `.cursorignore` — Cursor IDE
- `.codeiumignore` — Codeium
- `.agentignore` — Generic format
- `.geminiignore` — Google Gemini

If multiple files exist, patterns are merged and deduplicated.

**Example `.aiignore`:**
```
# Security - exclude all environment files
.env*
*.key
*.pem
credentials/

# Build artifacts - reduce noise
dist/
build/
*.min.js

# Testing - not relevant for code analysis
**/*.test.ts
**/*.spec.ts
coverage/

# Vendored code - already documented elsewhere
vendor/
third_party/
node_modules/
```

**Priority Order** (highest to lowest):
1. User-specified `ignoreGlobs` (UI input)
2. AI ignore file patterns (repo owner intent)
3. `.gitignore` patterns (if `respectGitignore` enabled)
4. Repomix default patterns

**Syntax**: Standard gitignore patterns (same as `.gitignore`):
- `**/*.test.ts` - Match all test files recursively
- `dist/` - Match directory
- `*.key` - Match by extension
- `# comment` - Comments start with `#`

**Security Note**: Even if secrets are accidentally committed to git, AI ignore files provide defense-in-depth by preventing them from being sent to LLMs.

---

## Local Testing

### Run Local Packing Test

```bash
npm run test:local
```

This:
1. Packs `test/fixtures/sample-repo` using Repomix
2. Tests include/ignore globs
3. Assembles context with user prompt
4. Verifies output format

### Test Without External APIs

The local test uses Repomix in `local` mode (no GitHub/Gemini calls). Useful for:
- Verifying Repomix installation
- Testing glob patterns
- Debugging packing logic

---

## Deployment

### Vercel (Recommended)

1. **Install Vercel CLI**:
   ```bash
   npm install -g vercel
   ```

2. **Deploy**:
   ```bash
   vercel
   ```

3. **Add Environment Variables** in Vercel dashboard:
   - `GITHUB_TOKEN` (optional: fallback if user doesn't provide token)
   - `GEMINI_API_KEY` (optional: fallback)

4. **Configure Function Settings**:
   - Runtime: **Node.js** (NOT Edge)
   - Max duration: **60s** (Pro plan) or **300s** (Enterprise)

### Other Platforms

Any platform supporting:
- Node.js runtime
- Writable `/tmp` directory (for temp output files)
- 60s+ execution timeout

Examples: Railway, Render, Fly.io, Cloud Run

---

## Troubleshooting

### "Repomix timed out"

**Cause**: Large repo or slow GitHub API response.

**Solutions**:
1. Add more specific `includeGlobs` to reduce file count
2. Increase timeout in `lib/config.ts`
3. Use a smaller subset of repos

### "GitHub rate limit exceeded"

**Cause**: Hit GitHub API rate limit (5000/hr for authenticated).

**Solutions**:
1. Wait for rate limit reset (check error message for time)
2. Use fine-grained token with fewer repos
3. Reduce number of parallel packing operations

### "Invalid or expired GitHub token"

**Cause**: Token is invalid, expired, or lacks permissions.

**Solutions**:
1. Create new token at https://github.com/settings/tokens/new
2. Ensure `repo` scope (classic) or `Contents: Read` (fine-grained)
3. For orgs, ensure token has org access

### Token count shows "over limit" but I want to proceed

**Solution**: Copy the packed context anyway (button remains enabled) and paste into:
- Gemini AI Studio (may support larger contexts)
- Claude (3M+ token limit on some models)
- GPT-4 (128k+ token limit)

---

## Principles & Design Decisions

### Simple Made Easy (Rich Hickey)

- **No complex abstractions**: Plain functions, clear data flow
- **Data > objects**: JSON in/out, no classes where functions suffice
- **Explicit > implicit**: All config visible, no magic defaults

### Guarantees Over Guesses (Carmack)

- **Authoritative token counts**: Use Gemini's API, not estimates
- **Fail fast**: Timeouts, validation, clear errors
- **Observable**: Console logs at every step

### Working Code > Perfect Code (Uncle Bob, Agile)

- **Ship MVP first**: Core flow works end-to-end
- **Iterate**: Add features based on real usage
- **Test early**: Local test path ensures packing works

### Lean Startup Mindset

- **Validate assumptions**: Spike Repomix in serverless first
- **Minimal viable product**: No auth, no DB, no complexity
- **Measure**: Add telemetry later based on user feedback

---

## Future Enhancements (v1.1+)

### Phase 2 Features

- [ ] **In-app Chat**: Stream responses from Gemini with packed context
- [ ] **Branch Selector**: Choose branch per repo
- [ ] **Submodule Detection**: Detect and warn about submodules
- [ ] **Reducers UI**: Enable compress, remove comments, remove empty lines

### Deferred Features

- [ ] **OAuth**: GitHub OAuth instead of PAT
- [ ] **Caching**: Edge cache for repeated packs (5-10min TTL)
- [ ] **User Presets**: Save slice configs per org
- [ ] **Audit Logs**: Track pack history (requires DB)
- [ ] **Collaborative Sessions**: Share pack results via URL

---

## Contributing

This is a lean startup project. Contributions welcome, but keep it simple:

1. **Fork and clone**
2. **Run tests**: `npm run test:local`
3. **Make changes**: Follow existing patterns
4. **Test end-to-end**: Run `npm run dev` and verify UI works
5. **Submit PR**: Clear description, no breaking changes

---

## License

MIT

---

## Credits

- **Repomix**: https://github.com/yamadashy/repomix
- **Octokit**: https://github.com/octokit/octokit.js
- **Google Gemini**: https://ai.google.dev/

Built with ❤️ by a staff engineer from Stripe, now at a lean startup.

Inspired by Rich Hickey (simplicity), John Carmack (guarantees), and Uncle Bob (clean code).
