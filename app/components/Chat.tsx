"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useInView } from "react-intersection-observer";
import { Message, ChatStreamEvent, RepoSelection } from "@/lib/types";
import {
  getConversation,
  saveMessages,
  updateConversation,
} from "@/lib/chatDb";
import { ChatMessage } from "./ChatMessage";

interface ChatProps {
  packedContext: string;
  conversationId: string | null; // UUID of active conversation
  modelId: string;
  thinkingBudget?: number;
  systemPrompt?: string; // Custom system instruction
  onFirstMessage?: (messageContent: string) => void; // Callback when first message is sent
  onConversationLoad?: (repoSelections: RepoSelection[]) => void; // Callback when conversation loads with repo selections
  onTokenCountChange?: (tokens: number) => void; // Callback when chat+draft token count changes
}

/**
 * Main chat interface component
 * Handles message state, persistence, streaming, and user interactions
 */
export function Chat({
  packedContext,
  conversationId,
  modelId,
  thinkingBudget,
  systemPrompt,
  onFirstMessage,
  onConversationLoad,
  onTokenCountChange,
}: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(true); // Auto-open by default
  const [showSubmitDropdown, setShowSubmitDropdown] = useState(false);
  const [exportToast, setExportToast] = useState<string | null>(null);
  const [exportCountdown, setExportCountdown] = useState<number | null>(null);
  const [conversationTokens, setConversationTokens] = useState<{
    totalTokens: number;
    modelLimit: number;
    status: "ok" | "near" | "over";
  } | null>(null);
  const [countingTokens, setCountingTokens] = useState(false);
  const [cumulativeTokens, setCumulativeTokens] = useState<{
    totalPromptTokens: number;
    totalOutputTokens: number;
  } | null>(null);
  const [draftTokens, setDraftTokens] = useState<number | null>(null);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitDropdownRef = useRef<HTMLDivElement>(null);
  const isLoadingConversationRef = useRef(false);
  const lastUsageRef = useRef<{ promptTokens: number; outputTokens: number } | null>(null);
  const draftCountTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Use Intersection Observer to track if bottom anchor is visible
  const { ref: messagesEndRef, inView: isAtBottom } = useInView({
    threshold: 0,
    rootMargin: "0px 0px 100px 0px", // Trigger slightly before actual bottom
  });

  // Count tokens for current conversation state
  // Shows total tokens for the conversation including all messages
  const countConversationTokens = useCallback(async () => {
    if (messages.length === 0) {
      setConversationTokens(null);
      return;
    }

    setCountingTokens(true);
    try {
      // Build context with ALL current messages
      // This shows the current state of the conversation
      let fullContext = packedContext;

      if (messages.length > 0) {
        const historyText = messages
          .map((msg) => {
            const role = msg.role === "user" ? "User" : "Assistant";
            return `${role}: ${msg.content}`;
          })
          .join("\n\n");
        fullContext = `${packedContext}\n\n# Conversation\n${historyText}`;
      }

      console.log(
        "[Chat] Counting tokens for conversation:",
        messages.length,
        "messages,",
        fullContext.length,
        "chars"
      );

      const response = await fetch("/api/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          modelId,
          contextText: fullContext,
        }),
      });

      if (!response.ok) {
        console.error("[Chat] Token count failed:", await response.text());
        setConversationTokens(null);
        return;
      }

      const result = await response.json();
      console.log("[Chat] Conversation tokens:", result.data.totalTokens);

      setConversationTokens({
        totalTokens: result.data.totalTokens,
        modelLimit: result.data.modelLimit,
        status: result.data.status,
      });
    } catch (error) {
      console.error("[Chat] Token counting error:", error);
      setConversationTokens(null);
    } finally {
      setCountingTokens(false);
    }
  }, [messages, packedContext, modelId]);

  // Count tokens for draft message (debounced)
  const countDraftTokens = useCallback((draftText: string) => {
    // Clear existing timeout
    if (draftCountTimeoutRef.current) {
      clearTimeout(draftCountTimeoutRef.current);
    }

    // If draft is empty, clear count
    if (!draftText.trim()) {
      setDraftTokens(null);
      return;
    }

    // Debounce: wait 500ms after user stops typing
    draftCountTimeoutRef.current = setTimeout(async () => {
      try {
        // Count ONLY the draft text (not full context - we add it to conversationTokens later)
        const response = await fetch("/api/tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            modelId,
            contextText: draftText,
          }),
        });

        if (!response.ok) {
          console.error("[Chat] Draft token count failed");
          return;
        }

        const result = await response.json();
        setDraftTokens(result.data.totalTokens);
        console.log("[Chat] Draft-only tokens:", result.data.totalTokens);
      } catch (error) {
        console.error("[Chat] Draft token counting error:", error);
      }
    }, 500);
  }, [modelId]);

  // Load conversation from IndexedDB when conversationId changes
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setInput("");
      isLoadingConversationRef.current = false;
      return;
    }

    isLoadingConversationRef.current = true;
    setInput("");

    // Capture conversationId to detect stale loads
    const loadingConversationId = conversationId;

    async function loadConvo() {
      const conversation = await getConversation(loadingConversationId);

      // Ignore stale load if conversation changed while loading
      if (conversationId !== loadingConversationId) {
        return;
      }

      if (conversation) {
        if (conversation.messages.length > 0) {
          setMessages(conversation.messages);

          // Scroll to bottom after messages render
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const container = messagesContainerRef.current;
              if (container) {
                container.scrollTop = container.scrollHeight;
              }
            });
          });
        } else {
          setMessages([]);
        }

        // Load cumulative token usage
        if (conversation.tokenUsage) {
          setCumulativeTokens({
            totalPromptTokens: conversation.tokenUsage.totalPromptTokens,
            totalOutputTokens: conversation.tokenUsage.totalOutputTokens,
          });
        } else {
          setCumulativeTokens(null);
        }

        // Always notify parent of repo selections (even if empty) for consistent state
        if (onConversationLoad) {
          const selections = conversation.repoSelections || [];
          console.log(
            "[Chat] Notifying parent of repo selections:",
            selections
          );
          onConversationLoad(selections);
        }
      } else {
        setMessages([]);
        setCumulativeTokens(null);
      }

      isLoadingConversationRef.current = false;
    }
    loadConvo();

    // Cleanup: abort any in-flight stream when switching conversations
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]); // Only reload when conversationId changes, not when callback changes

  // Save messages to IndexedDB whenever they change
  // Don't save while loading to prevent race condition where old messages get saved to new conversation
  useEffect(() => {
    if (
      conversationId &&
      messages.length > 0 &&
      !isLoadingConversationRef.current
    ) {
      saveMessages(conversationId, messages);
    }
  }, [messages, conversationId]);

  // Count tokens whenever messages change (after streaming completes)
  useEffect(() => {
    const messageCount = messages.length;
    const messagesHash = messages.map((m) => m.id).join(",");

    console.log("[Chat] Token count useEffect triggered:", {
      streaming,
      messageCount,
      messagesHash: messagesHash.substring(0, 50),
    });

    if (!streaming && messageCount > 0) {
      console.log("[Chat] Calling countConversationTokens()");
      countConversationTokens();
    } else if (messageCount === 0) {
      console.log("[Chat] No messages, clearing token count");
      setConversationTokens(null);
    }
    // countConversationTokens is stable via useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, streaming]);

  // Report chat+draft token count to parent
  useEffect(() => {
    if (onTokenCountChange) {
      const chatTokens = conversationTokens?.totalTokens || 0;
      const total = chatTokens + (draftTokens || 0);
      onTokenCountChange(total);
    }
  }, [conversationTokens, draftTokens, onTokenCountChange]);

  // Auto-scroll when messages change if we're at bottom
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    // Capture isAtBottom NOW, before any DOM updates
    const shouldScroll = isAtBottom;

    if (shouldScroll) {
      // Wait for DOM to update, then scroll
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }, [messages, isAtBottom]);

  // Auto-grow textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [input]);

  // Close submit dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        submitDropdownRef.current &&
        !submitDropdownRef.current.contains(e.target as Node)
      ) {
        setShowSubmitDropdown(false);
      }
    };

    if (showSubmitDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showSubmitDropdown]);

  // Stream a message from Gemini
  const sendMessage = async (content: string, messageIndex?: number) => {
    if (!content.trim() || streaming) return;

    // Store the conversation ID at the time of sending to detect mid-flight changes
    const sendingToConversationId = conversationId;

    // Cancel any existing stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setError(null);
    setStreaming(true);

    try {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: content.trim(),
        timestamp: Date.now(),
      };

      // If editing, delete all messages after this point
      let updatedMessages: Message[];
      if (messageIndex !== undefined) {
        updatedMessages = [...messages.slice(0, messageIndex), userMsg];
      } else {
        updatedMessages = [...messages, userMsg];
      }

      // Check if this is the first message (for auto-naming)
      const isFirstMessage =
        messages.length === 0 && messageIndex === undefined;

      setMessages(updatedMessages);
      setInput("");

      // Notify parent component of first message for auto-naming
      if (isFirstMessage && onFirstMessage) {
        onFirstMessage(content.trim());
      }

      // Add placeholder for model response
      const modelMsg: Message = {
        id: crypto.randomUUID(),
        role: "model",
        content: "",
        timestamp: Date.now(),
      };
      const messagesWithModel = [...updatedMessages, modelMsg];
      setMessages(messagesWithModel);

      // Track which message we're streaming to
      streamingMessageIdRef.current = modelMsg.id;

      // Build conversation history (exclude the current user message and placeholder)
      const conversationHistory = updatedMessages.slice(0, -1).map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Stream response from API
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: abortController.signal,
        body: JSON.stringify({
          contextText: packedContext,
          userMessage: content.trim(),
          conversationHistory:
            conversationHistory.length > 0 ? conversationHistory : undefined,
          modelId,
          thinkingBudget,
          systemPrompt,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const eventData = line.slice(6).trim();
            if (!eventData) continue;

            try {
              const event: ChatStreamEvent = JSON.parse(eventData);

              if (event.type === "chunk" && event.text) {
                setMessages((prev) => {
                  const streamingId = streamingMessageIdRef.current;
                  if (!streamingId) return prev;

                  const updated = prev.map((msg) => {
                    if (msg.id === streamingId) {
                      return { ...msg, content: msg.content + event.text };
                    }
                    return msg;
                  });
                  return updated;
                });
              } else if (event.type === "usage") {
                // Store usage metadata for later persistence
                if (event.promptTokens && event.outputTokens) {
                  lastUsageRef.current = {
                    promptTokens: event.promptTokens,
                    outputTokens: event.outputTokens,
                  };
                  console.log("[Chat] Usage metadata received:", lastUsageRef.current);
                }
              } else if (event.type === "error") {
                setError(event.error || "Unknown error occurred");
                setStreaming(false);
                streamingMessageIdRef.current = null;
                return;
              } else if (event.type === "complete") {
                // Verify conversation didn't change mid-stream
                if (conversationId !== sendingToConversationId) {
                  setError("Conversation changed while sending message. Message may have been lost.");
                  setStreaming(false);
                  streamingMessageIdRef.current = null;
                  return;
                }

                // Update conversation with token usage if available
                if (conversationId && lastUsageRef.current && streamingMessageIdRef.current) {
                  const usage = lastUsageRef.current;
                  const messageId = streamingMessageIdRef.current;

                  // Update conversation in background (don't block UI)
                  getConversation(conversationId).then(convo => {
                    if (!convo) return;

                    const currentUsage = convo.tokenUsage || {
                      totalPromptTokens: 0,
                      totalOutputTokens: 0,
                      history: [],
                    };

                    const updatedUsage = {
                      totalPromptTokens: currentUsage.totalPromptTokens + usage.promptTokens,
                      totalOutputTokens: currentUsage.totalOutputTokens + usage.outputTokens,
                      history: [
                        ...currentUsage.history,
                        {
                          timestamp: Date.now(),
                          promptTokens: usage.promptTokens,
                          outputTokens: usage.outputTokens,
                          messageId,
                        },
                      ],
                    };

                    updateConversation(conversationId, { tokenUsage: updatedUsage });
                    console.log("[Chat] Updated conversation token usage:", updatedUsage);

                    // Update state immediately
                    setCumulativeTokens({
                      totalPromptTokens: updatedUsage.totalPromptTokens,
                      totalOutputTokens: updatedUsage.totalOutputTokens,
                    });
                  });

                  // Clear usage ref for next message
                  lastUsageRef.current = null;
                }

                setStreaming(false);
                streamingMessageIdRef.current = null;
                return;
              }
            } catch (parseError) {
              console.error("[Chat] Failed to parse SSE event:", parseError);
            }
          }
        }
      }

      setStreaming(false);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Ignore abort errors
        return;
      }

      console.error("[Chat] Error:", err);
      setError(err instanceof Error ? err.message : "Failed to send message");
      setStreaming(false);
      streamingMessageIdRef.current = null;
    }
  };

  const handleSave = (messageIndex: number, newContent: string) => {
    // Save message in place without regenerating (for both user and AI messages)
    const updatedMessages = messages.map((msg, idx) =>
      idx === messageIndex ? { ...msg, content: newContent } : msg
    );
    setMessages(updatedMessages);

    // Persist to IndexedDB
    if (conversationId) {
      saveMessages(conversationId, updatedMessages);
    }

    // Recount tokens after edit
    setTimeout(() => countConversationTokens(), 100);
  };

  const handleEdit = (messageIndex: number, newContent: string) => {
    const message = messages[messageIndex];

    if (message.role === "user") {
      // User message: replace and regenerate response
      sendMessage(newContent, messageIndex);
    } else {
      // AI message: update in place without triggering API call
      // This allows editing AI responses to correct mistakes in history
      handleSave(messageIndex, newContent);
    }
  };

  const handleRetry = (messageIndex: number) => {
    // Get the user message before this model response
    const userMessage = messages[messageIndex - 1];
    if (userMessage && userMessage.role === "user") {
      // Keep messages up to and including the user message, then resend
      setMessages((prev) => prev.slice(0, messageIndex));
      sendMessage(userMessage.content, messageIndex - 1);
    }
  };

  const handleCopy = async (messageIndex: number) => {
    const message = messages[messageIndex];

    // Only copy the current message content, not previous messages
    const textToCopy = message.content;

    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch (err) {
      console.error("[Chat] Failed to copy:", err);
    }
  };

  const handleDelete = (messageIndex: number) => {
    // Remove the message at the given index
    const updatedMessages = messages.filter((_, idx) => idx !== messageIndex);
    setMessages(updatedMessages);

    // Persist to IndexedDB
    if (conversationId) {
      saveMessages(conversationId, updatedMessages);
    }
  };

  const formatFullExport = (includeDraft: boolean = false) => {
    let export_text = '';

    // Include system instructions if customized
    if (systemPrompt && systemPrompt.trim()) {
      export_text += `# System Instructions\n\n${systemPrompt.trim()}\n\n---\n\n`;
    }

    export_text += `# Packed Repository Context\n\n${packedContext}\n\n`;

    if (messages.length > 0 || (includeDraft && input.trim())) {
      export_text += `# Conversation History\n\n`;
      messages.forEach((msg) => {
        const role = msg.role === "user" ? "User" : "Assistant";
        export_text += `## ${role}\n\n${msg.content}\n\n`;
      });

      // Add draft message if requested
      if (includeDraft && input.trim()) {
        export_text += `## User (draft)\n\n${input.trim()}\n\n`;
      }
    }

    return export_text;
  };

  // Export with draft message (or without if no draft)
  const handleExportWithDraft = async (platform: string, url: string) => {
    await navigator.clipboard.writeText(formatFullExport(true));
    setShowSubmitDropdown(false);

    // Show toast with countdown
    setExportToast(`Copied! Paste into ${platform} and submit`);
    setExportCountdown(3);

    // Countdown from 3 to 1
    const countdownInterval = setInterval(() => {
      setExportCountdown((prev) => {
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
      setExportToast(null);
      setExportCountdown(null);
    }, 3000);
  };

  const handleDownloadWithDraft = () => {
    const blob = new Blob([formatFullExport(true)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `conversation-export-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setShowSubmitDropdown(false);
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setStreaming(false);
      setError("Streaming stopped by user");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !streaming) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      {/* Error banner */}
      {error && (
        <div className="mb-4 p-3 bg-danger/10 border border-danger/30 rounded-lg flex items-start gap-2">
          <svg
            className="w-4 h-4 text-danger flex-shrink-0 mt-0.5"
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
          >
            <svg
              className="w-3 h-3"
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

      {/* Export Toast - Fixed position lower right */}
      {exportToast && (
        <div className="fixed bottom-6 right-6 bg-background border border-border rounded-xl shadow-2xl z-50 min-w-[320px]">
          <div className="p-4 flex items-center gap-4">
            <div className="flex-shrink-0 w-10 h-10 bg-ok rounded-full flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-foreground">{exportToast}</div>
              {exportCountdown !== null && (
                <div className="text-xs text-muted-foreground mt-1">Opening in {exportCountdown}s...</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Messages - Flex-grow and scroll */}
      <div
        ref={messagesContainerRef}
        className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden mb-4 pt-4 px-2"
      >
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <div className="text-center max-w-md">
              <svg
                className="w-12 h-12 mx-auto mb-3 text-border"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                />
              </svg>
              <p className="text-sm">
                {packedContext
                  ? "Ask questions about your packed repositories"
                  : "Select repositories from the sidebar to get started. Or ask me anything!"}
              </p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, index) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                previousMessage={index > 0 ? messages[index - 1] : undefined}
                isLastMessage={index === messages.length - 1}
                isStreaming={streaming}
                onSave={(newContent) => handleSave(index, newContent)}
                onEdit={(newContent) => handleEdit(index, newContent)}
                onRetry={() => handleRetry(index)}
                onCopy={() => handleCopy(index)}
                onDelete={() => handleDelete(index)}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input - Sticky at bottom */}
      <div className="flex-shrink-0 relative bg-background">
        <div className="relative inline-block w-full">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              countDraftTokens(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Message Gemini"
            className="block w-full rounded-xl border border-border bg-card pl-4 pr-24 py-3 text-sm text-foreground placeholder-muted-foreground transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 resize-none overflow-hidden"
            rows={1}
            disabled={streaming}
          />
          {/* Split Button: Send + Dropdown */}
          <div className="absolute bottom-[6px] right-3 flex">
          {/* Dropdown Menu */}
          {showSubmitDropdown && !streaming && (
            <div
              ref={submitDropdownRef}
              className="absolute right-0 bottom-full mb-2 bg-card border border-border rounded-xl shadow-lg py-2 min-w-[200px] z-50"
            >
              <button
                onClick={() =>
                  handleExportWithDraft(
                    "AI Studio",
                    "https://aistudio.google.com/prompts/new_chat?model=gemini-2.5-pro"
                  )
                }
                className="w-full px-4 py-2 text-left text-sm text-foreground hover:bg-secondary transition cursor-pointer"
              >
                Copy for AI Studio
              </button>
              <button
                onClick={() =>
                  handleExportWithDraft("Gemini", "https://gemini.google.com/app")
                }
                className="w-full px-4 py-2 text-left text-sm text-foreground hover:bg-secondary transition cursor-pointer"
              >
                Copy for Gemini
              </button>
              <button
                onClick={() =>
                  handleExportWithDraft("Claude", "https://claude.ai/new")
                }
                className="w-full px-4 py-2 text-left text-sm text-foreground hover:bg-secondary transition cursor-pointer"
              >
                Copy for Claude
              </button>
              <button
                onClick={() => handleExportWithDraft("ChatGPT", "https://chatgpt.com")}
                className="w-full px-4 py-2 text-left text-sm text-foreground hover:bg-secondary transition cursor-pointer"
              >
                Copy for ChatGPT
              </button>
              <div className="border-t border-border my-1" />
              <button
                onClick={handleDownloadWithDraft}
                className="w-full px-4 py-2 text-left text-sm text-foreground hover:bg-secondary transition cursor-pointer"
              >
                Download .txt
              </button>
            </div>
          )}

          {/* Main Send Button */}
          <button
            onClick={streaming ? handleStop : () => sendMessage(input)}
            disabled={!streaming && !input.trim()}
            className="p-2 rounded-l-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
            title={streaming ? "Stop generation" : "Send message"}
          >
            {streaming ? (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" />
              </svg>
            ) : (
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
                  d="M5 10l7-7 7 7M12 3v18"
                />
              </svg>
            )}
          </button>

          {/* Dropdown Arrow Button */}
          {!streaming && (
            <button
              onClick={() => setShowSubmitDropdown(!showSubmitDropdown)}
              className="p-2 rounded-r-lg bg-brand-600 text-white hover:bg-brand-700 transition cursor-pointer border-l border-brand-500"
              title="Export options"
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
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
