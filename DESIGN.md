# Design System: DevHub-AI
> Last updated: 2026-05-19

## 1. Visual Theme & Atmosphere

**Design intent:** DevHub-AI is a macOS-native **project command center**—dense, information-rich, and terminal-first in the Claude tab. The mood is calm focus (GitHub-dark neutrals), not glassmorphic spectacle.

**Sensory language:** Low-contrast canvas, crisp separators, accent blue for primary actions, green for success/running, pulsing orange for “waiting for input.”

**Key characteristics:**
- GitHub Primer–inspired dark/light palettes
- Sidebar + main workspace layout; Claude tab adds vertical session rail
- Terminal is the hero surface; Launchpad cards are secondary
- Minimal motion (150–200ms CSS transitions); respect `prefers-reduced-motion`

**Usage rules:** Do not introduce Tailwind or a second token system without an ADR. Extend CSS variables in `shared.css`.

---

## 2. Color System

### Design Tokens

| Token | Dark | Light | Role |
|-------|------|-------|------|
| `--bg-primary` | `#0d1117` | `#ffffff` | App canvas |
| `--bg-secondary` | `#161b22` | `#f6f8fa` | Sidebars, titlebar |
| `--bg-tertiary` | `#21262d` | `#e1e4e8` | Inputs, chips |
| `--bg-card` | `#1c2128` | `#ffffff` | Cards |
| `--border` | `#30363d` | `#d0d7de` | Dividers |
| `--text-primary` | `#e6edf3` | `#1f2328` | Body text |
| `--text-secondary` | `#8b949e` | `#656d76` | Labels |
| `--accent` | `#58a6ff` | `#0969da` | Links, focus, primary UI |
| `--green` | `#3fb950` | `#1a7f37` | Running, success |
| `--red` | `#f85149` | `#cf222e` | Errors, danger |
| `--orange` | `#d29922` | `#9a6700` | Waiting, warnings |
| `--purple` | `#bc8cff` | `#8250df` | MCP / skills accents |

### Session accent palette (8)

Use for sidebar chips and grid cell borders—never as full backgrounds:

| ID | Hex | Name |
|----|-----|------|
| `blue` | `#58a6ff` | Ocean Blue |
| `green` | `#3fb950` | Forest Green |
| `purple` | `#bc8cff` | Violet |
| `orange` | `#d29922` | Amber |
| `red` | `#f85149` | Coral |
| `cyan` | `#39c5cf` | Teal |
| `pink` | `#f778ba` | Rose |
| `yellow` | `#e3b341` | Gold |

### Usage rules

- Components use `var(--*)` only; no raw hex in TSX except session accent picker swatches.
- Session accent: left border 3px or status dot fill.
- Forbidden: light gray text on `--bg-primary` below 4.5:1 contrast.

---

## 3. Typography

### Font stack

- **UI:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif` (`shared.css` body)
- **Terminal:** `'JetBrains Mono', 'SF Mono', Menlo, monospace` (`XTerminal.tsx`)

### Type scale

| Role | Size | Weight | Usage |
|------|------|--------|-------|
| Titlebar | 13px | 600 | Window chrome |
| Section label | 11px | 600 | Sidebar headers, uppercase optional |
| Body | 13–14px | 400 | Lists, modals |
| Micro | 11px | 500 | Badges, hints |
| Terminal | 14px | 400 | xterm (user-adjustable Cmd+/−) |

### Fluid type

Desktop-only; no `clamp()` required. Min window 900×600.

---

## 4. Spacing & Layout

### Base unit

**4px** — gaps use 4, 8, 12, 16, 24.

### Grid

- Launchpad: `repeat(auto-fill, minmax(280px, 1fr))`
- Session grid: 1×1 … 2×4 (max 8 cells), 8px gap
- `--sidebar-width: 240px` (global); Claude session rail ~220px

### Breakpoints

| Name | Width | Behavior |
|------|-------|----------|
| `compact` | &lt; 1000px | Hide secondary labels in session rail |
| `standard` | ≥ 1000px | Default |
| `wide` | ≥ 1400px | Side panel up to 800px |

### Whitespace

- Section vertical rhythm: 16px
- Card padding: 12–16px
- Modal padding: 20px

---

## 5. Components

### Buttons

- Shape: 6px radius (`shared.css` `.btn`)
- Variants: default, `btn-primary` (green), `btn-danger`, `btn-accent`
- States: hover 0.15s background shift; disabled 0.5 opacity
- Icon placement: leading icon 16px in toolbar buttons

### Session sidebar card

- 8px vertical gap; 12px padding
- Active: `border-left` accent color; `--bg-card-hover` background
- Waiting: pulsing dot `--orange`
- Drag: 0.4 opacity ghost; drop indicator 2px `--accent` line

### Session grid cell

- Min height 120px; focused ring 2px `--accent`
- Header: nickname + close; body: live `XTerminal` when mounted
- Max 8 terminals; unfocused cells still render but receive `active={false}`

### ChatInputBar

- Unchanged moat component; targets **focused** grid/single session only

### Modals

- Overlay `rgba(0,0,0,0.5)`; modal `--bg-secondary`; max-width 500–640px
- Setup wizard, command palette, hints: same overlay pattern

### Overlays

- Hints panel: right sheet 400px or centered large modal
- Command palette: centered, 560px, fuzzy list

### Feedback

- Toast: top-right, 3s auto-dismiss
- Skeleton: Launchpad loading
- Empty Claude: CTA + preset bar

---

## 6. Iconography

- **Current:** Inline SVG (16×16) in toolbar and sidebar
- **Sizing:** 16px toolbar, 10px inline meta
- **Color:** `currentColor` / `var(--text-secondary)`; active `var(--accent)`
- **TBD:** Lucide pack adoption optional; do not mix families in one bar

---

## 7. Motion & Animation

| Duration | Use |
|----------|-----|
| 150ms | Hover, focus |
| 200ms | Panel open/close |
| 1.2s | Waiting pulse (respect reduced motion) |

**Easing:** `ease-out` for enter; no Framer Motion required.

**prefers-reduced-motion:** Disable pulse and grid layout animations.

---

## 8. Responsive

- macOS Electron desktop only
- Session grid: auto-pick layout from count (1→1×1, 2→1×2, 3–4→2×2, etc.)
- Container queries: TBD; use min-width on `.claude-sessions` for compact rail

---

## 9. Accessibility

- **Target:** WCAG 2.1 AA
- **Contrast:** Text ≥ 4.5:1; UI components ≥ 3:1
- **Focus:** Visible `outline: 2px solid var(--accent)` on interactive elements
- **Keyboard:** Grid arrow navigation; Cmd+G grid toggle; F1 hints; Cmd+Shift+P palette
- **Touch:** Sidebar targets ≥ 44px height (desktop trackpad)
- **Screen readers:** `aria-label` on icon-only toolbar buttons; live region for toasts

---

## 10. Performance

- **Grid:** Max 8 xterm instances; resize only active/focused cell on layout change
- **Scrollback:** 10k lines per terminal
- **Bundle:** Avoid Monaco unless required; hints JSON lazy-loaded
- **Daemon PTY (optional):** Reduces reconnect cost after app restart

---

## 11. SEO

N/A for desktop app. Marketing site: `docs/index.html`.

---

## 12. Dark Mode

- **Strategy:** `data-theme` on `document.documentElement`: `dark` | `light` | `system`
- **Storage:** `localStorage` key `devhub-ai-theme`
- **Gap (fixed in implementation):** xterm theme must follow `data-theme` via `getXtermTheme()`
- **Images:** N/A in terminal UI

---

## 13. Implementation Map

| Concern | Location |
|---------|----------|
| CSS tokens | `src/renderer/shared.css` |
| App theme | `src/renderer/App.tsx` |
| Terminal theme + search | `src/renderer/components/XTerminal.tsx` |
| Session colors / grid layouts | `src/shared/session-ui.ts` |
| Claude tab layout | `src/renderer/components/ClaudeSessionsView.tsx` |
| Grid UI | `src/renderer/components/SessionGrid.tsx` |
| Hints | `src/renderer/components/HintsPanel.tsx`, `src/renderer/data/claude-hints.json` |
| Command palette | `src/renderer/components/CommandPalette.tsx` |
| Setup wizard | `src/renderer/components/SetupWizard.tsx` |
| Active session persistence | `src/main/session-history.ts`, `~/.devhub-ai/active-sessions.json` |
| Presets | `src/main/preset-manager.ts`, `~/.devhub-ai/presets.json` |
| PTY daemon flag | `AppState.usePtyDaemon`, `src/main/pty-backend.ts` |
| Auto-update | `src/main/updater.ts` |
| Legacy cleanup | `src/renderer/styles.css` (unused—remove when safe) |

### Validation notes (V1–V4)

- **Strong:** Consistent GitHub-dark tokens; clear component CSS split
- **Risky:** 8× xterm memory; hardcoded terminal theme (addressed)
- **Top improvements:** Grid view, theme-synced terminal, session accents, hints panel, command palette
