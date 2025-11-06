"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import {
  GitHubRepo,
  SliceConfig,
  PackResult,
  TokenCountResult,
} from "@/lib/types";
import { config } from "@/lib/config";
import { loadCache, saveCache } from "@/lib/cache";
import { Spinner } from "@/app/components/Spinner";
import { assemblePackedContext } from "@/lib/assembly";
import { Chat } from "@/app/components/Chat";
import { generatePackHash } from "@/lib/packHash";

export default function Home() {
  // State - initialize with defaults, load from cache after mount
  const [orgName, setOrgName] = useState(
    process.env.NEXT_PUBLIC_GITHUB_ORG || "vana-com"
  );
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [repoBranches, setRepoBranches] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [countingTokens, setCountingTokens] = useState(false);
  const [tokenCountError, setTokenCountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);

  // Slice config
  const [includeGlobs, setIncludeGlobs] = useState("");
  const [ignoreGlobs, setIgnoreGlobs] = useState("");
  const [respectGitignore, setRespectGitignore] = useState(true);
  const [respectAiIgnore, setRespectAiIgnore] = useState(true);
  const [useDefaultPatterns, setUseDefaultPatterns] = useState(true);

  // Results
  const [packResult, setPackResult] = useState<PackResult | null>(null);
  const [tokenResult, setTokenResult] = useState<TokenCountResult | null>(null);
  const [userPrompt, setUserPrompt] = useState("");
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [packHash, setPackHash] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Track last packed state to avoid unnecessary repacks
  const [lastPackedState, setLastPackedState] = useState<string | null>(null);

  // Track last prompt used for token counting to avoid redundant counts
  const lastCountedPromptRef = useRef<string>("");

  // AbortController for cancelling in-flight requests
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track if initial load is done
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [cacheLoaded, setCacheLoaded] = useState(false);

  // External repo state
  const [externalRepoInput, setExternalRepoInput] = useState<string>("");
  const [validatedExternalRepo, setValidatedExternalRepo] = useState<GitHubRepo | null>(null);
  const [externalRepoValidating, setExternalRepoValidating] = useState(false);
  const [externalRepoError, setExternalRepoError] = useState<string | null>(null);
  const externalRepoTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track all added external repos persistently (fullName -> GitHubRepo)
  const [addedExternalRepos, setAddedExternalRepos] = useState<Map<string, GitHubRepo>>(new Map());

  // Pack cache status
  const [packCacheStatus, setPackCacheStatus] = useState<'fresh' | 'miss' | null>(null);

  // Load from cache on mount (client-side only to avoid hydration mismatch)
  useEffect(() => {
    const cache = loadCache();
    setSelectedRepos(new Set(cache.selectedRepos));
    setRepoBranches(cache.repoBranches);
    setIncludeGlobs(cache.includeGlobs);
    setIgnoreGlobs(cache.ignoreGlobs);
    setRespectGitignore(cache.respectGitignore);
    setRespectAiIgnore(cache.respectAiIgnore ?? true); // Default true for new users
    setUseDefaultPatterns(cache.useDefaultPatterns);
    setUserPrompt(cache.userPrompt);
    // Load external repos from cache
    if (cache.externalRepos && cache.externalRepos.length > 0) {
      const externalReposMap = new Map(
        cache.externalRepos.map(repo => [repo.fullName, repo])
      );
      setAddedExternalRepos(externalReposMap);
    }
    setCacheLoaded(true);
  }, []);

  // Auto-load repos on mount
  useEffect(() => {
    handleLoadRepos().then(() => {
      setInitialLoadDone(true);
    });
  }, []);

  // Auto-pack on initial load if there are cached selections
  useEffect(() => {
    if (initialLoadDone && selectedRepos.size > 0 && !packResult) {
      const currentState = getStateHash();
      handlePack();
      setLastPackedState(currentState);
    }
  }, [initialLoadDone]);

  // Save to cache whenever cached values change (but only after initial load)
  useEffect(() => {
    if (!cacheLoaded) return;

    saveCache({
      selectedRepos: Array.from(selectedRepos),
      repoBranches,
      includeGlobs,
      ignoreGlobs,
      respectGitignore,
      respectAiIgnore,
      useDefaultPatterns,
      userPrompt,
      externalRepos: Array.from(addedExternalRepos.values()),
    });
  }, [
    cacheLoaded,
    selectedRepos,
    repoBranches,
    includeGlobs,
    ignoreGlobs,
    respectGitignore,
    respectAiIgnore,
    useDefaultPatterns,
    userPrompt,
    addedExternalRepos,
  ]);

  // Generate state hash for comparison (excludes userPrompt - prompt changes only recount tokens)
  const getStateHash = useCallback(() => {
    return JSON.stringify({
      selectedRepos: Array.from(selectedRepos).sort(),
      repoBranches,
      includeGlobs,
      ignoreGlobs,
      respectGitignore,
      respectAiIgnore,
      useDefaultPatterns,
    });
  }, [
    selectedRepos,
    repoBranches,
    includeGlobs,
    ignoreGlobs,
    respectGitignore,
    respectAiIgnore,
    useDefaultPatterns,
  ]);

  // Auto-repack when selections or checkboxes change (immediate, no debounce)
  useEffect(() => {
    // Skip during initial load - let the initial load useEffect handle it
    if (!initialLoadDone) return;

    // Cancel any in-flight requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (selectedRepos.size === 0) {
      // Clear results if nothing selected
      setPackResult(null);
      setTokenResult(null);
      setPackHash(null);
      setLastPackedState(null);
      setLoading(false);
      return;
    }

    const currentState = getStateHash();
    if (currentState !== lastPackedState) {
      // Wait a tick to ensure abort signal propagates
      const timeoutId = setTimeout(() => {
        handlePack();
      }, 0);
      setLastPackedState(currentState);

      return () => clearTimeout(timeoutId);
    }
  }, [selectedRepos, respectGitignore, respectAiIgnore, useDefaultPatterns]);

  // Debounced validation for external repos
  useEffect(() => {
    // Clear previous timeout
    if (externalRepoTimeoutRef.current) {
      clearTimeout(externalRepoTimeoutRef.current);
    }

    // Reset validation state
    setValidatedExternalRepo(null);
    setExternalRepoError(null);

    // Check if search input contains a slash (external repo pattern)
    if (!repoFilter.includes('/')) {
      setExternalRepoInput("");
      return;
    }

    // Extract the external repo input
    const input = repoFilter.trim();
    setExternalRepoInput(input);

    // Validate format (must be owner/repo)
    const parts = input.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      setExternalRepoError("Use format: owner/repo");
      return;
    }

    // Debounce validation
    setExternalRepoValidating(true);
    externalRepoTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/repos/validate?repo=${encodeURIComponent(input)}`);
        const json = await res.json();

        if (json.success) {
          setValidatedExternalRepo(json.data.repo);
          setExternalRepoError(null);
        } else {
          setValidatedExternalRepo(null);
          setExternalRepoError(json.error || "Repository not found");
        }
      } catch (error) {
        setValidatedExternalRepo(null);
        setExternalRepoError("Failed to validate repository");
      } finally {
        setExternalRepoValidating(false);
      }
    }, 500);

    return () => {
      if (externalRepoTimeoutRef.current) {
        clearTimeout(externalRepoTimeoutRef.current);
      }
    };
  }, [repoFilter]);

  // Note: Token counting is NOT auto-triggered on prompt changes.
  // User must manually repack to get updated token count with new prompt.
  // This prevents constant API calls while typing.

  // Handler for text input blur (globs, prompt, branches)
  const handleTextBlur = () => {
    if (selectedRepos.size === 0) return;

    const currentState = getStateHash();
    if (currentState !== lastPackedState) {
      handlePack();
      setLastPackedState(currentState);
    }
  };

  // Handlers
  const handleLoadRepos = async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch repos from all orgs user has access to (no org parameter)
      const res = await fetch(`/api/repos`);

      const json = await res.json();

      if (!json.success) {
        throw new Error(json.error);
      }

      setRepos(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load repos");
    } finally {
      setLoading(false);
    }
  };

  const handlePack = useCallback(async () => {
    if (selectedRepos.size === 0) {
      setError("Select at least one repo");
      return;
    }

    // Create new AbortController for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setLoading(true);
    setError(null);
    setTokenResult(null);
    setPackCacheStatus(null);
    // Keep existing packResult during re-pack to avoid UI flash

    try {
      const sliceConfig: SliceConfig = {
        includeGlobs: includeGlobs
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean),
        ignoreGlobs: ignoreGlobs
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean),
        respectGitignore,
        respectAiIgnore,
        useDefaultPatterns,
      };

      const repoSelections = Array.from(selectedRepos).map((fullName) => ({
        fullName,
        branch: repoBranches[fullName], // optional branch override
      }));

      // Step 1: Fetch current SHAs for all repos (~200ms)
      const { fetchRepoSHAs, checkPackCache, storePackResult } = await import('@/lib/packCacheClient');
      const currentSHAs = await fetchRepoSHAs(repoSelections, undefined); // Uses default GitHub token

      // Step 2: Check cache with SHAs (~10ms)
      const cacheCheck = await checkPackCache(repoSelections, sliceConfig, currentSHAs);

      // Step 3: Use cache if all-fresh, otherwise pack
      let result: PackResult;

      if (cacheCheck.cacheStatus === 'all-fresh' && cacheCheck.result) {
        // Cache hit! Return instantly (<200ms total)
        console.log('✅ Cache hit: all repos fresh');
        result = cacheCheck.result;
        setPackCacheStatus('fresh');
      } else {
        // Cache miss or stale - pack via API (~20s)
        console.log(`🔄 Cache ${cacheCheck.cacheStatus}: packing via API`);
        setPackCacheStatus('miss');

        const res = await fetch("/api/pack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: abortController.signal,
          body: JSON.stringify({
            repos: repoSelections,
            sliceConfig,
          }),
        });

        const json = await res.json();

        if (!json.success) {
          throw new Error(json.error);
        }

        result = json.data;

        // Store result in cache for next time
        await storePackResult(repoSelections, sliceConfig, result, currentSHAs);
      }

      setPackResult(result);

      // Generate pack hash for chat persistence
      const hash = generatePackHash(repoSelections, sliceConfig);
      setPackHash(hash);

      // Auto-count tokens with Gemini (will update the estimate)
      if (!abortController.signal.aborted) {
        await handleCountTokens(result, abortController.signal);
      }
    } catch (err) {
      // Ignore abort errors
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to pack repos");
    } finally {
      setLoading(false);
    }
  }, [
    selectedRepos,
    repoBranches,
    includeGlobs,
    ignoreGlobs,
    respectGitignore,
    respectAiIgnore,
    useDefaultPatterns,
    // Note: userPrompt intentionally excluded - prompt changes should NOT trigger re-packing
    // handleCountTokens will use current prompt value when called
  ]);

  const handleCountTokens = async (
    result: PackResult,
    signal?: AbortSignal
  ) => {
    setCountingTokens(true);
    setTokenCountError(null); // Clear previous error
    try {
      // Assemble context on-demand with current prompt
      // This allows prompt changes to trigger re-counting without re-packing!
      const contextText = assemblePackedContext(
        result.repos.filter(r => !r.error),
        userPrompt
      );

      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal,
        body: JSON.stringify({
          modelId: config.gemini.defaultModel,
          contextText,
          userPrompt,
        }),
      });

      const json = await res.json();

      if (!json.success) {
        throw new Error(json.error);
      }

      setTokenResult(json.data);
      setTokenCountError(null);
      lastCountedPromptRef.current = userPrompt; // Update ref on successful count
    } catch (err) {
      // Ignore abort errors
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      console.error("Token counting failed:", err);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setTokenCountError(errorMsg);
    } finally {
      setCountingTokens(false);
    }
  };

  // Get complete context including prompt
  // Assembles on-demand from packed repos, allowing prompt to be edited after packing
  const getCompleteContext = (): string => {
    if (!packResult) return "";

    // Assemble context from packed repos with current prompt
    // This allows prompt to be changed without re-packing!
    return assemblePackedContext(
      packResult.repos.filter(r => !r.error),
      userPrompt
    );
  };

  const handleOpenInAI = async (platform: string, url: string) => {
    if (!packResult) return;

    // Copy to clipboard with prompt
    await navigator.clipboard.writeText(getCompleteContext());

    // Show toast with countdown
    setCopiedMessage(`✓ Copied to clipboard! Opening ${platform} in...`);
    setCountdown(3);

    // Countdown from 3 to 1
    const countdownInterval = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(countdownInterval);
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    // Open after 3 seconds
    setTimeout(() => {
      window.open(url, "_blank", "noopener,noreferrer");
      setCopiedMessage(null);
      setCountdown(null);
    }, 3000);
  };

  const handleDownload = () => {
    if (packResult) {
      const blob = new Blob([getCompleteContext()], {
        type: "text/plain",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vana-query-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);

      // Show confirmation toast
      setDownloadMessage("✓ Downloaded");
      setTimeout(() => setDownloadMessage(null), 2000);
    }
  };

  // Cache management
  const [cacheStats, setCacheStats] = useState<{ entryCount: number; totalSizeMB: number } | null>(null);

  const handleClearCache = async () => {
    if (!confirm('Clear all cached packed repos? This cannot be undone.')) {
      return;
    }

    try {
      const { clearPackCache } = await import('@/lib/packCacheClient');
      await clearPackCache();
      setCacheStats(null);
      alert('Cache cleared successfully');
    } catch (error) {
      console.error('Failed to clear cache:', error);
      alert('Failed to clear cache');
    }
  };

  // Load cache stats on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;

    (async () => {
      try {
        const { getPackCacheStats } = await import('@/lib/packCacheClient');
        const stats = await getPackCacheStats();
        setCacheStats({
          entryCount: stats.entryCount,
          totalSizeMB: stats.totalSizeMB,
        });
      } catch (error) {
        console.error('Failed to load cache stats:', error);
      }
    })();
  }, [packResult]); // Refresh after packing

  // Merge org repos with external repos (deduplicate by fullName), filter, and sort by last updated
  const allRepos = [
    ...repos,
    ...Array.from(addedExternalRepos.values()).filter(
      extRepo => !repos.some(orgRepo => orgRepo.fullName === extRepo.fullName)
    )
  ];
  const filteredRepos = allRepos
    .filter(
      (repo) =>
        repoFilter === "" ||
        repo.name.toLowerCase().includes(repoFilter.toLowerCase()) ||
        repo.fullName.toLowerCase().includes(repoFilter.toLowerCase())
    )
    .sort((a, b) => {
      // Sort selected repos to top
      const aSelected = selectedRepos.has(a.fullName);
      const bSelected = selectedRepos.has(b.fullName);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      // Then sort by push date
      return new Date(b.pushedAt).getTime() - new Date(a.pushedAt).getTime();
    });

  // Render
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 bg-neutral-950 border-b border-neutral-800 z-40 flex items-center gap-3 p-4">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-2 -ml-2 text-neutral-400 hover:text-neutral-200 transition"
          aria-label="Open menu"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <Image src="/icon-no-bg.png" alt="Vana Logo" width={24} height={24} />
        <span className="font-semibold text-sm">Vana Source Query</span>
      </div>

      {/* Backdrop (mobile only) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Two-pane layout */}
      <div className="flex pt-16 lg:pt-0">
        <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] w-full max-w-[1600px] mx-auto">
          {/* Left Sidebar */}
          <aside className={`
            fixed lg:relative
            inset-y-0 left-0
            w-[320px] lg:w-[400px]
            bg-neutral-950
            border-r border-neutral-800
            lg:sticky lg:top-0 lg:h-screen
            flex flex-col
            transition-transform duration-300
            z-50
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          `}>
            {/* Compact Header + Token Meter */}
            <div className="flex-shrink-0 p-4 border-b border-neutral-800">
              {/* Close button (mobile only) */}
              <button
                onClick={() => setSidebarOpen(false)}
                className="lg:hidden absolute top-4 right-4 p-1 text-neutral-400 hover:text-neutral-200 transition"
                aria-label="Close menu"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              {/* Logo + Title */}
              <div className="flex items-center gap-2 mb-3">
                <Image
                  src="/icon-no-bg.png"
                  alt="Vana Logo"
                  width={32}
                  height={32}
                />
                <div className="flex-1 min-w-0">
                  <h1 className="text-base font-bold truncate">Vana Source Query</h1>
                  <p className="text-[10px] text-neutral-500">
                    Load → Select → Pack → Copy
                  </p>
                </div>
              </div>

              {/* Token Meter / Loading State */}
              {(loading || (packResult && tokenResult)) && (
                <>
                  <div
                    className="w-full h-1.5 bg-neutral-900 rounded-full overflow-hidden mb-2"
                    role="progressbar"
                  >
                    {loading ? (
                      <div className="h-full w-full bg-gradient-to-r from-neutral-800 via-neutral-700 to-neutral-800 bg-[length:200%_100%] animate-shimmer" />
                    ) : (
                      <div
                        className={`h-full transition-all duration-500 ${
                          tokenResult!.status === "over"
                            ? "bg-danger"
                            : tokenResult!.status === "near"
                            ? "bg-warn"
                            : "bg-ok"
                        }`}
                        style={{
                          width: `${Math.min(
                            (tokenResult!.totalTokens / tokenResult!.modelLimit) *
                              100,
                            100
                          )}%`,
                        }}
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-neutral-500">
                    {loading ? (
                      <span className="text-neutral-400">
                        Packing {selectedRepos.size}{" "}
                        {selectedRepos.size === 1 ? "repository" : "repositories"}...
                      </span>
                    ) : (
                      <>
                        <span className="flex items-center gap-1.5">
                          {packResult!.repos.reduce(
                            (sum, r) => sum + r.stats.fileCount,
                            0
                          )}{" "}
                          files
                          {packCacheStatus === 'fresh' && (
                            <span className="text-ok" title="Loaded from cache (instant)">● cached</span>
                          )}
                          {" "}•{" "}
                          {countingTokens ? (
                            <span className="flex items-center gap-1 text-neutral-400">
                              <Spinner size="sm" />
                              Counting...
                            </span>
                          ) : (
                            <>
                              {tokenResult!.totalTokens.toLocaleString()} /{" "}
                              {(tokenResult!.modelLimit / 1000000).toFixed(1)}M
                              tokens
                            </>
                          )}
                        </span>
                        <span title={config.gemini.models[config.gemini.defaultModel]?.name || "Gemini 2.5 Flash"}>
                          {config.gemini.models[config.gemini.defaultModel]
                            ?.name || "Gemini 2.5 Flash"}
                        </span>
                      </>
                    )}
                  </div>

                  {tokenCountError && (
                    <div className="mt-2 flex items-start gap-2 text-[10px] text-warn">
                      <svg
                        className="w-3 h-3 flex-shrink-0 mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        />
                      </svg>
                      <div className="flex-1">
                        <span>
                          {tokenCountError}{" "}
                          <button
                            onClick={() =>
                              packResult && handleCountTokens(packResult)
                            }
                            className="underline hover:text-warn/80 transition cursor-pointer"
                          >
                            Retry
                          </button>
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Repositories Section - Scrollable */}
            <div className="flex-shrink-0 p-6 border-b border-neutral-800">

            {loading && repos.length === 0 ? (
              <div className="text-center py-12 text-neutral-400">
                Loading repositories...
              </div>
            ) : error && repos.length === 0 ? (
              <div className="text-center py-8 px-4">
                <svg
                  className="w-10 h-10 text-neutral-600 mx-auto mb-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <p className="text-sm text-neutral-400 mb-3">{error}</p>
                <button
                  onClick={handleLoadRepos}
                  className="btn-secondary text-xs"
                >
                  Retry
                </button>
              </div>
            ) : repos.length > 0 ? (
              <>
                {/* Search */}
                <input
                  type="text"
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  placeholder="Search repositories..."
                  className="input mb-4"
                />

                {/* Count */}
                <div className="mb-3 flex items-center justify-between text-xs text-neutral-500">
                  <span>
                    {filteredRepos.length}{" "}
                    {filteredRepos.length === 1 ? "repository" : "repositories"}
                  </span>
                  {selectedRepos.size > 0 && (
                    <span className="text-brand-500">
                      {selectedRepos.size} selected
                    </span>
                  )}
                </div>

                {/* External Repo Validation (when search contains / and not already available) */}
                {externalRepoInput && (!validatedExternalRepo ||
                  (!addedExternalRepos.has(validatedExternalRepo.fullName) &&
                   !repos.some(r => r.fullName === validatedExternalRepo.fullName))) && (
                  <div className="mb-4 p-3 border border-neutral-800 rounded-lg bg-neutral-900/30">
                    <div className="text-xs text-neutral-400 mb-2">
                      External Repository
                    </div>
                    {externalRepoValidating ? (
                      <div className="flex items-center gap-2 text-sm text-neutral-300">
                        <Spinner />
                        <span>Validating {externalRepoInput}...</span>
                      </div>
                    ) : externalRepoError ? (
                      <div className="flex items-center gap-2 text-sm text-red-400">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                        </svg>
                        <span>{externalRepoError}</span>
                      </div>
                    ) : validatedExternalRepo ? (
                      <button
                        onClick={() => {
                          const newSet = new Set(selectedRepos);
                          const isSelected = selectedRepos.has(validatedExternalRepo.fullName);
                          if (isSelected) {
                            newSet.delete(validatedExternalRepo.fullName);
                          } else {
                            newSet.add(validatedExternalRepo.fullName);
                            // Add to persistent external repos map (only if not already in org repos)
                            if (!repos.some(r => r.fullName === validatedExternalRepo.fullName)) {
                              setAddedExternalRepos(prev => new Map(prev).set(validatedExternalRepo.fullName, validatedExternalRepo));
                            }
                          }
                          setSelectedRepos(newSet);
                        }}
                        className="w-full text-left p-2 rounded hover:bg-neutral-800/50 transition"
                      >
                        <div className="flex items-center gap-3">
                          {/* Checkmark */}
                          <div className="flex-shrink-0 w-5 h-5">
                            {selectedRepos.has(validatedExternalRepo.fullName) && (
                              <div className="w-5 h-5 rounded-full bg-brand-600 flex items-center justify-center">
                                <svg
                                  className="w-3 h-3 text-white"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={3}
                                    d="M5 13l4 4L19 7"
                                  />
                                </svg>
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-neutral-100">
                                {validatedExternalRepo.name}
                              </span>
                              <span className="text-xs text-neutral-500 flex-shrink-0">
                                {validatedExternalRepo.fullName.split('/')[0]}
                              </span>
                              <span className="text-xs text-emerald-400">
                                {validatedExternalRepo.private ? "🔒 Private" : "🌐 Public"}
                              </span>
                            </div>
                            {validatedExternalRepo.description && (
                              <div className="mt-0.5 text-xs text-neutral-400 truncate">
                                {validatedExternalRepo.description}
                              </div>
                            )}
                            <div className="mt-0.5 text-xs text-neutral-500 truncate">
                              Updated {formatRelativeTime(validatedExternalRepo.pushedAt)}
                            </div>
                          </div>

                          {/* GitHub link button */}
                          <a
                            href={`https://github.com/${validatedExternalRepo.fullName}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex-shrink-0 p-2 rounded hover:bg-neutral-800 transition text-neutral-400 hover:text-neutral-100"
                            title="Open in GitHub"
                          >
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                              <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                              <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
                            </svg>
                          </a>
                        </div>
                      </button>
                    ) : null}
                  </div>
                )}

                {/* Repo List - Scrollable */}
                {filteredRepos.length > 0 ? (
                  <div className="border-t border-neutral-900 max-h-[25vh] overflow-y-auto">
                    {filteredRepos.map((repo) => {
                      const isSelected = selectedRepos.has(repo.fullName);
                      return (
                        <button
                          key={repo.fullName}
                          onClick={() => {
                            const newSet = new Set(selectedRepos);
                            if (isSelected) {
                              newSet.delete(repo.fullName);
                            } else {
                              newSet.add(repo.fullName);
                            }
                            setSelectedRepos(newSet);
                          }}
                          aria-selected={isSelected}
                          className="group w-full text-left px-3 py-3 border-b border-neutral-900 transition focus-ring hover:bg-neutral-900/30"
                        >
                          <div className="flex items-center gap-3">
                            {/* Checkmark - only visible when selected */}
                            <div className="flex-shrink-0 w-5 h-5">
                              {isSelected && (
                                <div className="w-5 h-5 rounded-full bg-brand-600 flex items-center justify-center">
                                  <svg
                                    className="w-3 h-3 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={3}
                                      d="M5 13l4 4L19 7"
                                    />
                                  </svg>
                                </div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium truncate text-neutral-100">
                                  {repo.name}
                                </span>
                                <span className="text-xs text-neutral-500 flex-shrink-0">
                                  {repo.fullName.split('/')[0]}
                                </span>
                              </div>
                              {repo.description && (
                                <div className="mt-0.5 text-xs text-neutral-400 truncate">
                                  {repo.description}
                                </div>
                              )}
                              <div className="mt-0.5 text-xs text-neutral-500 truncate">
                                Updated {formatRelativeTime(repo.pushedAt)}
                              </div>
                              {/* Branch input for selected repos */}
                              {isSelected && (
                                <div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                  <span className="text-[10px] text-neutral-500">Branch:</span>
                                  <input
                                    type="text"
                                    value={repoBranches[repo.fullName] || repo.defaultBranch}
                                    onChange={(e) => {
                                      setRepoBranches({
                                        ...repoBranches,
                                        [repo.fullName]: e.target.value,
                                      });
                                    }}
                                    onBlur={handleTextBlur}
                                    placeholder={repo.defaultBranch}
                                    className="flex-1 px-2 py-0.5 text-xs rounded border border-neutral-700 bg-neutral-800 text-neutral-200 placeholder-neutral-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                                  />
                                </div>
                              )}
                            </div>

                            {/* GitHub link button */}
                            <a
                              href={`https://github.com/${repo.fullName}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="flex-shrink-0 p-2 rounded hover:bg-neutral-800 transition text-neutral-400 hover:text-neutral-100"
                              title="Open in GitHub"
                            >
                              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                                <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
                              </svg>
                            </a>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {/* No results message */}
                {filteredRepos.length === 0 && (
                  <div className="text-center py-12 text-neutral-500">
                    <div className="text-sm">No repositories found</div>
                    <div className="text-xs mt-1">
                      Try a different search term
                    </div>
                  </div>
                )}
              </>
            ) : null}
            </div>

            {/* Settings Section - Always Visible */}
            <div className="flex-1 overflow-y-auto p-6 flex flex-col">
            {/* Filters */}
            <div>
              <div className="space-y-4">
                {/* Include globs */}
                <div>
                  <label className="block text-xs font-medium mb-1.5 text-neutral-200">
                    Include globs
                  </label>
                  <input
                    type="text"
                    value={includeGlobs}
                    onChange={(e) => setIncludeGlobs(e.target.value)}
                    onBlur={handleTextBlur}
                    placeholder="**/*.ts, src/**"
                    className="input text-xs"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Comma-separated. Leave empty for all.
                  </p>
                </div>

                {/* Ignore globs */}
                <div>
                  <label className="block text-xs font-medium mb-1.5 text-neutral-200">
                    Ignore globs
                  </label>
                  <input
                    type="text"
                    value={ignoreGlobs}
                    onChange={(e) => setIgnoreGlobs(e.target.value)}
                    onBlur={handleTextBlur}
                    placeholder="**/*.test.ts, **/dist/**"
                    className="input text-xs"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Comma-separated patterns.
                  </p>
                </div>

                {/* Respect .gitignore */}
                <label className="flex items-start gap-2 cursor-pointer group">
                  <div className="relative mt-0.5">
                    <input
                      type="checkbox"
                      checked={respectGitignore}
                      onChange={(e) =>
                        setRespectGitignore(e.target.checked)
                      }
                      className="peer sr-only"
                    />
                    <div className="w-3.5 h-3.5 rounded border border-neutral-700 bg-neutral-900 peer-checked:bg-brand-600 peer-checked:border-brand-600 transition flex items-center justify-center">
                      {respectGitignore && (
                        <svg
                          className="w-2.5 h-2.5 text-white"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="text-xs font-medium text-neutral-200">
                      Respect .gitignore
                    </div>
                  </div>
                </label>

                {/* Respect .aiignore */}
                <label className="flex items-start gap-2 cursor-pointer group">
                  <div className="relative mt-0.5">
                    <input
                      type="checkbox"
                      checked={respectAiIgnore}
                      onChange={(e) =>
                        setRespectAiIgnore(e.target.checked)
                      }
                      className="peer sr-only"
                    />
                    <div className="w-3.5 h-3.5 rounded border border-neutral-700 bg-neutral-900 peer-checked:bg-brand-600 peer-checked:border-brand-600 transition flex items-center justify-center">
                      {respectAiIgnore && (
                        <svg
                          className="w-2.5 h-2.5 text-white"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="text-xs font-medium text-neutral-200">
                      Respect AI ignore files
                    </div>
                  </div>
                </label>

                {/* Use default patterns */}
                <label className="flex items-start gap-2 cursor-pointer group">
                  <div className="relative mt-0.5">
                    <input
                      type="checkbox"
                      checked={useDefaultPatterns}
                      onChange={(e) =>
                        setUseDefaultPatterns(e.target.checked)
                      }
                      className="peer sr-only"
                    />
                    <div className="w-3.5 h-3.5 rounded border border-neutral-700 bg-neutral-900 peer-checked:bg-brand-600 peer-checked:border-brand-600 transition flex items-center justify-center">
                      {useDefaultPatterns && (
                        <svg
                          className="w-2.5 h-2.5 text-white"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="text-xs font-medium text-neutral-200">
                      Use default ignore patterns
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* Directory Structure */}
            {packResult && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold mb-4 text-neutral-100">
                  Directory Structure
                </h3>
                <div className="space-y-2">
                  {packResult.repos.map((repo, idx) => {
                    if (repo.error) return null

                    const structureMatch = repo.output.match(
                      /<directory_structure>\s*([\s\S]*?)\s*<\/directory_structure>/
                    )

                    if (!structureMatch) return null

                    return (
                      <details
                        key={idx}
                        className="group"
                      >
                        <summary className="cursor-pointer list-none">
                          <div className="flex items-center gap-2 p-2 hover:bg-neutral-900 rounded-lg transition text-xs">
                            <svg
                              className="w-3 h-3 text-neutral-500 transition-transform group-open:rotate-90 flex-shrink-0"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M9 5l7 7-7 7"
                              />
                            </svg>
                            <span className="font-mono font-medium text-neutral-200 truncate">
                              {repo.repo.split('/')[1] || repo.repo}
                            </span>
                            <span className="text-neutral-600 ml-auto flex-shrink-0">
                              {repo.stats.fileCount}
                            </span>
                          </div>
                        </summary>
                        <div className="mt-1 ml-5">
                          <pre className="text-[10px] leading-tight overflow-x-auto p-2 bg-neutral-950 rounded border border-neutral-800 font-mono whitespace-pre text-neutral-400 max-h-60 overflow-y-auto">
                            {structureMatch[1].trim()}
                          </pre>
                        </div>
                      </details>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Cache Management */}
            {cacheStats && cacheStats.entryCount > 0 && (
              <div className="mt-6 pt-6 border-t border-neutral-800">
                <h3 className="text-sm font-semibold mb-2 text-neutral-100">
                  Pack Cache
                </h3>
                <div className="text-[11px] text-neutral-500 space-y-1 mb-3">
                  <div>{cacheStats.entryCount} {cacheStats.entryCount === 1 ? 'repo' : 'repos'} cached</div>
                  <div>{cacheStats.totalSizeMB.toFixed(1)} MB used</div>
                </div>
                <button
                  onClick={handleClearCache}
                  className="text-[11px] text-neutral-400 hover:text-neutral-200 underline"
                >
                  Clear cache
                </button>
              </div>
            )}
            </div>
          </aside>

          {/* Right Pane: Controls & Results */}
          <div className="relative pb-24 px-6 sm:px-8 lg:px-12">
            {/* Global error banner */}
            {error && selectedRepos.size > 0 && (
              <div className="mb-6 p-4 bg-danger/10 border border-danger/30 rounded-xl flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-danger flex-shrink-0 mt-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <div className="flex-1">
                  <p className="text-sm text-danger">{error}</p>
                </div>
                <button
                  onClick={() => setError(null)}
                  className="text-danger/60 hover:text-danger transition"
                  aria-label="Dismiss error"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}

                {/* Chat Interface - Main CTA */}
                {packHash && (
                  <Chat
                    packedContext={getCompleteContext()}
                    packHash={packHash}
                  />
                )}

                {packResult && (
                  <>
                    {/* Errors */}
                    {packResult.errors.length > 0 && (
                      <div className="mb-6 p-4 bg-danger/10 border border-danger/30 rounded-xl">
                        <div className="font-semibold text-sm mb-2 text-danger">
                          Errors
                        </div>
                        {packResult.errors.map((err, i) => (
                          <div key={i} className="text-sm text-danger/90">
                            {err}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Success Toast */}
                    {copiedMessage && (
                      <div className="mb-6 p-4 bg-ok/10 border-2 border-ok rounded-xl text-ok text-center shadow-lg">
                        <div className="flex items-center justify-center gap-2">
                          <span className="text-sm">{copiedMessage}</span>
                          {countdown !== null && (
                            <span className="text-2xl font-bold tabular-nums">
                              {countdown}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Download Toast */}
                    {downloadMessage && (
                      <div className="mb-6 p-4 bg-ok/10 border-2 border-ok rounded-xl text-ok text-center shadow-lg">
                        <div className="flex items-center justify-center gap-2">
                          <span className="text-sm">{downloadMessage}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
          </div>
        </div>
      </div>
    </main>
  );
}

// Helper function to format relative time
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}
