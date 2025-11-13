"use client";

import { useState, useRef, useEffect } from "react";

interface SystemPromptFieldProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Isolated component for system prompt textarea
 * Prevents re-rendering parent component on every keystroke
 */
export function SystemPromptField({ value, onChange }: SystemPromptFieldProps) {
  const [localValue, setLocalValue] = useState(value);
  const hasChangedRef = useRef(false);

  // Sync local value when prop changes externally (e.g., cache load)
  useEffect(() => {
    if (!hasChangedRef.current) {
      setLocalValue(value);
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalValue(e.target.value);
    hasChangedRef.current = true;
  };

  const handleBlur = () => {
    if (hasChangedRef.current && localValue !== value) {
      onChange(localValue);
      hasChangedRef.current = false;
    }
  };

  return (
    <div className="px-4 mt-4">
      <label className="block text-xs font-medium mb-1.5 text-foreground">
        System Instructions{" "}
        <span className="text-muted-foreground font-normal">(optional)</span>
      </label>
      <textarea
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder="Leave blank for default. Customize how the AI responds..."
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground placeholder-muted-foreground focus:border-brand-500 focus:ring-1 focus:ring-brand-500 resize-none"
        rows={2}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        Default: Clear explanations for all audiences.
      </p>
    </div>
  );
}
