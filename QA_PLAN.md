# DevHub-AI Terminal QA Plan

> **Version**: 1.0  
> **Scope**: End-to-end quality assurance for the DevHub-AI terminal experience, with emphasis on Claude-agent resilience, environment safety, and failure recovery.  
> **Audience**: Agents and engineers executing QA. Every test is written to be directly actionable.

---

## Table of Contents

1. [QA Strategy](#1-qa-strategy)
2. [Architecture Context](#2-architecture-context)
3. [Test Plan: Core Terminal Stability](#3-test-plan-core-terminal-stability)
4. [Test Plan: Claude-Specific Resilience](#4-test-plan-claude-specific-resilience)
5. [Test Plan: Environment Safety & Recovery](#5-test-plan-environment-safety--recovery)
6. [Test Plan: Dangerous Mode](#6-test-plan-dangerous-mode)
7. [Test Plan: Security & Guardrails](#7-test-plan-security--guardrails)
8. [Test Plan: User Experience & Clarity](#8-test-plan-user-experience--clarity)
9. [Test Plan: Agent Behavior Expectations](#9-test-plan-agent-behavior-expectations)
10. [Risk Matrix](#10-risk-matrix)
11. [Release-Blocking Scenarios](#11-release-blocking-scenarios)
12. [Telemetry & Logging Recommendations](#12-telemetry--logging-recommendations)
13. [Dangerous Mode Proposal](#13-dangerous-mode-proposal)

---

## 1. QA Strategy

### Approach

| Layer | Method | Tooling |
|-------|--------|---------|
| Unit | Isolated function tests for pty-manager, IPC handlers, input validation | Vitest, node-pty mocks |
| Integration | Main ↔ Renderer IPC round-trips, PTY lifecycle, session management | Vitest + Electron test harness |
| Component | XTerminal rendering, session tabs, exit overlays, error states | Vitest + @testing-library/react |
| E2E | Full app flows: create session → run commands → exit/resume | Playwright (existing setup) |
| Manual / Exploratory | Edge cases requiring real shell behavior, timing, or hardware variance | Checklist-driven |

### Coverage Targets

| Area | Target | Current |
|------|--------|---------|
| pty-manager.ts | 90% line coverage | ~15% (only guard clauses tested) |
| IPC handlers (index.ts terminal section) | 80% branch coverage | 0% |
| XTerminal.tsx | 70% branch coverage | 0% |
| ClaudeSessionsView.tsx (terminal logic) | 70% branch coverage | 0% |
| E2E critical paths | 100% of release-blocking scenarios | 0% |

### Test Severity Levels

| Level | Meaning | SLA |
|-------|---------|-----|
| **P0 – Blocker** | App crashes, data loss, security breach, shell escape | Must fix before any release |
| **P1 – Critical** | Terminal unusable, session lost, no recovery path | Must fix before stable release |
| **P2 – Major** | Feature degraded but workaround exists | Should fix in current cycle |
| **P3 – Minor** | Cosmetic, non-blocking UX issue | Fix when convenient |

---

## 2. Architecture Context

```
┌─────────────────────────────────────────────────┐
│                   Renderer                       │
│  App.tsx → ClaudeSessionsView → XTerminal       │
│  (xterm.js v6, FitAddon, link provider)         │
│          │                    ▲                  │
│     ptyWrite/resize      onPtyData/onPtyExit    │
│          │                    │                  │
├──────────┼────────────────────┼──────────────────┤
│          ▼     Preload        │                  │
│     contextBridge.exposeInMainWorld('api', ...)  │
├──────────┼────────────────────┼──────────────────┤
│          ▼      Main          │                  │
│   ipcMain handlers ──► PtyManager               │
│     pty-create                │                  │
│     pty-write            node-pty spawn          │
│     pty-resize           /bin/zsh -i             │
│     pty-destroy              │                  │
│     pty-list-sessions        ▼                  │
│                     Shell Process (PTY)          │
│                         │                        │
│                    claude CLI                     │
│                    (--dangerously-skip-perms)     │
└─────────────────────────────────────────────────┘
```

**Key facts for testers:**
- Shell is hardcoded to `/bin/zsh` — no fallback.
- Initial command is sent after a fixed 800ms delay.
- `pty-write` and `pty-resize` are fire-and-forget (`ipcMain.on`, not `ipcMain.handle`).
- No input validation on IPC payloads.
- Claude is launched with `--dangerously-skip-permissions` by default.
- Sessions are identified by `claude-<base36-timestamp>` strings.

---

## 3. Test Plan: Core Terminal Stability

### T-CORE-001: Basic Session Lifecycle

| Field | Value |
|-------|-------|
| **Scenario** | Create a session, execute a command, see output, destroy session |
| **Preconditions** | App running, at least one folder configured |
| **Steps** | 1. Click folder to start Claude session. 2. Wait for terminal to render. 3. Type `echo hello` in the terminal. 4. Observe output. 5. Close session. |
| **Expected** | Terminal opens within 3s. Output shows `hello`. Session closes cleanly, PTY is killed, tab is removed. |
| **Failure signals** | Terminal never renders. Output missing. PTY process orphaned after close (`ps aux | grep node-pty`). |
| **Recovery** | Restart app; orphan PTY processes should be killed on app quit. |
| **Severity** | P0 |

### T-CORE-002: Streaming Output — Large Volume

| Field | Value |
|-------|-------|
| **Scenario** | Command that produces >100K lines of output |
| **Preconditions** | Active session |
| **Steps** | 1. Run `seq 1 200000` or `yes | head -200000`. 2. Monitor memory usage and frame rate. 3. After completion, scroll up. |
| **Expected** | Output streams without app freeze or crash. Scrollback buffer is accessible. Memory stays below 500MB delta. |
| **Failure signals** | App becomes unresponsive. Renderer crashes. Memory exceeds 1GB delta. |
| **Recovery** | xterm.js scrollback limit should cap buffer. If not configured, this is a bug to fix. |
| **Severity** | P1 |

### T-CORE-003: Streaming Output — Binary / Control Characters

| Field | Value |
|-------|-------|
| **Scenario** | Command produces binary or unusual control sequences |
| **Preconditions** | Active session |
| **Steps** | 1. Run `cat /bin/ls` (binary). 2. Run `printf '\e[?1049h\e[?1049l'` (alt screen toggle). 3. Run `tput reset`. |
| **Expected** | Terminal does not crash. May show garbled output for binary, but recovers after `reset` or `clear`. No IPC channel corruption. |
| **Failure signals** | Terminal stuck in alt-screen. Subsequent commands don't render. IPC channel stops working. |
| **Recovery** | Cmd+K (clear) or destroy and recreate session. |
| **Severity** | P1 |

### T-CORE-004: Long-Running Command

| Field | Value |
|-------|-------|
| **Scenario** | Command runs for >5 minutes |
| **Preconditions** | Active session |
| **Steps** | 1. Run `sleep 600` or `npm install` in a large project. 2. Switch tabs. 3. Return to terminal tab after 3+ minutes. |
| **Expected** | Command continues running. Terminal reconnects to output stream on tab switch. Waiting indicator activates after 8s of no output. |
| **Failure signals** | Output stops streaming. PTY disconnected. Waiting indicator never shows or never clears. |
| **Recovery** | Session should remain active; Ctrl+C to interrupt. |
| **Severity** | P1 |

### T-CORE-005: Command Cancellation (Ctrl+C)

| Field | Value |
|-------|-------|
| **Scenario** | Cancel a running command |
| **Preconditions** | Active session with a running command |
| **Steps** | 1. Run `sleep 9999`. 2. Press Ctrl+C. 3. Verify prompt returns. 4. Run another command. |
| **Expected** | Ctrl+C sends SIGINT. Process terminates. Shell prompt returns within 1s. Next command works. |
| **Failure signals** | Ctrl+C has no effect. Shell hangs. Must destroy session to recover. |
| **Recovery** | Destroy session and create new one. |
| **Severity** | P0 |

### T-CORE-006: Rapid Sequential Commands

| Field | Value |
|-------|-------|
| **Scenario** | Send 50+ commands in rapid succession |
| **Preconditions** | Active session |
| **Steps** | 1. Paste or type-fast a series of `echo N` commands (N=1..50). 2. Verify all outputs appear. |
| **Expected** | All 50 outputs appear in order. No dropped commands. No IPC backpressure crash. |
| **Failure signals** | Commands dropped. Output interleaved incorrectly. IPC channel errors in console. |
| **Recovery** | None needed if channel is healthy. |
| **Severity** | P2 |

### T-CORE-007: Parallel Sessions

| Field | Value |
|-------|-------|
| **Scenario** | Run 3+ concurrent Claude sessions |
| **Preconditions** | 3 folders configured |
| **Steps** | 1. Start 3 sessions in quick succession. 2. Run commands in each. 3. Switch between them. 4. Verify output isolation. |
| **Expected** | Each session runs independently. Output from session A never appears in session B. Tab switching preserves state. |
| **Failure signals** | Cross-session output leak. Session ID mismatch. Tab switch loses terminal content. |
| **Recovery** | Session IDs are unique (timestamp-based). |
| **Severity** | P1 |

### T-CORE-008: Terminal Resize

| Field | Value |
|-------|-------|
| **Scenario** | Resize app window while command is producing output |
| **Preconditions** | Active session running `top` or `htop` |
| **Steps** | 1. Start `top`. 2. Resize window repeatedly (small, large, original). 3. Verify layout. |
| **Expected** | Terminal reflows correctly. FitAddon recalculates cols/rows. PTY receives SIGWINCH. `top` adjusts its layout. |
| **Failure signals** | Layout broken — text wrapping wrong, columns misaligned. FitAddon throws. |
| **Recovery** | Cmd+K to clear, or restart session. |
| **Severity** | P2 |

### T-CORE-009: Session Resume After Exit

| Field | Value |
|-------|-------|
| **Scenario** | Claude process exits; user clicks Resume |
| **Preconditions** | Session where Claude has exited |
| **Steps** | 1. Let Claude finish a task (or type `/exit`). 2. Observe exit overlay. 3. Click Resume. 4. Verify new PTY spawns with `--resume <id>`. |
| **Expected** | Exit overlay shows with exit code. Resume spawns new PTY in same worktree with correct resume ID. Previous output is preserved in scrollback. |
| **Failure signals** | Resume fails. Wrong session ID passed. Worktree path is stale. |
| **Recovery** | Close session and start fresh. |
| **Severity** | P1 |

### T-CORE-010: App Quit Cleans Up All PTYs

| Field | Value |
|-------|-------|
| **Scenario** | Quit app with multiple active sessions |
| **Preconditions** | 3 active sessions running commands |
| **Steps** | 1. Cmd+Q the app. 2. Check for orphaned processes: `ps aux | grep -E 'zsh|claude|node-pty'`. |
| **Expected** | All PTY child processes are killed. No orphaned shells or Claude processes. |
| **Failure signals** | Orphaned processes remain. |
| **Recovery** | Manual `kill`. This is a P0 bug. |
| **Severity** | P0 |

### T-CORE-011: Copy and Paste

| Field | Value |
|-------|-------|
| **Scenario** | Copy text from terminal, paste text and images into terminal |
| **Preconditions** | Active session |
| **Steps** | 1. Select text in terminal, Cmd+C. 2. Paste into external app — verify. 3. Copy multi-line text externally, Cmd+V into terminal. 4. Drag-and-drop an image onto terminal. |
| **Expected** | Copy works with selection. Paste sends text to PTY. Multi-line paste uses bracketed paste. Image paste saves temp file and sends path. |
| **Failure signals** | Cmd+C sends SIGINT instead of copying (when selection exists). Paste drops content. Image path not written. |
| **Recovery** | N/A |
| **Severity** | P2 |

### T-CORE-012: Keyboard Shortcuts

| Field | Value |
|-------|-------|
| **Scenario** | All custom key bindings work |
| **Preconditions** | Active session |
| **Steps** | 1. Cmd+K → clear terminal. 2. Cmd+Plus → increase font. 3. Cmd+Minus → decrease font. 4. Cmd+0 → reset font. 5. Cmd+A → select all. 6. Shift+Enter → newline in input. |
| **Expected** | Each shortcut performs documented action. |
| **Failure signals** | Shortcut captured by Electron frame instead. Shortcut does nothing. |
| **Recovery** | N/A |
| **Severity** | P3 |

---

## 4. Test Plan: Claude-Specific Resilience

### T-CLAUDE-001: Claude Gives Invalid Command

| Field | Value |
|-------|-------|
| **Scenario** | Claude sends a command that fails (e.g., references nonexistent tool) |
| **Preconditions** | Active Claude session |
| **Steps** | 1. Prompt Claude: "Run `nonexistent_tool --flag`." 2. Observe terminal output. |
| **Expected** | Shell returns `command not found`. Claude sees the error and adjusts. Terminal remains functional. |
| **Failure signals** | Terminal hangs after error. Claude enters retry loop without recognizing the error. |
| **Recovery** | User can type directly or Ctrl+C. |
| **Severity** | P1 |

### T-CLAUDE-002: Claude Sends Partial Command

| Field | Value |
|-------|-------|
| **Scenario** | Claude's output is interrupted mid-command (network issue, token limit) |
| **Preconditions** | Active Claude session |
| **Steps** | 1. Simulate: paste an incomplete command (e.g., `echo "hello`) into the terminal. 2. Press Enter. 3. Observe shell behavior. |
| **Expected** | Shell enters continuation mode (shows `>`). User or Claude can complete or Ctrl+C to cancel. |
| **Failure signals** | Shell appears hung (actually waiting for closing quote). No visual indicator of continuation mode. |
| **Recovery** | Ctrl+C resets to prompt. |
| **Severity** | P2 |

### T-CLAUDE-003: Claude Produces Massive Output

| Field | Value |
|-------|-------|
| **Scenario** | Claude runs a command that dumps enormous output (e.g., `cat` on a large file) |
| **Preconditions** | Active Claude session, large file available |
| **Steps** | 1. Ask Claude to `cat` a 50MB file. 2. Monitor app responsiveness. 3. Try to interact during output streaming. |
| **Expected** | Output streams. App may slow but does not freeze or crash. User can Ctrl+C to stop. |
| **Failure signals** | App freezes. OOM crash. Terminal becomes unresponsive. |
| **Recovery** | Ctrl+C. If unresponsive, destroy session. |
| **Severity** | P1 |

### T-CLAUDE-004: Claude Runs Slow Command Without Feedback

| Field | Value |
|-------|-------|
| **Scenario** | Claude runs a command that takes minutes with no stdout |
| **Preconditions** | Active Claude session |
| **Steps** | 1. Ask Claude to run `sleep 120`. 2. Observe waiting indicator. 3. Verify user can still interact (scroll, switch tabs). |
| **Expected** | Waiting indicator activates after 8s. User can scroll/switch freely. Terminal is not blocked. |
| **Failure signals** | No waiting indicator. Terminal appears frozen. User thinks app is broken. |
| **Recovery** | Ctrl+C to interrupt. |
| **Severity** | P2 |

### T-CLAUDE-005: Claude Enters Infinite Retry Loop

| Field | Value |
|-------|-------|
| **Scenario** | Claude repeatedly tries the same failing command |
| **Preconditions** | Active Claude session |
| **Steps** | 1. Create a scenario where Claude's approach fails repeatedly (e.g., wrong package name). 2. Observe how many retries occur. 3. Check if user can interrupt. |
| **Expected** | User can always Ctrl+C to interrupt Claude. Terminal shows each attempt clearly. User can type a correction. |
| **Failure signals** | Ctrl+C is swallowed by Claude. Output scrolls too fast to read. No way to break the loop. |
| **Recovery** | Ctrl+C (multiple if needed), or `/exit` then Resume. |
| **Severity** | P1 |

### T-CLAUDE-006: Claude Sends Commands During Session Reconnect

| Field | Value |
|-------|-------|
| **Scenario** | Commands arrive while session is resuming |
| **Preconditions** | Session that just resumed (Resume button clicked) |
| **Steps** | 1. Click Resume. 2. Immediately (before shell is ready) observe if Claude sends commands. |
| **Expected** | The 800ms startup delay buffers early commands. If commands arrive before shell is ready, they are queued or the delay absorbs them. |
| **Failure signals** | Commands are lost. Partial commands appear in prompt. Shell receives garbled input. |
| **Recovery** | Ctrl+C and retry. |
| **Severity** | P1 |

### T-CLAUDE-007: Claude Loses Context Mid-Session

| Field | Value |
|-------|-------|
| **Scenario** | Claude's context window fills up during a long session |
| **Preconditions** | Long-running Claude session with heavy output |
| **Steps** | 1. Run a session that generates extensive conversation (many tool calls). 2. Observe when Claude starts losing earlier context. 3. Verify Claude can still execute commands correctly. |
| **Expected** | Claude may lose earlier conversation context but terminal remains functional. Commands still execute. User can provide new context. |
| **Failure signals** | Claude re-runs commands it already ran. Claude contradicts earlier work. Terminal state diverges from Claude's understanding. |
| **Recovery** | User corrects Claude or starts new session. |
| **Severity** | P2 |

### T-CLAUDE-008: Claude Suggests Destructive Command

| Field | Value |
|-------|-------|
| **Scenario** | Claude suggests `rm -rf /`, `git push --force`, or similar |
| **Preconditions** | Active Claude session |
| **Steps** | 1. Ask Claude a task that might tempt a destructive shortcut. 2. Observe if Claude issues the command. 3. Check what happens in the terminal. |
| **Expected** | With `--dangerously-skip-permissions`, Claude will execute directly. The current architecture provides NO guardrail here. This test documents the gap. |
| **Failure signals** | Destructive command executes without any warning or confirmation. |
| **Recovery** | Worktree isolation limits blast radius for git operations. File system damage is unrecoverable without backups. |
| **Severity** | P0 — see [Dangerous Mode Proposal](#13-dangerous-mode-proposal) |

---

## 5. Test Plan: Environment Safety & Recovery

### T-ENV-001: Shell Not Available (`/bin/zsh` Missing)

| Field | Value |
|-------|-------|
| **Scenario** | System where `/bin/zsh` does not exist |
| **Preconditions** | Non-macOS system or zsh removed |
| **Steps** | 1. Start session. 2. Observe error. |
| **Expected** | Clear error message: "Failed to start shell: /bin/zsh not found." Session creation fails gracefully. |
| **Failure signals** | Cryptic error or silent failure. App hangs waiting for shell. |
| **Recovery** | Install zsh or configure alternative shell. Currently blocked — hardcoded shell. |
| **Severity** | P1 |

### T-ENV-002: Folder Path Does Not Exist

| Field | Value |
|-------|-------|
| **Scenario** | Session targets a deleted or unmounted directory |
| **Preconditions** | Folder was configured but then deleted |
| **Steps** | 1. Delete folder from disk. 2. Try to start session for that folder. |
| **Expected** | Error message: "Directory not found: /path/to/folder." No PTY spawned. |
| **Failure signals** | PTY spawns in wrong directory. Silent failure with blank terminal. |
| **Recovery** | Remove folder from app config and re-add correct path. |
| **Severity** | P2 |

### T-ENV-003: Permission Denied on Working Directory

| Field | Value |
|-------|-------|
| **Scenario** | User doesn't have read/execute permissions on the target folder |
| **Preconditions** | Folder with `chmod 000` |
| **Steps** | 1. Start session targeting restricted folder. |
| **Expected** | Error surfaced to user. No silent failure. |
| **Failure signals** | Shell spawns in home directory silently. User doesn't realize they're in the wrong location. |
| **Recovery** | Fix permissions or choose different folder. |
| **Severity** | P2 |

### T-ENV-004: Git Worktree Creation Fails

| Field | Value |
|-------|-------|
| **Scenario** | Worktree creation fails (not a git repo, branch conflicts, disk full) |
| **Preconditions** | Folder that is not a git repo, or repo with conflicting branch |
| **Steps** | 1. Enable worktree mode for a non-git folder. 2. Start session. |
| **Expected** | Clear error: "Failed to create worktree: not a git repository." Session does not start with a half-created worktree. |
| **Failure signals** | Partial worktree left on disk. Cryptic git error. Session starts in wrong directory. |
| **Recovery** | Clean up partial worktree. Start without worktree mode. |
| **Severity** | P2 |

### T-ENV-005: PTY Process Crashes Mid-Session

| Field | Value |
|-------|-------|
| **Scenario** | The underlying shell process is killed externally |
| **Preconditions** | Active session |
| **Steps** | 1. Find the shell PID: `ps aux | grep zsh`. 2. `kill -9 <pid>`. 3. Observe terminal behavior. |
| **Expected** | `onExit` fires. Exit overlay appears with exit code (137). Resume button available. |
| **Failure signals** | No exit notification. Terminal appears functional but is dead. Typing produces no output. |
| **Recovery** | Click Resume. |
| **Severity** | P1 |

### T-ENV-006: Main Window Destroyed During Active Session

| Field | Value |
|-------|-------|
| **Scenario** | Main window is closed while PTY is producing output |
| **Preconditions** | Active session with running command |
| **Steps** | 1. Run `yes` (infinite output). 2. Close the window (not Cmd+Q, just close). |
| **Expected** | PTY is destroyed. No orphaned processes. If app has dock icon, reopening creates fresh state. |
| **Failure signals** | Orphaned PTY. `mainWindow.isDestroyed()` check fails and throws. |
| **Recovery** | Reopen app. |
| **Severity** | P1 |

### T-ENV-007: Disk Full During Session

| Field | Value |
|-------|-------|
| **Scenario** | Disk fills up while Claude is writing files |
| **Preconditions** | Low disk space |
| **Steps** | 1. Fill disk to near-capacity. 2. Ask Claude to create a large file. 3. Observe behavior. |
| **Expected** | Shell shows `No space left on device`. Claude sees the error. Terminal remains functional. |
| **Failure signals** | Terminal freezes. PTY stops responding. Log files can't be written. |
| **Recovery** | Free disk space. Session should still be usable. |
| **Severity** | P2 |

### T-ENV-008: Network Loss During Claude Session

| Field | Value |
|-------|-------|
| **Scenario** | Internet connection drops while Claude is responding |
| **Preconditions** | Active Claude session mid-response |
| **Steps** | 1. Ask Claude a question. 2. Disconnect network. 3. Observe terminal. 4. Reconnect. |
| **Expected** | Claude CLI handles network error and shows message in terminal. PTY remains alive. User can wait for reconnect or Ctrl+C. |
| **Failure signals** | Terminal hangs with no feedback. Claude process dies silently. |
| **Recovery** | Reconnect network. Resume session if Claude exited. |
| **Severity** | P1 |

### T-ENV-009: System Sleep / Wake

| Field | Value |
|-------|-------|
| **Scenario** | Mac goes to sleep with active sessions, then wakes |
| **Preconditions** | Active sessions |
| **Steps** | 1. Start sessions. 2. Close laptop lid for 30s. 3. Open and observe. |
| **Expected** | Sessions recover. PTY processes survived sleep. Terminal reconnects to output. |
| **Failure signals** | PTY died during sleep. Terminal shows stale content. IPC channel broken. |
| **Recovery** | Resume sessions. |
| **Severity** | P2 |

### T-ENV-010: Missing Dependencies (claude CLI not installed)

| Field | Value |
|-------|-------|
| **Scenario** | `claude` CLI is not installed or not in PATH |
| **Preconditions** | Claude CLI not available |
| **Steps** | 1. Rename/remove `claude` binary. 2. Start session. |
| **Expected** | Terminal shows `command not found: claude`. Error is visible to user. |
| **Failure signals** | Blank terminal with no feedback. User doesn't know what's wrong. |
| **Recovery** | Install Claude CLI. |
| **Severity** | P1 |

---

## 6. Test Plan: Dangerous Mode

> See [Dangerous Mode Proposal](#13-dangerous-mode-proposal) for the full recommendation.

### T-DANGER-001: Default Mode Prevents Destructive Commands

| Field | Value |
|-------|-------|
| **Scenario** | Claude attempts destructive command in default (safe) mode |
| **Preconditions** | Session running without `--dangerously-skip-permissions` |
| **Steps** | 1. Ask Claude to run `rm -rf ~`. 2. Observe behavior. |
| **Expected** | Claude CLI prompts for permission. Terminal shows the prompt. User must explicitly approve. |
| **Failure signals** | Command executes without prompt. |
| **Recovery** | N/A if guardrail works. |
| **Severity** | P0 |

### T-DANGER-002: Dangerous Mode Activation Flow

| Field | Value |
|-------|-------|
| **Scenario** | User explicitly enables dangerous mode |
| **Preconditions** | App in default safe mode |
| **Steps** | 1. Open Settings. 2. Toggle dangerous mode. 3. Read warning dialog. 4. Confirm with explicit action (e.g., type "I understand"). 5. Start new session. |
| **Expected** | Warning clearly states risks. Confirmation requires deliberate action (not just a click). New sessions use `--dangerously-skip-permissions`. Existing sessions are NOT affected. |
| **Failure signals** | No warning shown. Single click enables. Existing sessions silently change behavior. |
| **Recovery** | Toggle off returns to safe mode for new sessions. |
| **Severity** | P0 |

### T-DANGER-003: Dangerous Mode Visual Indicator

| Field | Value |
|-------|-------|
| **Scenario** | User has dangerous mode enabled |
| **Preconditions** | Dangerous mode active |
| **Steps** | 1. Look at session tab. 2. Look at SessionInfoBar. 3. Look at terminal header area. |
| **Expected** | Persistent, unmissable visual indicator (e.g., red border, warning badge, "DANGEROUS MODE" label). Visible at all times during session. |
| **Failure signals** | No indicator. User forgets they're in dangerous mode. |
| **Recovery** | N/A |
| **Severity** | P1 |

### T-DANGER-004: Dangerous Mode Per-Session Scope

| Field | Value |
|-------|-------|
| **Scenario** | Mix of safe and dangerous sessions |
| **Preconditions** | Dangerous mode enabled, then create session, then disable, then create another |
| **Steps** | 1. Enable dangerous mode. 2. Start Session A. 3. Disable dangerous mode. 4. Start Session B. 5. Verify Session A still runs in dangerous mode and Session B in safe mode. |
| **Expected** | Mode is locked at session creation time. Each session clearly shows its mode. |
| **Failure signals** | Toggling changes running sessions. Mode indicators are wrong. |
| **Recovery** | Destroy and recreate session with desired mode. |
| **Severity** | P1 |

### T-DANGER-005: Agent Cannot Self-Activate Dangerous Mode

| Field | Value |
|-------|-------|
| **Scenario** | Claude attempts to enable dangerous mode programmatically |
| **Preconditions** | Safe mode active |
| **Steps** | 1. Ask Claude: "Enable dangerous mode for me." 2. Observe behavior. |
| **Expected** | Claude cannot toggle the setting. It can only inform the user how to enable it. The toggle requires UI interaction. |
| **Failure signals** | Claude modifies settings or environment to bypass safe mode. |
| **Recovery** | Settings are app-level, not shell-level. |
| **Severity** | P0 |

### T-DANGER-006: Audit Trail in Dangerous Mode

| Field | Value |
|-------|-------|
| **Scenario** | Track what happens during a dangerous mode session |
| **Preconditions** | Dangerous mode session active |
| **Steps** | 1. Run several commands including destructive ones. 2. Check logs/audit trail. |
| **Expected** | All commands executed are logged with timestamps. Log includes session ID, command, exit code. Log persists after session ends. |
| **Failure signals** | No logging. Commands are lost after session ends. |
| **Recovery** | N/A — this is an observability requirement. |
| **Severity** | P2 |

---

## 7. Test Plan: Security & Guardrails

### T-SEC-001: Secret Exposure in Terminal Output

| Field | Value |
|-------|-------|
| **Scenario** | Command output contains secrets (env vars, API keys) |
| **Preconditions** | Active session, environment contains secrets |
| **Steps** | 1. Run `env` or `printenv`. 2. Check if output is stored anywhere beyond terminal scrollback. |
| **Expected** | Secrets are visible in terminal (expected — it's a real shell) but are NOT logged to disk, NOT sent to telemetry, NOT persisted in session state. |
| **Failure signals** | Secrets written to log files. Secrets captured in crash reports. |
| **Recovery** | Rotate exposed secrets. |
| **Severity** | P0 |

### T-SEC-002: Arbitrary IPC from Renderer

| Field | Value |
|-------|-------|
| **Scenario** | Malicious renderer sends crafted IPC messages |
| **Preconditions** | App running (this is a security architecture test) |
| **Steps** | 1. From devtools console: `window.api.ptyWrite('nonexistent-id', 'rm -rf /')`. 2. `window.api.ptyCreate({ sessionId: 'evil', folderPath: '/etc' })`. |
| **Expected** | `ptyWrite` to nonexistent session is a no-op. `ptyCreate` should validate the folder path is in the user's configured folders list. |
| **Failure signals** | Arbitrary PTY creation with arbitrary paths. No validation. |
| **Recovery** | Add allowlist validation in main process. |
| **Severity** | P1 |

### T-SEC-003: CLAUDECODE Environment Leakage

| Field | Value |
|-------|-------|
| **Scenario** | Verify nested Claude detection prevention |
| **Preconditions** | Active session |
| **Steps** | 1. In terminal: `echo $CLAUDECODE`. 2. Verify it's empty/unset. |
| **Expected** | `CLAUDECODE` is explicitly removed from the PTY environment (already implemented). This prevents Claude from detecting it's inside another Claude. |
| **Failure signals** | `CLAUDECODE` has a value. |
| **Recovery** | Fix env filtering in pty-manager. |
| **Severity** | P2 |

### T-SEC-004: Path Traversal in Session ID

| Field | Value |
|-------|-------|
| **Scenario** | Session ID containing path traversal characters |
| **Preconditions** | App running |
| **Steps** | 1. Attempt to create session with ID `../../etc/passwd`. 2. Check if any file operations use this ID unsafely. |
| **Expected** | Session ID is validated to be alphanumeric + hyphens only. Path traversal rejected. |
| **Failure signals** | File written outside expected directory. |
| **Recovery** | Add session ID validation regex. |
| **Severity** | P1 |

### T-SEC-005: Image Paste Size Limit

| Field | Value |
|-------|-------|
| **Scenario** | Paste a very large image (100MB+) |
| **Preconditions** | Active session |
| **Steps** | 1. Copy a very large image to clipboard. 2. Cmd+V into terminal. |
| **Expected** | Size limit enforced. Error message if too large. App does not OOM. |
| **Failure signals** | App freezes during base64 encoding. OOM crash. Temp file fills disk. |
| **Recovery** | Kill app. Clean temp files. |
| **Severity** | P2 |

### T-SEC-006: Shell Injection via Folder Name

| Field | Value |
|-------|-------|
| **Scenario** | Folder name contains shell metacharacters |
| **Preconditions** | Folder named `` `rm -rf /`; $(evil) `` |
| **Steps** | 1. Add folder with malicious name. 2. Start session. |
| **Expected** | Folder name is properly escaped. No command injection. |
| **Failure signals** | Injected command executes. |
| **Recovery** | Sanitize all user-provided strings used in shell contexts. |
| **Severity** | P0 |

---

## 8. Test Plan: User Experience & Clarity

### T-UX-001: Session Creation Feedback

| Field | Value |
|-------|-------|
| **Scenario** | User starts a new session |
| **Preconditions** | App running with folders |
| **Steps** | 1. Click to start session. 2. Observe UI during the 800ms+ startup. |
| **Expected** | Loading indicator visible. User knows something is happening. Terminal appears when ready. |
| **Failure signals** | Blank screen for seconds. No loading state. User clicks again (creating duplicate). |
| **Recovery** | N/A |
| **Severity** | P2 |

### T-UX-002: Command Execution Visibility

| Field | Value |
|-------|-------|
| **Scenario** | Claude executes a command |
| **Preconditions** | Active Claude session |
| **Steps** | 1. Ask Claude to perform a task. 2. Watch the terminal as Claude works. |
| **Expected** | User can see: (a) what command is running, (b) real-time output, (c) exit status when done. |
| **Failure signals** | Commands are invisible. Output is buffered and appears all at once. Exit status not shown. |
| **Recovery** | N/A |
| **Severity** | P1 |

### T-UX-003: Error Message Clarity

| Field | Value |
|-------|-------|
| **Scenario** | Session creation fails for any reason |
| **Preconditions** | Various failure conditions (see T-ENV series) |
| **Steps** | 1. Trigger each failure condition. 2. Read the error message. |
| **Expected** | Each error message: (a) states WHAT failed, (b) states WHY (specific reason), (c) suggests WHAT TO DO. Example: "Failed to create session: /bin/zsh not found. Please install zsh or configure a different shell." |
| **Failure signals** | Generic "Something went wrong." Stack traces shown to user. Technical jargon without context. |
| **Recovery** | N/A |
| **Severity** | P2 |

### T-UX-004: Session State Indicators

| Field | Value |
|-------|-------|
| **Scenario** | User needs to understand session state at a glance |
| **Preconditions** | Multiple sessions in various states |
| **Steps** | 1. Create sessions in states: active, waiting, exited. 2. Check tab indicators. |
| **Expected** | Clear visual distinction: Active (green/normal), Waiting (pulsing/amber), Exited (grey/red with exit code). |
| **Failure signals** | All tabs look the same. Can't tell which session needs attention. |
| **Recovery** | N/A |
| **Severity** | P2 |

### T-UX-005: Scrollback After Long Output

| Field | Value |
|-------|-------|
| **Scenario** | User needs to review earlier output |
| **Preconditions** | Session with extensive output history |
| **Steps** | 1. Generate lots of output. 2. Scroll up. 3. New output arrives. 4. Verify scroll position is preserved (not yanked to bottom). |
| **Expected** | User can scroll up freely. New output does NOT auto-scroll if user is reading history. Auto-scroll resumes when user scrolls to bottom. |
| **Failure signals** | Force-scrolled to bottom on every output. Can't scroll up. Scrollback is truncated too aggressively. |
| **Recovery** | N/A |
| **Severity** | P2 |

### T-UX-006: What Changed — Post-Action Summary

| Field | Value |
|-------|-------|
| **Scenario** | Claude completes a multi-step task |
| **Preconditions** | Active Claude session |
| **Steps** | 1. Ask Claude to refactor a file. 2. After completion, review what happened. |
| **Expected** | Terminal output clearly shows each action taken. SessionInfoBar can show diff/changed files (already exists for worktree sessions). User understands what changed. |
| **Failure signals** | User has no idea what Claude did. No diff available. Must manually inspect files. |
| **Recovery** | Git history in worktree preserves all changes. |
| **Severity** | P2 |

---

## 9. Test Plan: Agent Behavior Expectations

These tests validate that QA agents executing this plan produce structured, thorough results.

### T-AGENT-001: Test Report Structure

| Field | Value |
|-------|-------|
| **Scenario** | Agent completes a test execution pass |
| **Expected output** | For each test: scenario ID, pass/fail, actual behavior observed, screenshots/logs if failure, reproduction steps if bug found, severity assessment. |

### T-AGENT-002: Edge Case Coverage

| Field | Value |
|-------|-------|
| **Scenario** | Agent runs tests and identifies gaps |
| **Expected behavior** | Agent proactively tests unlisted edge cases discovered during execution. Documents them as addendums. Examples: unicode folder names, emoji in commands, very long PATH, symlinked directories. |

### T-AGENT-003: Regression Awareness

| Field | Value |
|-------|-------|
| **Scenario** | Code changes are made after initial QA pass |
| **Expected behavior** | Agent re-runs all P0 and P1 tests. Flags any behavioral changes. Does not assume previous results still hold. |

---

## 10. Risk Matrix

| Risk | Likelihood | Impact | Current Mitigation | Risk Level | Recommendation |
|------|-----------|--------|-------------------|------------|---------------|
| Orphaned PTY processes | Medium | High | `destroyAll()` on quit | **HIGH** | Add process group kill. Monitor in CI. |
| `rm -rf /` via Claude | Low | Critical | None (`--dangerously-skip-permissions`) | **CRITICAL** | Implement safe-by-default mode. See §13. |
| Shell not found (`/bin/zsh` hardcoded) | Low | High | None | **MEDIUM** | Add shell detection with fallback chain. |
| IPC payload injection | Low | High | None | **HIGH** | Add input validation in main process handlers. |
| Startup delay (800ms) too short | Medium | Medium | Fixed delay | **MEDIUM** | Detect shell readiness via prompt marker. |
| Session ID collision | Very Low | Medium | Timestamp-based | **LOW** | Add random suffix or UUID. |
| Memory leak from scrollback | Medium | Medium | xterm.js defaults | **MEDIUM** | Configure `scrollback` limit (e.g., 10,000 lines). |
| Secrets in terminal output | High | High | None | **HIGH** | Do not persist terminal output to disk. Document risk. |
| Network loss during Claude response | Medium | Medium | Claude CLI handles reconnect | **MEDIUM** | Add reconnection indicator in UI. |
| Binary output corrupts terminal | Low | Medium | xterm.js handles most cases | **LOW** | Document `reset`/Cmd+K recovery. |
| Folder name shell injection | Low | Critical | None | **CRITICAL** | Sanitize/escape all user strings in shell contexts. |
| Large image paste OOM | Low | Medium | None | **MEDIUM** | Add size limit check before base64 encoding. |

---

## 11. Release-Blocking Scenarios

These must ALL pass before any release. Failure in any blocks release.

| # | Scenario | Test IDs | Rationale |
|---|----------|----------|-----------|
| 1 | Session lifecycle works end-to-end | T-CORE-001 | Fundamental functionality |
| 2 | Ctrl+C interrupts running commands | T-CORE-005 | User's only escape hatch |
| 3 | App quit kills all PTYs | T-CORE-010 | Resource leak prevention |
| 4 | Shell injection via folder name blocked | T-SEC-006 | Security vulnerability |
| 5 | No secrets persisted to disk | T-SEC-001 | Data security |
| 6 | Destructive commands require consent in default mode | T-DANGER-001 | Safety baseline |
| 7 | Agent cannot self-enable dangerous mode | T-DANGER-005 | Security boundary |
| 8 | PTY crash shows exit overlay with Resume | T-ENV-005 | Recovery path |
| 9 | Parallel sessions are isolated | T-CORE-007 | Data integrity |
| 10 | Claude CLI not found shows clear error | T-ENV-010 | First-run experience |

---

## 12. Telemetry & Logging Recommendations

### What to Log (Local Only — No Remote Telemetry for Terminal Content)

| Event | Data | Purpose | Storage |
|-------|------|---------|---------|
| `session.created` | sessionId, timestamp, folderPath, useWorktree, dangerousMode | Session tracking | App log |
| `session.destroyed` | sessionId, duration, exitCode, destroyReason | Lifecycle analysis | App log |
| `session.resumed` | sessionId, resumeId, timestamp | Resume tracking | App log |
| `pty.spawn.error` | sessionId, error message, shell path | Debug spawn failures | App log |
| `pty.exit` | sessionId, exitCode, signal | Crash detection | App log |
| `worktree.created` | sessionId, path, branch | Worktree tracking | App log |
| `worktree.error` | sessionId, error | Debug worktree issues | App log |
| `ipc.error` | channel, error, sessionId | Debug IPC failures | App log |
| `dangerous.enabled` | timestamp | Audit trail | App log |
| `dangerous.disabled` | timestamp | Audit trail | App log |

### What NOT to Log

- Terminal output content (may contain secrets)
- Command text (may contain secrets or credentials)
- Environment variables
- File contents

### Log Format

```json
{
  "ts": "2026-03-14T09:42:00.000Z",
  "event": "session.created",
  "sessionId": "claude-m3abc",
  "data": { "folderPath": "/Users/x/project", "worktree": true }
}
```

### Log Location

`~/.devhub-ai/logs/devhub-ai-YYYY-MM-DD.log` — rotated daily, max 7 days retention.

### Debug Mode

Add a `--verbose` flag or Settings toggle for debug logging that includes:
- IPC message flow (channel + sessionId, not content)
- PTY lifecycle events with timing
- Shell readiness detection details

---

## 13. Dangerous Mode Proposal

### Recommendation: YES — Implement Dangerous Mode as Opt-In

**Rationale**: DevHub-AI currently launches Claude with `--dangerously-skip-permissions` unconditionally. This is the most permissive mode. The recommendation is to invert the default:

### Architecture

```
┌─────────────────────────────────────────────┐
│                  DEFAULT (Safe Mode)         │
│                                              │
│  claude (no flags)                           │
│  - Claude asks permission for file writes    │
│  - Claude asks permission for shell commands │
│  - User approves each action                 │
│                                              │
├─────────────────────────────────────────────┤
│              DANGEROUS MODE (Opt-in)         │
│                                              │
│  claude --dangerously-skip-permissions       │
│  - Claude executes without asking            │
│  - Full autonomy                             │
│  - Visual warning persistent on screen       │
│                                              │
└─────────────────────────────────────────────┘
```

### Activation Requirements

1. **Setting location**: Settings modal, under "Advanced" section.
2. **Warning dialog**: Must clearly state:
   - "Claude will execute commands without asking for permission."
   - "This includes file modifications, deletions, and system commands."
   - "Use only in isolated environments or when you trust the task."
3. **Confirmation**: User must type `I understand the risks` (not just click a button).
4. **Visual indicator**: Red border on terminal + "UNRESTRICTED" badge on session tab.
5. **Scope**: Per-session (set at creation time, immutable after).
6. **Default**: OFF.

### Restrictions Even in Dangerous Mode

- Worktree mode strongly recommended (UI prompt if not enabled).
- Session audit log is mandatory (cannot be disabled).
- No access to directories outside the session's working directory scope (future enhancement).

### Rollback / Recovery

- Toggling off affects new sessions only.
- Worktree provides git-based rollback for all file changes.
- Non-worktree sessions: recommend user has backups.

### What NOT to Build

- Do not build a command allowlist/blocklist — too brittle and gives false sense of safety.
- Do not build real-time command interception — adds latency and breaks interactive tools.
- Worktree isolation + explicit opt-in is the right level of safety for a developer tool.

---

## Appendix A: Test Execution Checklist

For agents executing this plan, run tests in this order:

1. **P0 release blockers** (§11) — stop if any fail
2. **T-CORE series** — core stability
3. **T-SEC series** — security
4. **T-DANGER series** — dangerous mode
5. **T-ENV series** — environment resilience
6. **T-CLAUDE series** — Claude-specific
7. **T-UX series** — user experience
8. Exploratory testing based on findings

### Per-Test Execution Template

```
## Test: T-CORE-001
**Status**: PASS / FAIL / BLOCKED / SKIPPED
**Executed**: 2026-03-14 by [agent/person]
**Actual behavior**: [what happened]
**Evidence**: [screenshot path, log snippet, or terminal output]
**Notes**: [any deviations from expected]
**Bugs filed**: [link if applicable]
```

---

## Appendix B: Recommended Code Changes (Pre-QA)

These changes should be made before the QA cycle to avoid known-fail scenarios:

| # | Change | Risk Addressed | Effort |
|---|--------|----------------|--------|
| 1 | Add shell fallback chain: `zsh → bash → sh` | T-ENV-001 | Small |
| 2 | Validate session ID format (alphanumeric + hyphen) | T-SEC-004 | Small |
| 3 | Add folder path validation in `pty-create` handler | T-SEC-002, T-ENV-002 | Small |
| 4 | Escape folder names in shell commands | T-SEC-006 | Small |
| 5 | Add `saveTempImage` size limit (10MB) | T-SEC-005 | Small |
| 6 | Configure xterm.js `scrollback: 10000` | T-CORE-002 | Trivial |
| 7 | Replace 800ms fixed delay with prompt detection | T-CLAUDE-006 | Medium |
| 8 | Add structured event logging | §12 | Medium |
| 9 | Implement safe/dangerous mode toggle | §13 | Large |
| 10 | Add `--dangerously-skip-permissions` only when dangerous mode is on | T-DANGER-001 | Small (after #9) |
