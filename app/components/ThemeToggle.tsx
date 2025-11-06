"use client"

import { useTheme } from './ThemeProvider'

/**
 * Simple theme toggle link
 * Minimal visual footprint
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()

  return (
    <button
      onClick={toggleTheme}
      className="text-xs text-muted-foreground hover:text-foreground transition underline underline-offset-2 cursor-pointer"
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    >
      {theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
    </button>
  )
}
