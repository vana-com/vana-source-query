"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import {
  GitHubRepo,
  RepoSelection,
  SliceConfig,
  PackResult,
  TokenCountResult,
  Conversation,
} from "@/lib/types";
import { config } from "@/lib/config";
import { loadCache, saveCache } from "@/lib/cache";
import { Spinner } from "@/app/components/Spinner";
import { assemblePackedContext } from "@/lib/assembly";
import { Chat } from "@/app/components/Chat";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import {
  listConversations,
  createConversation,
  updateConversation,
  deleteConversation,
} from "@/lib/chatDb";
import { getCachedRepoBranches } from "@/lib/packCache";

export default function Home() {
  // State - initialize with defaults, load from cache after mount
  const [orgName, setOrgName] = useState(
    process.env.NEXT_PUBLIC_GITHUB_ORG || "vana-com"
  );
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [cachedRepos, setCachedRepos] = useState<Map<string, boolean>>(new Map()); // Track which repo+branch combos have cache
  const [repoFilter, setRepoFilter] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [repoBranches, setRepoBranches] = useState<Record<string, string>>({});
  const [availableBranches, setAvailableBranches] = useState<Record<string, string[]>>({});
  const [focusedBranchInput, setFocusedBranchInput] = useState<string | null>(null);
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
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Conversation management
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [editingConversationId, setEditingConversationId] = useState<
    string | null
  >(null);
  const [editingName, setEditingName] = useState("");

  // Gemini settings
  const [availableModels, setAvailableModels] = useState<
    Array<{
      name: string;
      displayName: string;
      supportsThinking?: boolean;
      maxThinkingBudget?: number;
    }>
  >([]);
  const [geminiModel, setGeminiModel] = useState<string>(
    config.gemini.defaultModel
  );
  const [thinkingBudget, setThinkingBudget] = useState<number>(-1); // Default to auto (dynamic)

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
  const [validatedExternalRepo, setValidatedExternalRepo] =
    useState<GitHubRepo | null>(null);
  const [externalRepoValidating, setExternalRepoValidating] = useState(false);
  const [externalRepoError, setExternalRepoError] = useState<string | null>(
    null
  );
  const externalRepoTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track all added external repos persistently (fullName -> GitHubRepo)
  const [addedExternalRepos, setAddedExternalRepos] = useState<
    Map<string, GitHubRepo>
  >(new Map());

  // Pack cache status
  const [packCacheStatus, setPackCacheStatus] = useState<
    "fresh" | "miss" | null
  >(null);

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
    setGeminiModel(cache.geminiModel ?? config.gemini.defaultModel);
    setThinkingBudget(cache.thinkingBudget ?? -1); // Default auto
    // Load external repos from cache
    if (cache.externalRepos && cache.externalRepos.length > 0) {
      const externalReposMap = new Map(
        cache.externalRepos.map((repo) => [repo.fullName, repo])
      );
      setAddedExternalRepos(externalReposMap);
    }
    setCacheLoaded(true);
  }, []);

  // Fetch available Gemini models on mount
  useEffect(() => {
    async function fetchModels() {
      try {
        const response = await fetch("/api/gemini/models", {
          headers: {
            ...(process.env.NEXT_PUBLIC_GEMINI_API_KEY
              ? { "X-Gemini-Key": process.env.NEXT_PUBLIC_GEMINI_API_KEY }
              : {}),
          },
        });
        if (response.ok) {
          const data = await response.json();
          if (data.models && data.models.length > 0) {
            setAvailableModels(data.models);
            // If current model not in list, set to first available
            const modelNames = data.models.map((m: any) => m.name);
            if (!modelNames.includes(geminiModel)) {
              setGeminiModel(modelNames[0]);
            }
          }
        } else {
          console.warn(
            "[models] Failed to fetch models, using config defaults"
          );
        }
      } catch (error) {
        console.error("[models] Error fetching models:", error);
      }
    }
    fetchModels();
  }, []);

  // Adjust thinking budget when switching models
  useEffect(() => {
    const selectedModel = availableModels.find((m) => m.name === geminiModel);

    if (selectedModel) {
      if (!selectedModel.supportsThinking && thinkingBudget !== 0) {
        // Model doesn't support thinking at all
        console.log(
          "[page] Model",
          geminiModel,
          "does not support thinking, setting budget to 0"
        );
        setThinkingBudget(0);
      } else if (
        selectedModel.supportsThinking &&
        selectedModel.maxThinkingBudget
      ) {
        // Model supports thinking but current budget exceeds the limit
        if (thinkingBudget > selectedModel.maxThinkingBudget) {
          console.log(
            "[page] Model",
            geminiModel,
            "max budget is",
            selectedModel.maxThinkingBudget,
            "clamping from",
            thinkingBudget
          );
          setThinkingBudget(selectedModel.maxThinkingBudget);
        }
      }
    }
  }, [geminiModel, availableModels, thinkingBudget]);

  // Load conversations on mount and auto-create if none exist
  useEffect(() => {
    async function loadConvos() {
      const convos = await listConversations();
      setConversations(convos);

      if (convos.length === 0) {
        // No conversations - create default one
        const newConvo = await createConversation("Chat 1");
        setConversations([newConvo]);
        setActiveConversationId(newConvo.id);
      } else {
        // Set most recent as active
        setActiveConversationId(convos[0].id);
      }
    }
    loadConvos();
  }, []);

  // Auto-load repos on mount
  useEffect(() => {
    handleLoadRepos().then(() => {
      setInitialLoadDone(true);
    });
  }, []);

  // Load cached repo+branch combinations on mount
  useEffect(() => {
    async function loadCachedRepoBranches() {
      try {
        const cached = await getCachedRepoBranches();
        setCachedRepos(cached);
        console.log("[page] Loaded", cached.size, "cached repo+branch combos");
      } catch (error) {
        console.error("[page] Failed to load cached repo branches:", error);
        // Continue without cache indicators
      }
    }
    loadCachedRepoBranches();
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
      geminiModel,
      thinkingBudget,
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
    geminiModel,
    thinkingBudget,
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

  // Conversations are now independent of repo selection
  // No need to regenerate conversation ID when repos change

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
    if (!repoFilter.includes("/")) {
      setExternalRepoInput("");
      return;
    }

    // Extract the external repo input
    const input = repoFilter.trim();
    setExternalRepoInput(input);

    // Validate format (must be owner/repo)
    const parts = input.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      setExternalRepoError("Use format: owner/repo");
      return;
    }

    // Debounce validation
    setExternalRepoValidating(true);
    externalRepoTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/repos/validate?repo=${encodeURIComponent(input)}`
        );
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

  // Fetch available branches for a repo (lazy load on focus)
  const fetchBranchesForRepo = async (repoFullName: string) => {
    // Skip if already fetched
    if (availableBranches[repoFullName]) return;

    try {
      const res = await fetch(
        `/api/repos/branches?repo=${encodeURIComponent(repoFullName)}`,
        {
          headers: process.env.NEXT_PUBLIC_GITHUB_TOKEN
            ? { "X-GitHub-Token": process.env.NEXT_PUBLIC_GITHUB_TOKEN }
            : {},
        }
      );

      if (!res.ok) {
        console.error(`[page] Failed to fetch branches for ${repoFullName}`);
        return;
      }

      const json = await res.json();
      if (json.success) {
        setAvailableBranches((prev) => ({
          ...prev,
          [repoFullName]: json.data,
        }));
      }
    } catch (error) {
      console.error(`[page] Error fetching branches for ${repoFullName}:`, error);
    }
  };

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
      const { fetchRepoSHAs, checkPackCache, storePackResult } = await import(
        "@/lib/packCacheClient"
      );
      const currentSHAs = await fetchRepoSHAs(repoSelections, undefined); // Uses default GitHub token

      // Step 2: Check cache with SHAs (~10ms)
      const cacheCheck = await checkPackCache(
        repoSelections,
        sliceConfig,
        currentSHAs
      );

      // Step 3: Use cache if all-fresh, otherwise pack
      let result: PackResult;

      if (cacheCheck.cacheStatus === "all-fresh" && cacheCheck.result) {
        // Cache hit! Return instantly (<200ms total)
        console.log("✅ Cache hit: all repos fresh");
        result = cacheCheck.result;
        setPackCacheStatus("fresh");
      } else {
        // Cache miss or stale - pack via API (~20s)
        console.log(`🔄 Cache ${cacheCheck.cacheStatus}: packing via API`);
        setPackCacheStatus("miss");

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

        // Refresh cached repos list after successful pack
        const updatedCached = await getCachedRepoBranches();
        setCachedRepos(updatedCached);
      }

      setPackResult(result);

      // Save repo selections to active conversation
      if (activeConversationId) {
        await updateConversation(activeConversationId, { repoSelections });
        console.log("[page] Saved repo selections to conversation:", repoSelections);
      }

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
        result.repos.filter((r) => !r.error),
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
      packResult.repos.filter((r) => !r.error),
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
  const [cacheStats, setCacheStats] = useState<{
    entryCount: number;
    totalSizeMB: number;
  } | null>(null);

  const handleClearCache = async () => {
    if (!confirm("Clear all cached packed repos? This cannot be undone.")) {
      return;
    }

    try {
      const { clearPackCache } = await import("@/lib/packCacheClient");
      await clearPackCache();
      setCacheStats(null);
      alert("Cache cleared successfully");
    } catch (error) {
      console.error("Failed to clear cache:", error);
      alert("Failed to clear cache");
    }
  };

  // Conversation management handlers
  const handleNewConversation = async () => {
    try {
      const newConvo = await createConversation(
        `Chat ${conversations.length + 1}`
      );
      setConversations([newConvo, ...conversations]);
      setActiveConversationId(newConvo.id);

      // Clear repo selections and packed result for fresh start
      setSelectedRepos(new Set());
      setRepoBranches({});
      setPackResult(null);
      setTokenResult(null);
      setError(null);
      console.log("[page] Created new blank conversation");
    } catch (error) {
      console.error("Failed to create conversation:", error);
    }
  };

  const handleSwitchConversation = (conversationId: string) => {
    setActiveConversationId(conversationId);
  };

  const handleConversationLoad = (repoSelections: RepoSelection[]) => {
    // Restore repo selections when conversation loads (or clear if empty)
    console.log("[page] Restoring repo selections:", repoSelections);

    // Convert RepoSelection[] to Set<string> for selectedRepos
    const repoNames = new Set(repoSelections.map(r => r.fullName));
    setSelectedRepos(repoNames);

    // Restore branch overrides
    const branchOverrides: Record<string, string> = {};
    repoSelections.forEach(r => {
      if (r.branch) {
        branchOverrides[r.fullName] = r.branch;
      }
    });
    setRepoBranches(branchOverrides);

    // Clear pack results when switching conversations
    // User needs to re-pack if they want to see context for this conversation
    setPackResult(null);
    setTokenResult(null);
  };

  const handleRenameConversation = async (
    conversationId: string,
    newName: string
  ) => {
    if (!newName.trim()) return;

    try {
      await updateConversation(conversationId, { name: newName.trim() });
      setConversations(
        conversations.map((c) =>
          c.id === conversationId ? { ...c, name: newName.trim() } : c
        )
      );
    } catch (error) {
      console.error("Failed to rename conversation:", error);
    }
  };

  const handleDeleteConversation = async (conversationId: string) => {
    if (conversations.length === 1) {
      alert("Cannot delete the last conversation");
      return;
    }

    if (!confirm("Delete this conversation? This cannot be undone.")) {
      return;
    }

    try {
      await deleteConversation(conversationId);
      const remaining = conversations.filter((c) => c.id !== conversationId);
      setConversations(remaining);

      // Switch to first remaining conversation
      if (activeConversationId === conversationId && remaining.length > 0) {
        setActiveConversationId(remaining[0].id);
      }
    } catch (error) {
      console.error("Failed to delete conversation:", error);
    }
  };

  // Auto-name conversation from first message
  const handleFirstMessage = async (messageContent: string) => {
    if (!activeConversationId) return;

    const activeConvo = conversations.find(
      (c) => c.id === activeConversationId
    );
    if (!activeConvo) return;

    // Only auto-name if conversation still has default name (Chat N)
    if (!activeConvo.name.match(/^Chat \d+$/)) {
      return; // User has already renamed it
    }

    // Extract first ~50 chars, strip markdown, trim
    let autoName = messageContent
      .replace(/[#*`_~[\]()]/g, "") // Remove markdown symbols
      .replace(/\s+/g, " ") // Normalize whitespace
      .trim()
      .slice(0, 50);

    if (autoName.length === 50 && messageContent.length > 50) {
      autoName += "...";
    }

    // Fallback if message is empty or too short
    if (autoName.length < 3) {
      return;
    }

    // CRITICAL: Delay to avoid race condition with message auto-save
    // Chat component auto-saves messages immediately when they change (Chat.tsx:60-65)
    // If we update name simultaneously, one overwrites the other
    // Wait 100ms for message save to complete, then update name
    const conversationId = activeConversationId; // Capture for closure
    setTimeout(async () => {
      try {
        await updateConversation(conversationId, { name: autoName });

        // Update React state with latest conversations
        setConversations((prevConvos) =>
          prevConvos.map((c) =>
            c.id === conversationId ? { ...c, name: autoName } : c
          )
        );
      } catch (error) {
        console.error("Failed to auto-name conversation:", error);
      }
    }, 100);
  };

  // Load cache stats on mount
  useEffect(() => {
    if (typeof window === "undefined") return;

    (async () => {
      try {
        const { getPackCacheStats } = await import("@/lib/packCacheClient");
        const stats = await getPackCacheStats();
        setCacheStats({
          entryCount: stats.entryCount,
          totalSizeMB: stats.totalSizeMB,
        });
      } catch (error) {
        console.error("Failed to load cache stats:", error);
      }
    })();
  }, [packResult]); // Refresh after packing

  // Merge org repos with external repos (deduplicate by fullName), filter, and sort by last updated
  const allRepos = [
    ...repos,
    ...Array.from(addedExternalRepos.values()).filter(
      (extRepo) =>
        !repos.some((orgRepo) => orgRepo.fullName === extRepo.fullName)
    ),
  ];
  // Semantic search scoring
  const calculateRelevanceScore = (repo: GitHubRepo, query: string): number => {
    if (!query) return 0;

    const queryLower = query.toLowerCase();
    const nameLower = repo.name.toLowerCase();
    const fullNameLower = repo.fullName.toLowerCase();
    const descLower = (repo.description || '').toLowerCase();

    // Tokenize query into words
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);

    let score = 0;

    // Exact matches (highest priority)
    if (nameLower === queryLower) score += 100;
    if (fullNameLower === queryLower) score += 90;

    // Full query substring matches
    if (nameLower.includes(queryLower)) score += 50;
    if (fullNameLower.includes(queryLower)) score += 40;
    if (descLower.includes(queryLower)) score += 30;

    // Individual word matches (semantic-like behavior)
    queryWords.forEach(word => {
      // Name word matches
      if (nameLower.includes(word)) score += 20;
      // Full name word matches
      if (fullNameLower.includes(word)) score += 15;
      // Description word matches
      if (descLower.includes(word)) score += 10;

      // Word boundary matches (higher relevance)
      const wordBoundaryRegex = new RegExp(`\\b${word}`, 'i');
      if (wordBoundaryRegex.test(repo.name)) score += 10;
      if (wordBoundaryRegex.test(repo.fullName)) score += 8;
      if (repo.description && wordBoundaryRegex.test(repo.description)) score += 5;
    });

    // Bonus for matching multiple words
    const matchingWords = queryWords.filter(word =>
      nameLower.includes(word) || fullNameLower.includes(word) || descLower.includes(word)
    );
    if (matchingWords.length > 1) {
      score += matchingWords.length * 5;
    }

    return score;
  };

  const filteredRepos = allRepos
    .map(repo => ({
      repo,
      relevanceScore: repoFilter ? calculateRelevanceScore(repo, repoFilter) : 0
    }))
    .filter(({ relevanceScore }) => repoFilter === "" || relevanceScore > 0)
    .sort((a, b) => {
      // Sort selected repos to top
      const aSelected = selectedRepos.has(a.repo.fullName);
      const bSelected = selectedRepos.has(b.repo.fullName);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;

      // If searching, sort by relevance score
      if (repoFilter) {
        if (b.relevanceScore !== a.relevanceScore) {
          return b.relevanceScore - a.relevanceScore;
        }
      }

      // Then sort by push date
      return new Date(b.repo.pushedAt).getTime() - new Date(a.repo.pushedAt).getTime();
    })
    .map(({ repo }) => repo);

  // Render
  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 bg-background border-b border-border z-40 flex items-center gap-3 p-4">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-2 -ml-2 text-muted-foreground hover:text-foreground transition"
          aria-label="Open menu"
        >
          <svg
            className="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
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
        <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] w-full mx-auto">
          {/* Left Sidebar */}
          <aside
            className={`
            fixed lg:relative
            inset-y-0 left-0
            w-[320px] lg:w-[400px]
            bg-background
            border-r border-border
            lg:sticky lg:top-0 lg:h-screen
            overflow-y-auto
            transition-transform duration-300
            z-50
            ${
              sidebarOpen
                ? "translate-x-0"
                : "-translate-x-full lg:translate-x-0"
            }
          `}
          >
            {/* Compact Header + Token Meter */}
            <div className="flex-shrink-0 p-4 border-b border-border">
              {/* Close button (mobile only) */}
              <button
                onClick={() => setSidebarOpen(false)}
                className="lg:hidden absolute top-4 right-4 p-1 text-muted-foreground hover:text-foreground transition"
                aria-label="Close menu"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
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
                  <h1 className="text-base font-bold truncate">
                    Vana Source Query
                  </h1>
                </div>
              </div>

              {/* Token Meter / Loading State */}
              {(loading || (packResult && tokenResult)) && (
                <>
                  <div
                    className="w-full h-1.5 bg-card rounded-full overflow-hidden mb-2"
                    role="progressbar"
                  >
                    {loading ? (
                      <div className="h-full w-full bg-gradient-to-r from-secondary via-accent to-secondary bg-[length:200%_100%] animate-shimmer" />
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
                            (tokenResult!.totalTokens /
                              tokenResult!.modelLimit) *
                              100,
                            100
                          )}%`,
                        }}
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    {loading ? (
                      <span className="text-muted-foreground">
                        Packing {selectedRepos.size}{" "}
                        {selectedRepos.size === 1
                          ? "repository"
                          : "repositories"}
                        ...
                      </span>
                    ) : (
                      <>
                        <span className="flex items-center gap-1.5">
                          {packResult!.repos.reduce(
                            (sum, r) => sum + r.stats.fileCount,
                            0
                          )}{" "}
                          files •{" "}
                          {countingTokens ? (
                            <span className="flex items-center gap-1 text-muted-foreground">
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
                        <span>
                          {availableModels.find((m) => m.name === geminiModel)
                            ?.displayName || geminiModel}
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

            {/* Conversations */}
            <div className="flex-shrink-0 border-b border-border">
              <div className="px-4 pt-4 pb-3">
                {/* Header with inline New Chat button */}
                <div className="flex items-center justify-between mb-3">
                  <div className="eyebrow">Conversations</div>
                  <button
                    onClick={handleNewConversation}
                    className="text-xs text-brand-500 hover:text-brand-400 transition cursor-pointer font-medium"
                  >
                    + New
                  </button>
                </div>
              </div>

              {/* Conversation List - Scrollable */}
              {conversations.length > 0 ? (
                <div className="max-h-[30vh] overflow-y-auto">
                  {conversations.map((convo) => {
                    const isActive = convo.id === activeConversationId;
                    const isEditing = convo.id === editingConversationId;

                    return (
                      <div
                        key={convo.id}
                        className={`group relative border-b border-border/50 ${
                          isActive
                            ? "bg-secondary"
                            : "hover:bg-card"
                        } transition`}
                      >
                        {isEditing ? (
                          // Inline rename input
                          <div className="px-4 py-3">
                            <input
                              type="text"
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onBlur={() => {
                                handleRenameConversation(convo.id, editingName);
                                setEditingConversationId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  handleRenameConversation(
                                    convo.id,
                                    editingName
                                  );
                                  setEditingConversationId(null);
                                } else if (e.key === "Escape") {
                                  setEditingConversationId(null);
                                }
                              }}
                              autoFocus
                              className="w-full rounded border border-brand-500 bg-card px-2 py-1 text-sm text-foreground focus:outline-none"
                            />
                          </div>
                        ) : (
                          <div
                            onClick={() => handleSwitchConversation(convo.id)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                handleSwitchConversation(convo.id);
                              }
                            }}
                            className="w-full text-left px-4 py-2 flex items-center gap-2 cursor-pointer"
                          >
                            {/* Conversation name */}
                            <span
                              className={`flex-1 text-sm truncate ${
                                isActive
                                  ? "text-foreground font-medium"
                                  : "text-foreground"
                              }`}
                            >
                              {convo.name}
                            </span>

                            {/* Hover actions - desktop only */}
                            <div className="hidden sm:flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingConversationId(convo.id);
                                  setEditingName(convo.name);
                                }}
                                className="p-1 rounded hover:bg-accent transition text-muted-foreground hover:text-foreground"
                                title="Rename"
                              >
                                <svg
                                  className="w-3.5 h-3.5"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                  />
                                </svg>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteConversation(convo.id);
                                }}
                                className="p-1 rounded hover:bg-accent transition text-muted-foreground hover:text-red-400"
                                title="Delete"
                              >
                                <svg
                                  className="w-3.5 h-3.5"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                  />
                                </svg>
                              </button>
                            </div>

                            {/* Mobile actions - always visible on small screens */}
                            <div className="flex sm:hidden items-center gap-1 flex-shrink-0">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingConversationId(convo.id);
                                  setEditingName(convo.name);
                                }}
                                className="p-1.5 rounded hover:bg-accent transition text-muted-foreground"
                                title="Rename"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                  />
                                </svg>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteConversation(convo.id);
                                }}
                                className="p-1.5 rounded hover:bg-accent transition text-muted-foreground"
                                title="Delete"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                  />
                                </svg>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No conversations yet
                </div>
              )}
            </div>

            {/* Repositories Section */}
            {loading && repos.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                Loading repositories...
              </div>
            ) : error && repos.length === 0 ? (
              <div className="text-center py-8 px-4">
                <svg
                  className="w-10 h-10 text-muted-foreground mx-auto mb-3"
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
                <p className="text-sm text-muted-foreground mb-3">{error}</p>
                <button
                  onClick={handleLoadRepos}
                  className="btn-secondary text-xs"
                >
                  Retry
                </button>
              </div>
            ) : repos.length > 0 ? (
              <div className="border-b border-border">
                <div className="px-4 pt-4 pb-3">
                    <div className="relative mb-3">
                      <input
                        type="text"
                        value={repoFilter}
                        onChange={(e) => setRepoFilter(e.target.value)}
                        placeholder="Search repositories..."
                        className="input pr-24"
                      />
                      <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-xs text-muted-foreground">
                        {filteredRepos.length}{" "}
                        {filteredRepos.length === 1 ? "repo" : "repos"}
                      </div>
                    </div>
                    {selectedRepos.size > 0 && (
                      <div className="mb-3 flex items-center justify-end gap-2 text-xs">
                        <span className="text-brand-500">
                          {selectedRepos.size} selected
                        </span>
                        <button
                          onClick={() => setSelectedRepos(new Set())}
                          className="text-muted-foreground hover:text-foreground underline cursor-pointer"
                        >
                          clear
                        </button>
                      </div>
                    )}
                  </div>

                  {/* External Repo Validation (when search contains / and not already available) */}
                  {externalRepoInput &&
                    (!validatedExternalRepo ||
                      (!addedExternalRepos.has(
                        validatedExternalRepo.fullName
                      ) &&
                        !repos.some(
                          (r) => r.fullName === validatedExternalRepo.fullName
                        ))) && (
                      <div className="mb-4 p-3 border border-border rounded-lg bg-card">
                        <div className="text-xs text-muted-foreground mb-2">
                          External Repository
                        </div>
                        {externalRepoValidating ? (
                          <div className="flex items-center gap-2 text-sm text-foreground">
                            <Spinner />
                            <span>Validating {externalRepoInput}...</span>
                          </div>
                        ) : externalRepoError ? (
                          <div className="flex items-center gap-2 text-sm text-red-400">
                            <svg
                              className="w-4 h-4"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path
                                fillRule="evenodd"
                                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                                clipRule="evenodd"
                              />
                            </svg>
                            <span>{externalRepoError}</span>
                          </div>
                        ) : validatedExternalRepo ? (
                          <button
                            onClick={() => {
                              const newSet = new Set(selectedRepos);
                              const isSelected = selectedRepos.has(
                                validatedExternalRepo.fullName
                              );
                              if (isSelected) {
                                newSet.delete(validatedExternalRepo.fullName);
                              } else {
                                newSet.add(validatedExternalRepo.fullName);
                                // Add to persistent external repos map (only if not already in org repos)
                                if (
                                  !repos.some(
                                    (r) =>
                                      r.fullName ===
                                      validatedExternalRepo.fullName
                                  )
                                ) {
                                  setAddedExternalRepos((prev) =>
                                    new Map(prev).set(
                                      validatedExternalRepo.fullName,
                                      validatedExternalRepo
                                    )
                                  );
                                }
                              }
                              setSelectedRepos(newSet);
                            }}
                            className="w-full text-left p-2 rounded hover:bg-secondary transition"
                          >
                            <div className="flex items-center gap-3">
                              {/* Checkmark */}
                              <div className="flex-shrink-0 w-5 h-5">
                                {selectedRepos.has(
                                  validatedExternalRepo.fullName
                                ) && (
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
                                  <span className="text-sm font-medium text-foreground">
                                    {validatedExternalRepo.name}
                                  </span>
                                  {(() => {
                                    const branch = repoBranches[validatedExternalRepo.fullName] || validatedExternalRepo.defaultBranch;
                                    const cacheKey = `${validatedExternalRepo.fullName}:${branch}`;
                                    return cachedRepos?.has(cacheKey) && (
                                      <span
                                        className="text-ok text-xs flex-shrink-0"
                                        title="Cached"
                                      >
                                        ●
                                      </span>
                                    );
                                  })()}
                                  <span className="text-xs text-muted-foreground flex-shrink-0">
                                    {
                                      validatedExternalRepo.fullName.split(
                                        "/"
                                      )[0]
                                    }
                                  </span>
                                  <span className="text-xs text-emerald-400">
                                    {validatedExternalRepo.private
                                      ? "🔒 Private"
                                      : "🌐 Public"}
                                  </span>
                                </div>
                                {validatedExternalRepo.description && (
                                  <div className="mt-0.5 text-xs text-muted-foreground truncate">
                                    {validatedExternalRepo.description}
                                  </div>
                                )}
                                <div className="mt-0.5 text-xs text-muted-foreground truncate">
                                  Updated{" "}
                                  {formatRelativeTime(
                                    validatedExternalRepo.pushedAt
                                  )}
                                </div>
                              </div>

                              {/* GitHub link button */}
                              <a
                                href={`https://github.com/${validatedExternalRepo.fullName}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="flex-shrink-0 p-2 rounded hover:bg-secondary transition text-muted-foreground hover:text-foreground"
                                title="Open in GitHub"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="currentColor"
                                  viewBox="0 0 20 20"
                                >
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
                    <div className="border-t border-border/50 max-h-[25vh] overflow-y-auto">
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
                            className="group w-full text-left px-3 py-3 border-b border-border/50 transition focus-ring hover:bg-card cursor-pointer"
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
                                  <span className="text-sm font-medium truncate text-foreground">
                                    {repo.name}
                                  </span>
                                  {(() => {
                                    const branch = repoBranches[repo.fullName] || repo.defaultBranch;
                                    const cacheKey = `${repo.fullName}:${branch}`;
                                    return cachedRepos?.has(cacheKey) && (
                                      <span
                                        className="text-ok text-xs flex-shrink-0"
                                        title="Cached"
                                      >
                                        ●
                                      </span>
                                    );
                                  })()}
                                  <span className="text-xs text-muted-foreground flex-shrink-0">
                                    {repo.fullName.split("/")[0]}
                                  </span>
                                </div>
                                {repo.description && (
                                  <div className="mt-0.5 text-xs text-muted-foreground truncate">
                                    {repo.description}
                                  </div>
                                )}
                                <div className="mt-0.5 text-xs text-muted-foreground truncate">
                                  Updated {formatRelativeTime(repo.pushedAt)}
                                </div>
                                {/* Branch input for selected repos - autocomplete */}
                                {isSelected && (
                                  <div
                                    className="mt-2 flex items-center gap-2 relative"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <span className="text-[10px] text-muted-foreground">
                                      Branch:
                                    </span>
                                    <div className="flex-1 relative">
                                      <input
                                        type="text"
                                        value={
                                          repoBranches[repo.fullName] ||
                                          repo.defaultBranch
                                        }
                                        onChange={(e) => {
                                          setRepoBranches({
                                            ...repoBranches,
                                            [repo.fullName]: e.target.value,
                                          });
                                        }}
                                        onFocus={() => {
                                          setFocusedBranchInput(repo.fullName);
                                          fetchBranchesForRepo(repo.fullName);
                                        }}
                                        onBlur={() => {
                                          // Delay to allow clicking dropdown
                                          setTimeout(() => setFocusedBranchInput(null), 200);
                                          handleTextBlur();
                                        }}
                                        placeholder={repo.defaultBranch}
                                        className="w-full px-2 py-0.5 text-xs rounded border border-border bg-secondary text-foreground placeholder-muted-foreground focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                                      />

                                      {/* Branch dropdown */}
                                      {focusedBranchInput === repo.fullName && availableBranches[repo.fullName] && (
                                        <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
                                          {availableBranches[repo.fullName]
                                            .filter(branch =>
                                              branch.toLowerCase().includes(
                                                (repoBranches[repo.fullName] || repo.defaultBranch).toLowerCase()
                                              )
                                            )
                                            .slice(0, 20)
                                            .map(branch => (
                                              <button
                                                key={branch}
                                                type="button"
                                                onMouseDown={(e) => {
                                                  e.preventDefault();
                                                  setRepoBranches({
                                                    ...repoBranches,
                                                    [repo.fullName]: branch,
                                                  });
                                                  setFocusedBranchInput(null);
                                                  handleTextBlur();
                                                }}
                                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-secondary transition"
                                              >
                                                {branch}
                                              </button>
                                            ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* GitHub link button */}
                              <a
                                href={`https://github.com/${repo.fullName}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="flex-shrink-0 p-2 rounded hover:bg-secondary transition text-muted-foreground hover:text-foreground"
                                title="Open in GitHub"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="currentColor"
                                  viewBox="0 0 20 20"
                                >
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
                  <div className="text-center py-12 text-muted-foreground">
                    <div className="text-sm">No repositories found</div>
                    <div className="text-xs mt-1">
                      Try a different search term
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {/* Settings Section */}
            <div className="px-4 pt-4 pb-6 space-y-4">
                {/* Model Selection */}
                <div>
                  <label className="block text-xs font-medium mb-1.5 text-foreground">
                    Model
                  </label>
                  <select
                    value={geminiModel}
                    onChange={(e) => setGeminiModel(e.target.value)}
                    className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground focus:border-brand-500 focus:ring-1 focus:ring-brand-500 cursor-pointer"
                  >
                    {availableModels.length > 0 ? (
                      availableModels.map((model) => (
                        <option key={model.name} value={model.name}>
                          {model.displayName}
                        </option>
                      ))
                    ) : (
                      <option value={config.gemini.defaultModel}>
                        Loading models...
                      </option>
                    )}
                  </select>
                </div>

                {/* Thinking Budget (only for models that support thinking) */}
                {(() => {
                  const selectedModel = availableModels.find(
                    (m) => m.name === geminiModel
                  );
                  const maxBudget = selectedModel?.maxThinkingBudget || 24576;
                  const maxLabel = maxBudget === 32768 ? "32K" : "24K";

                  return selectedModel?.supportsThinking ? (
                    <div>
                      <label className="block text-xs font-medium mb-1.5 text-foreground">
                        Thinking Mode
                        <span
                          className="text-muted-foreground ml-1"
                          title="Controls reasoning depth: Auto adapts to complexity, Maximum for deep analysis, Off for speed"
                        >
                          ⓘ
                        </span>
                      </label>
                      <select
                        value={thinkingBudget}
                        onChange={(e) =>
                          setThinkingBudget(Number(e.target.value))
                        }
                        className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground focus:border-brand-500 focus:ring-1 focus:ring-brand-500 cursor-pointer"
                      >
                        <option value={-1}>Auto (dynamic)</option>
                        <option value={maxBudget}>Maximum ({maxLabel})</option>
                        <option value={0}>Off (fastest)</option>
                      </select>
                    </div>
                  ) : null;
                })()}

                {/* Include globs */}
                <div>
                  <label className="block text-xs font-medium mb-1.5 text-foreground">
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
                  <p className="mt-1 text-xs text-muted-foreground">
                    Comma-separated. Leave empty for all.
                  </p>
                </div>

                {/* Ignore globs */}
                <div>
                  <label className="block text-xs font-medium mb-1.5 text-foreground">
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
                  <p className="mt-1 text-xs text-muted-foreground">
                    Comma-separated patterns.
                  </p>
                </div>

                {/* Respect .gitignore */}
                <label className="flex items-start gap-2 cursor-pointer group">
                  <div className="relative mt-0.5">
                    <input
                      type="checkbox"
                      checked={respectGitignore}
                      onChange={(e) => setRespectGitignore(e.target.checked)}
                      className="peer sr-only"
                    />
                    <div className="w-3.5 h-3.5 rounded border border-border bg-card peer-checked:bg-brand-600 peer-checked:border-brand-600 transition flex items-center justify-center">
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
                    <div className="text-xs font-medium text-foreground">
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
                      onChange={(e) => setRespectAiIgnore(e.target.checked)}
                      className="peer sr-only"
                    />
                    <div className="w-3.5 h-3.5 rounded border border-border bg-card peer-checked:bg-brand-600 peer-checked:border-brand-600 transition flex items-center justify-center">
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
                    <div className="text-xs font-medium text-foreground">
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
                      onChange={(e) => setUseDefaultPatterns(e.target.checked)}
                      className="peer sr-only"
                    />
                    <div className="w-3.5 h-3.5 rounded border border-border bg-card peer-checked:bg-brand-600 peer-checked:border-brand-600 transition flex items-center justify-center">
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
                    <div className="text-xs font-medium text-foreground">
                      Use default ignore patterns
                    </div>
                  </div>
                </label>
              </div>

              {/* Directory Structure */}
              {packResult && (
                <div className="px-4 mt-6">
                  <h3 className="text-sm font-semibold mb-4 text-foreground">
                    Directory Structures
                  </h3>
                  <div className="space-y-2">
                    {packResult.repos.map((repo, idx) => {
                      if (repo.error) return null;

                      const structureMatch = repo.output.match(
                        /<directory_structure>\s*([\s\S]*?)\s*<\/directory_structure>/
                      );

                      if (!structureMatch) return null;

                      return (
                        <details key={idx} className="group">
                          <summary className="cursor-pointer list-none">
                            <div className="flex items-center gap-2 p-2 hover:bg-card rounded-lg transition text-xs">
                              <svg
                                className="w-3 h-3 text-muted-foreground transition-transform group-open:rotate-90 flex-shrink-0"
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
                              <span className="font-mono font-medium text-foreground truncate">
                                {repo.repo.split("/")[1] || repo.repo}
                              </span>
                              <span className="text-muted-foreground ml-auto flex-shrink-0">
                                {repo.stats.fileCount}
                              </span>
                            </div>
                          </summary>
                          <div className="mt-1 ml-5">
                            <pre className="text-[10px] leading-tight overflow-x-auto p-2 bg-background rounded border border-border font-mono whitespace-pre text-muted-foreground max-h-60 overflow-y-auto">
                              {structureMatch[1].trim()}
                            </pre>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Theme Toggle - Bottom of sidebar */}
              <div className="mt-auto px-4 pb-4 pt-2 flex justify-center">
                <ThemeToggle />
              </div>
          </aside>

          {/* Right Pane: Controls & Results */}
          <div className="flex flex-col px-6 sm:px-8 lg:px-12 min-h-[calc(100vh-4rem)] lg:min-h-screen min-w-0">
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
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            )}

            {/* Chat Interface - Main CTA */}
            {activeConversationId && (
              <Chat
                packedContext={getCompleteContext()}
                conversationId={activeConversationId}
                modelId={geminiModel}
                thinkingBudget={
                  availableModels.find((m) => m.name === geminiModel)
                    ?.supportsThinking
                    ? thinkingBudget
                    : undefined
                }
                onFirstMessage={handleFirstMessage}
                onConversationLoad={handleConversationLoad}
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
