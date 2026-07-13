import { useEffect } from 'react'

interface Shortcuts {
  onSearch: () => void
  onTab1: () => void
  onTab2: () => void
  onTab3?: () => void
  onTab4?: () => void
  onTab5?: () => void
  onEscape: () => void
  onHelp: () => void
}

export function useKeyboardShortcuts(shortcuts: Shortcuts) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'

      // Cmd+K or Ctrl+K - focus search (unless in terminal)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        const active = document.activeElement
        const inTerminal = active && (active.closest('.xterminal-container') || active.classList.contains('xterm-helper-textarea'))
        if (!inTerminal) {
          e.preventDefault()
          shortcuts.onSearch()
        }
        return
      }

      // Escape - close modal/exit mode
      if (e.key === 'Escape') {
        shortcuts.onEscape()
        return
      }

      // Don't process single-key shortcuts while typing
      if (isTyping) return

      // Cmd+1 / Cmd+2 - switch tabs
      if ((e.metaKey || e.ctrlKey) && e.key === '1') {
        e.preventDefault()
        shortcuts.onTab1()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '2') {
        e.preventDefault()
        shortcuts.onTab2()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '3') {
        e.preventDefault()
        shortcuts.onTab3?.()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '4') {
        e.preventDefault()
        shortcuts.onTab4?.()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '5') {
        e.preventDefault()
        shortcuts.onTab5?.()
        return
      }

      // ? - show help
      if (e.key === '?') {
        shortcuts.onHelp()
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [shortcuts])
}
