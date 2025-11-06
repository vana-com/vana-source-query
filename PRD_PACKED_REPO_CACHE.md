# PRD: Intelligent Packed Repo Caching

**Author**: Staff Engineer Review
**Date**: 2025-11-05
**Status**: Draft for Review
**Target**: v2.0

---

## Problem Statement

**Users wait ~20 seconds every time they pack a repo, even when nothing has changed.**

Current behavior:
- User selects repos + config → clicks "Pack" → waits 20s → gets result
- User tweaks prompt → clicks "Pack" again → **waits another 20s for identical repo packing**
- User switches tabs, comes back → **starts from scratch, another 20s**

**This 20-second tax compounds:**
- Iterating on prompts: 10 iterations = 3+ minutes of pure waiting
- Checking freshness: "Did code change?" requires full re-pack to know
- Context switching: Every tab refresh loses all progress

**Measurable impact:**
- 20s per pack × average 5 packs/session = 100s wasted time
- Cache hit rate of 60-70% would save ~60-70s per session
- For power users (20+ packs/day), this is 6+ minutes/day saved

---

## User Research

### Who is the user?

**Primary persona: "Iterative Ivan"**
- Mid-senior engineer using LLMs for codebase understanding
- Works on 3-5 active projects simultaneously
- Packs same repo 5-10 times per session while iterating on prompts
- Values speed and trust in tools
- Frustrated by artificial wait times

**Secondary persona: "Fresh Freida"**
- Junior engineer exploring unfamiliar codebases
- Needs confidence that context is current
- Worried about misleading LLM with stale code
- Values transparency over speed

### What do they care about?

**Speed (90% of users)**
- "Don't make me wait if nothing changed"
- "I'm tweaking prompts, not repos - be smart about it"

**Trust (100% of users)**
- "Show me if cached version is stale"
- "Never silently give me old code"
- "Let me choose: fast (cached) vs fresh (re-pack)"

**Storage transparency (10% of users)**
- "How much space am I using?"
- "Let me clear cache when needed"

### Use Cases (Prioritized)

**P0: Hot cache, no code changes**
```
User packs repo A → closes tab → returns 2 min later → packs repo A again
EXPECT: Instant result (<200ms), clear "Using cached version (current)" indicator
```

**P0: Warm cache, new commits**
```
User packs repo A (commit abc123) → makes 3 commits → packs again
EXPECT: "Cached version available (3 commits behind). Use cached or re-pack?"
USER CHOICE: Use cached for speed, or re-pack for freshness
```

**P1: Different slice config**
```
User packs repo A with "*.ts" filter → changes to "*.ts,*.tsx"
EXPECT: Cache miss (config changed), new pack, new cache entry
```

**P2: Storage management**
```
User has packed 20 repos (300MB cache) → adds 21st repo
EXPECT: Auto-purge least recently used (LRU) cache entries, never fail
```

**P3: Cache inspection**
```
User wonders "what's cached?"
EXPECT: Simple UI showing cached repos, freshness, size, with "Clear all" button
```

---

## Goals & Non-Goals

### Goals ✅

1. **Eliminate wait time for unchanged repos** (20s → <200ms)
2. **Provide transparent staleness indicators** (commits behind, days old)
3. **Give users control** (use cached vs re-pack choice)
4. **Fail gracefully** (cache corruption → fall back to normal pack)
5. **Manage storage automatically** (LRU purging, no manual intervention required)
6. **Support all slice configs** (different globs/reducers → different cache entries)

### Non-Goals ❌

1. ❌ **Cross-device sync** (cache is client-local only; keeps architecture simple)
2. ❌ **Historical version comparison** ("repo was 50k tokens last week vs 60k today" - nice-to-have, not MVP)
3. ❌ **Partial cache invalidation** (if one file changes, re-pack entire repo; Repomix is fast enough)
4. ❌ **Cache preloading** (don't pack repos user hasn't requested; stays on-demand)
5. ❌ **Offline mode** (still require network for GitHub API; cache only speeds up re-packs)

---

## Solution Overview

**Cache packed repo outputs in IndexedDB with smart invalidation.**

### High-Level Flow

```
User clicks "Pack"
  ↓
Check cache: key = f(repo, branch, SHA, sliceConfig)
  ↓
├─ HIT (fresh) → Return cached output instantly + green indicator
├─ HIT (stale) → Show choice: "Cached (3 commits behind)" vs "Re-pack (current)"
└─ MISS → Pack normally → Store in cache → Return result
```

### Cache Key Design

```typescript
// Deterministic cache key
const cacheKey = `${repo.fullName}:${branch}:${commitSHA}:${hash(sliceConfig)}`

// Examples:
"facebook/react:main:a1b2c3d:h8x9f2" // Specific commit + config
"vercel/next.js:canary:e4f5g6h:h8x9f2" // Canary branch
"vercel/next.js:canary:e4f5g6h:k3m9p1" // Same commit, different config (new entry)
```

**Why this works:**
- ✅ Commit SHA guarantees code freshness
- ✅ Config hash guarantees filter/reducer freshness
- ✅ Branch name supports multi-branch workflows
- ✅ Fully deterministic (no guessing, no heuristics)

### What We Cache

```typescript
interface CachedPack {
  // Cache key components
  repoFullName: string       // "facebook/react"
  branch: string             // "main"
  commitSHA: string          // "a1b2c3d4e5f6..."
  sliceConfigHash: string    // "h8x9f2q5..."

  // Cached output
  packedOutput: string       // Full Repomix XML output

  // Metadata
  stats: {
    fileCount: number
    totalChars: number
    totalTokens: number      // Repomix estimate
  }
  geminiTokens?: number      // Authoritative count (if available)

  // Housekeeping
  cachedAt: number           // Unix timestamp
  lastAccessedAt: number     // For LRU purging
  sizeBytes: number          // For storage monitoring
}
```

### Staleness Detection

When cache hit occurs:
1. Fetch current commit SHA from GitHub API (fast, <200ms)
2. Compare to cached SHA
3. If different:
   - Calculate commits behind: `git rev-list ${cachedSHA}..${currentSHA} --count`
   - Calculate time delta: `currentTime - cachedAt`
   - Show user: "Cached version: 3 commits behind (2 days old)"

**User choice:**
- "Use cached" → Instant result, amber indicator
- "Re-pack" → Normal flow, update cache

---

## Detailed Design

### Storage Technology: IndexedDB

**Why not localStorage?**
- ❌ 5-10MB limit (1-2 medium repos)
- ❌ Synchronous (blocks UI thread)
- ❌ No quota management API

**Why IndexedDB?**
- ✅ 50MB-500MB+ limit (browser-dependent)
- ✅ Asynchronous (non-blocking)
- ✅ Quota API for storage monitoring
- ✅ Indexed queries (fast lookups)
- ✅ Transaction safety (atomic updates)

**Schema:**

```typescript
// Database: "vana-pack-cache", version 1
// Store: "packs"

interface PackStore {
  key: string                // Composite cache key
  value: CachedPack
}

// Indexes:
indexes: {
  'byRepo': ['repoFullName'],           // Find all cached versions of a repo
  'byLastAccessed': ['lastAccessedAt'], // LRU purging
  'byTimestamp': ['cachedAt']           // Staleness queries
}
```

### Cache Operations

**1. Lookup**
```typescript
async function lookupCache(
  repo: string,
  branch: string,
  sliceConfig: SliceConfig
): Promise<CachedPack | null> {
  // Get current commit SHA
  const currentSHA = await fetchCurrentCommitSHA(repo, branch)

  // Try exact match (current SHA)
  const exactKey = buildCacheKey(repo, branch, currentSHA, sliceConfig)
  const exactMatch = await db.get(exactKey)
  if (exactMatch) return exactMatch // Fresh hit

  // Try finding stale version (different SHA, same repo+branch+config)
  const configHash = hashSliceConfig(sliceConfig)
  const staleMatches = await db.getAllFromIndex('byRepo', repo)
    .filter(p => p.branch === branch && p.sliceConfigHash === configHash)
    .sort((a, b) => b.cachedAt - a.cachedAt) // Most recent first

  if (staleMatches.length > 0) {
    const stale = staleMatches[0]
    stale.commitsBehind = await countCommitsBehind(stale.commitSHA, currentSHA)
    return stale // Stale hit
  }

  return null // Miss
}
```

**2. Store**
```typescript
async function storeInCache(
  repo: string,
  branch: string,
  commitSHA: string,
  sliceConfig: SliceConfig,
  packedOutput: string,
  stats: RepomixStats
): Promise<void> {
  const key = buildCacheKey(repo, branch, commitSHA, sliceConfig)
  const sizeBytes = new Blob([packedOutput]).size

  const entry: CachedPack = {
    repoFullName: repo,
    branch,
    commitSHA,
    sliceConfigHash: hashSliceConfig(sliceConfig),
    packedOutput,
    stats,
    cachedAt: Date.now(),
    lastAccessedAt: Date.now(),
    sizeBytes
  }

  // Check storage quota
  const totalSize = await getTotalCacheSize()
  if (totalSize + sizeBytes > CACHE_LIMIT) {
    await purgeLRU(sizeBytes) // Make room
  }

  await db.put(key, entry)
}
```

**3. Purge (LRU)**
```typescript
async function purgeLRU(bytesNeeded: number): Promise<void> {
  const allEntries = await db.getAllFromIndex('byLastAccessed', 'asc')
  let freedBytes = 0

  for (const entry of allEntries) {
    if (freedBytes >= bytesNeeded) break
    await db.delete(entry.key)
    freedBytes += entry.sizeBytes
  }
}
```

### Configuration

```typescript
// lib/config.ts additions

export const CACHE_CONFIG = {
  // Storage limits
  maxTotalSize: 100 * 1024 * 1024,  // 100MB total cache
  maxEntrySize: 10 * 1024 * 1024,   // 10MB per repo

  // Staleness thresholds
  warnIfCommitsBehind: 5,            // Show warning if >5 commits behind
  warnIfDaysOld: 7,                  // Show warning if >7 days old

  // Auto-refresh
  autoRefreshIfMinutesBehind: 5,    // Auto re-pack if packed <5min ago but new commits

  // Housekeeping
  purgeIfNotAccessedDays: 30,       // Auto-purge if not accessed in 30 days
}
```

---

## UX Flow

### Visual Indicators

**1. Cache Hit (Fresh)**
```
┌─────────────────────────────────────────────────┐
│ ✓ Packed 3 repositories (from cache)            │
│                                                  │
│ facebook/react          [●] 2,847 files         │
│ ↳ Using cached version (current)                │
│   Packed 2 hours ago • 1.2M tokens              │
└─────────────────────────────────────────────────┘
```
- Green dot indicator
- "from cache" badge
- Timestamp + token count for context

**2. Cache Hit (Stale)**
```
┌─────────────────────────────────────────────────┐
│ facebook/react          [◐] 2,847 files         │
│ ↳ Cached version available (3 commits behind)   │
│   Packed 2 days ago • 1.2M tokens               │
│                                                  │
│   [Use Cached (instant)] [Re-pack (current)]    │
└─────────────────────────────────────────────────┘
```
- Amber dot indicator
- Clear choice: speed vs freshness
- Commit delta + time delta visible

**3. Cache Miss**
```
┌─────────────────────────────────────────────────┐
│ facebook/react          [○] Packing...          │
│ ↳ Downloading archive...                        │
└─────────────────────────────────────────────────┘
```
- Normal packing flow
- Will be cached after completion

### Cache Management UI

**Simple stats panel:**
```
┌─────────────────────────────────────────────────┐
│ Cache Status                                     │
│                                                  │
│ 8 repos cached • 47.2 MB used of 100 MB         │
│ [████████░░] 47%                                 │
│                                                  │
│ [View Cache] [Clear All]                         │
└─────────────────────────────────────────────────┘
```

**Cache detail view:**
```
┌─────────────────────────────────────────────────┐
│ Cached Repositories                              │
│                                                  │
│ facebook/react (main)                            │
│ ├─ Current • 1.2M tokens • 8.4 MB               │
│ └─ [Clear]                                       │
│                                                  │
│ vercel/next.js (canary)                          │
│ ├─ 5 commits behind • 2.1M tokens • 12.1 MB     │
│ └─ [Clear]                                       │
│                                                  │
│ ...                                              │
└─────────────────────────────────────────────────┘
```

---

## Success Metrics

### Primary Metrics

1. **Cache Hit Rate**
   - Target: 60-70% of packs are cache hits
   - Measure: `cacheHits / (cacheHits + cacheMisses)`

2. **Time Saved**
   - Target: 60s+ saved per session (average)
   - Measure: `cacheHits × 20s (average pack time)`

3. **User Trust**
   - Target: <5% of users manually clear cache per session
   - Proxy for "cache is doing the right thing"

### Secondary Metrics

4. **Storage Usage**
   - Monitor: Average cache size per user
   - Alert if: >80% of users hitting 100MB limit (increase limit)

5. **Staleness Distribution**
   - Track: % of hits that are stale (commits behind)
   - Optimize: If >30% stale, consider auto-refresh threshold tuning

6. **Purge Frequency**
   - Monitor: How often LRU purging occurs
   - Optimize: If frequent, increase cache limit or entry size limits

---

## Risks & Mitigations

### Risk 1: Cache Corruption
**What**: IndexedDB corruption breaks cache lookups

**Mitigation**:
- Wrap all DB operations in try-catch with fallback to normal pack
- Version database schema (easy migration path)
- Add cache health check on app load (test write/read)
- Graceful degradation: app works fine without cache

```typescript
try {
  const cached = await lookupCache(...)
  if (cached) return cached
} catch (err) {
  console.error('Cache lookup failed, proceeding with normal pack:', err)
  trackCacheError(err)
  // Fall through to normal pack
}
```

### Risk 2: Storage Quota Exceeded
**What**: Browser denies cache writes, user experience degrades

**Mitigation**:
- Proactive LRU purging before writes
- Monitor quota with `navigator.storage.estimate()`
- Cap max entry size at 10MB (reject caching huge repos)
- Show warning if cache near limit: "Cache 90% full - consider clearing"

### Risk 3: Stale Cache Misleads User
**What**: User unknowingly uses outdated code, LLM gives wrong advice

**Mitigation**:
- **Never** auto-use stale cache without explicit user choice
- Always fetch current SHA before cache lookup (guarantee freshness check)
- Amber indicator + commit count makes staleness obvious
- Default to "Re-pack" button for stale cache (user must actively choose cached)

### Risk 4: Config Hash Collisions
**What**: Two different configs hash to same value, wrong cache served

**Mitigation**:
- Use cryptographic hash (SHA-256) for config, not weak hash
- Include full sliceConfig in cache metadata for validation
- On cache hit, double-check config matches (defense in depth)

```typescript
if (cached.sliceConfigHash === hash(sliceConfig)) {
  // Extra validation
  if (deepEqual(cached.sliceConfig, sliceConfig)) {
    return cached
  } else {
    // Hash collision detected (astronomically rare)
    console.error('Cache config hash collision detected!')
    return null // Force re-pack
  }
}
```

### Risk 5: GitHub API Rate Limits (SHA Fetching)
**What**: Every cache lookup requires SHA fetch, burns API quota

**Mitigation**:
- Cache current SHA in memory (React state) for session duration
- Only re-fetch SHA if >5 minutes since last fetch
- Batch SHA fetches if user selecting multiple repos
- Graceful degradation: if rate limited, skip cache freshness check, show warning

---

## Implementation Plan

### Phase 1: Foundation (Week 1)
**Deliverable**: Basic cache with fresh hits only

- ✅ Create `lib/packCache.ts` with IndexedDB wrapper
- ✅ Implement `lookupCache()`, `storeInCache()`, `clearCache()`
- ✅ Add cache check to `/api/pack` route
- ✅ Simple UI indicator: "Using cached version" (green dot)
- ✅ Unit tests for cache key generation and storage

**Success**: User packs repo twice → second pack is instant

### Phase 2: Staleness (Week 2)
**Deliverable**: Stale cache detection + user choice

- ✅ Implement `fetchCurrentCommitSHA()` in `lib/github.ts`
- ✅ Add staleness check to `lookupCache()`
- ✅ UI for stale cache: amber indicator + "Use cached vs Re-pack" buttons
- ✅ Track commits behind (GitHub API: compare commits)
- ✅ Update cache metadata on access (LRU tracking)

**Success**: User packs repo, makes commits, packs again → sees staleness info + choice

### Phase 3: Storage Management (Week 3)
**Deliverable**: LRU purging + cache stats UI

- ✅ Implement `purgeLRU()` with quota monitoring
- ✅ Add cache stats panel to main UI
- ✅ "View cache" detail modal
- ✅ "Clear all" and per-repo "Clear" buttons
- ✅ Monitor storage quota with `navigator.storage.estimate()`

**Success**: User fills cache → oldest entries auto-purge, no storage errors

### Phase 4: Polish (Week 4)
**Deliverable**: Error handling, config tuning, telemetry

- ✅ Comprehensive error handling (cache corruption, quota exceeded)
- ✅ A/B test cache limits (100MB vs 200MB)
- ✅ Track cache hit rate, staleness distribution
- ✅ Performance: warm cache on app load (prefetch common repos)
- ✅ Documentation updates (README, CLAUDE.md)

**Success**: Cache "just works", users don't think about it

---

## Open Questions

1. **Should we cache Gemini token counts?**
   - PRO: Save API quota + latency
   - CON: Gemini count tied to specific model (model changes invalidate cache)
   - **DECISION**: Yes, cache with model ID in key. Small storage cost, big API savings.

2. **Should we show estimated savings ("You saved 3 minutes today")?**
   - PRO: Delightful, reinforces value
   - CON: Gamification distraction
   - **DECISION**: Add to cache stats UI (not main flow). Opt-in delight.

3. **Should we cache pack errors?**
   - PRO: Don't retry known-bad repos (rate limit protection)
   - CON: Repo might be fixed, cache prevents retry
   - **DECISION**: No. Errors are stateful, not cacheable. Add retry backoff instead.

4. **Should we support exporting/importing cache?**
   - USE CASE: User switches browsers, wants to transfer cache
   - **DECISION**: Not MVP. Complex, rare use case. Revisit if users request.

5. **Should we pre-pack repos in background (prefetching)?**
   - PRO: Even faster UX (instant on first pack)
   - CON: Wasted packing for repos user may never use
   - **DECISION**: Not MVP. Stay on-demand. Consider if users request.

---

## Appendix: Technical Considerations

### IndexedDB Wrapper Library

**Recommendation**: Use `idb` (Jake Archibald's wrapper)
- Tiny (1.5KB gzipped)
- Promise-based (modern, clean)
- Battle-tested (used by Google, Vercel)
- Direct API access (no magic, no lock-in)

```typescript
import { openDB } from 'idb'

const db = await openDB('vana-pack-cache', 1, {
  upgrade(db) {
    const store = db.createObjectStore('packs', { keyPath: 'key' })
    store.createIndex('byRepo', 'repoFullName')
    store.createIndex('byLastAccessed', 'lastAccessedAt')
  }
})
```

### Commit SHA Fetching Strategy

**Option A: GitHub API** (Chosen)
```typescript
GET /repos/{owner}/{repo}/commits/{branch}
// Returns: { sha: "a1b2c3d...", commit: {...}, ... }
// Cost: 1 API call per cache lookup
// Latency: ~200ms
```

**Option B: Git Archive Metadata**
- Extract SHA from archive headers
- PRO: No extra API call
- CON: Requires downloading archive (defeats caching purpose)

**DECISION**: Use GitHub API. 200ms latency acceptable for 20s savings.

### Config Hashing

```typescript
import { createHash } from 'crypto'

function hashSliceConfig(config: SliceConfig): string {
  // Normalize config for deterministic hashing
  const normalized = {
    includeGlobs: config.includeGlobs?.sort() || [],
    ignoreGlobs: config.ignoreGlobs?.sort() || [],
    reducers: Object.keys(config.reducers || {})
      .sort()
      .reduce((acc, key) => ({ ...acc, [key]: config.reducers[key] }), {})
  }

  const json = JSON.stringify(normalized)
  return createHash('sha256').update(json).digest('hex').slice(0, 8) // 8 chars sufficient
}
```

**Why SHA-256?**
- Collision-resistant (cryptographic guarantee)
- Fast (native browser support via Web Crypto API)
- Deterministic (same config → same hash always)

### Browser Compatibility

**IndexedDB support**: 97%+ (all modern browsers)
- Chrome 24+
- Firefox 16+
- Safari 10+
- Edge (all versions)

**Fallback strategy**: If IndexedDB unavailable (rare), disable caching, log warning.

---

## Summary

**This PRD proposes intelligent caching of packed repo outputs to eliminate 20-second wait times for repeated packs.**

**Core principles:**
1. **Guarantees over guesses**: SHA-based freshness, no heuristics
2. **Transparency**: Always show cache status, staleness, user choice
3. **Fail safe**: Cache errors never break app, fall back to normal pack
4. **Simple**: LRU auto-purging, minimal user intervention required

**Expected impact:**
- 60-70% of packs become instant (<200ms vs 20s)
- 60-120s saved per user session
- Zero degradation in trust or code freshness

**Implementation**: 4-week phased rollout, starting with basic caching, adding staleness detection, storage management, and polish.

---

**Next steps:**
1. Review this PRD with team (focus: scope, UX, risks)
2. Prototype Phase 1 (foundation) in 2-3 days
3. User test with 5 early adopters
4. Iterate based on feedback
5. Ship Phase 1-2 as v2.0 beta
6. Ship Phase 3-4 as v2.1 stable

**Questions? Concerns? Ideas?** — Let's discuss.
