# DevHub-AI — AI Terminal Environment

You are running inside **DevHub-AI**, an Electron-based development environment with an embedded terminal.
This file tells you what tools and capabilities are available in this session.

## Environment

- **Terminal**: xterm-256color PTY (zsh -i) inside an Electron window
- **Session ID**: Available as `$DEVHUB_AI_SESSION_ID`
- **Working directory**: This project's root (or a git worktree — see Git section)
- **No GUI access**: `open` commands that launch macOS apps won't be visible — use `browser` instead

## Browser Tool

You have a `browser` command on PATH for controlling a real browser window managed by DevHub-AI.
Always prefer this over `open` when you need to view or interact with web pages.

```
browser navigate <url>              Go to URL (aliases: goto, go)
browser screenshot                  Capture screenshot to file (alias: snap)
browser click '<css-selector>'      Click element
browser type '<selector>' <text>    Type into input
browser evaluate '<js-code>'        Run JS in page (aliases: eval, js)
browser text                        Get visible page text
browser content                     Get full page HTML (alias: html)
browser url                         Current URL and title
browser back / forward / reload     Navigation
browser open                        Open browser window
browser close                       Close browser window
```

**Examples:**
```bash
browser navigate http://localhost:3000
browser screenshot
browser click '#submit-btn'
browser type '#search' "hello world"
browser text
browser eval 'document.querySelectorAll("a").length'
```

**Tips:**
- The browser window persists across commands — no need to reopen each time
- Use `browser screenshot` to capture what's on screen — the image file path is returned
- Use `browser text` to get readable page content for analysis
- Chain: `browser navigate ... && browser screenshot` to navigate and capture in one step

## Git & Worktrees

This session may be running in a **git worktree** — an isolated branch copy created by DevHub-AI.
If so, your CWD is the worktree directory, not the original repo.

**Detect your context:**
```bash
git rev-parse --abbrev-ref HEAD    # current branch
git worktree list                  # all worktrees (if applicable)
git status                         # working tree status
```

**Worktree conventions:**
- Branch names follow the pattern `devhub-ai/claude-<project>-<id>`
- The original repo is untouched — commit freely in your worktree branch
- When done, DevHub-AI's UI can merge or create a PR from the session info bar

**Best practices:**
- Make small, focused commits with clear messages
- Don't force-push to shared branches
- If you need to reference the base branch: `git log --oneline main..HEAD`

## Terminal Behavior

- This is a real interactive PTY — full readline, job control, and signal handling work
- The terminal is rendered in xterm.js inside Electron — ANSI colors and cursor movement work normally
- Long-running processes can be backgrounded: `npm run dev &`
- DevHub-AI monitors the terminal for idle state (waiting for your input)

**Avoid:**
- `open <url>` for web pages — use `browser navigate` instead
- Interactive TUI editors (vim, nano) for file edits — prefer `sed`, `awk`, or direct file writes
- Commands that require separate GUI windows — they won't be visible in this terminal

## Session Tips

- **Multiple sessions** may be running in parallel — each has its own terminal and working directory
- **Session history** is preserved — if this session ends, it can be resumed later
- The info bar above the terminal shows: current branch, commit status, files changed, and git actions
- Click the branch name in the info bar to switch branches from the DevHub-AI UI
