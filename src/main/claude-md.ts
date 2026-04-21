import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

const DEVHUB_AI_ENV_MD = `# DevHub-AI — AI Terminal Environment

You are running inside **DevHub-AI**, an Electron-based development environment with an embedded terminal.
This file tells you what tools and capabilities are available in this session.

## Environment

- **Terminal**: xterm-256color PTY (zsh -i) inside an Electron window
- **Session ID**: Available as \`$DEVHUB_AI_SESSION_ID\`
- **Working directory**: This project's root (or a git worktree — see Git section)
- **No GUI access**: \`open\` commands that launch macOS apps won't be visible — use \`browser\` instead

## Browser Tool

You have a \`browser\` command on PATH for controlling a real browser window managed by DevHub-AI.
Always prefer this over \`open\` when you need to view or interact with web pages.

\`\`\`
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
\`\`\`

**Examples:**
\`\`\`bash
browser navigate http://localhost:3000
browser screenshot
browser click '#submit-btn'
browser type '#search' "hello world"
browser text
browser eval 'document.querySelectorAll("a").length'
\`\`\`

**Tips:**
- The browser window persists across commands — no need to reopen each time
- Use \`browser screenshot\` to capture what's on screen — the image file path is returned
- Use \`browser text\` to get readable page content for analysis
- Chain: \`browser navigate ... && browser screenshot\` to navigate and capture in one step

## Git & Worktrees

This session may be running in a **git worktree** — an isolated branch copy created by DevHub-AI.
If so, your CWD is the worktree directory, not the original repo.

**Detect your context:**
\`\`\`bash
git rev-parse --abbrev-ref HEAD    # current branch
git worktree list                  # all worktrees (if applicable)
git status                         # working tree status
\`\`\`

**Worktree conventions:**
- Branch names follow the pattern \`devhub-ai/claude-<project>-<id>\`
- The original repo is untouched — commit freely in your worktree branch
- When done, DevHub-AI's UI can merge or create a PR from the session info bar

**Best practices:**
- Make small, focused commits with clear messages
- Don't force-push to shared branches
- If you need to reference the base branch: \`git log --oneline main..HEAD\`

## Terminal Behavior

- This is a real interactive PTY — full readline, job control, and signal handling work
- The terminal is rendered in xterm.js inside Electron — ANSI colors and cursor movement work normally
- Long-running processes can be backgrounded: \`npm run dev &\`
- DevHub-AI monitors the terminal for idle state (waiting for your input)

**Avoid:**
- \`open <url>\` for web pages — use \`browser navigate\` instead
- Interactive TUI editors (vim, nano) for file edits — prefer \`sed\`, \`awk\`, or direct file writes
- Commands that require separate GUI windows — they won't be visible in this terminal

## Session Tips

- **Multiple sessions** may be running in parallel — each has its own terminal and working directory
- **Session history** is preserved — if this session ends, it can be resumed later
- The info bar above the terminal shows: current branch, commit status, files changed, and git actions
- Click the branch name in the info bar to switch branches from the DevHub-AI UI
`

const DEVHUB_AI_RTK_MD = `

## RTK Token Compression

RTK (Rust Token Killer) is active. Commands like \`git status\`, \`ls\`, \`grep\`, and test runners
are automatically rewritten to compressed equivalents via the rtk hook.
This reduces token usage by 60-90% with <10ms overhead.

- Check savings: \`rtk gain\`
- See what could be optimized: \`rtk discover\`
`

interface ProjectContext {
  packageManager: string | null
  testCommand: string | null
  lintCommand: string | null
  buildCommand: string | null
  devCommand: string | null
  framework: string | null
  language: string | null
}

function detectProjectContext(cwd: string): ProjectContext | null {
  const ctx: ProjectContext = {
    packageManager: null,
    testCommand: null,
    lintCommand: null,
    buildCommand: null,
    devCommand: null,
    framework: null,
    language: null,
  }

  let detected = false

  // Node.js / JavaScript projects
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    detected = true
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const scripts = pkg.scripts || {}
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }

      // Package manager
      if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) ctx.packageManager = 'bun'
      else if (existsSync(join(cwd, 'pnpm-lock.yaml'))) ctx.packageManager = 'pnpm'
      else if (existsSync(join(cwd, 'yarn.lock'))) ctx.packageManager = 'yarn'
      else ctx.packageManager = 'npm'

      const run = ctx.packageManager === 'npm' ? 'npm run' : ctx.packageManager

      // Scripts
      if (scripts.test) ctx.testCommand = `${run} test`
      if (scripts.lint) ctx.lintCommand = `${run} lint`
      if (scripts.build) ctx.buildCommand = `${run} build`
      if (scripts.dev) ctx.devCommand = `${run} dev`
      else if (scripts.start) ctx.devCommand = `${run} start`

      // Framework
      if (deps?.next) ctx.framework = 'Next.js'
      else if (deps?.nuxt) ctx.framework = 'Nuxt'
      else if (deps?.svelte || deps?.['@sveltejs/kit']) ctx.framework = 'SvelteKit'
      else if (deps?.react) ctx.framework = 'React'
      else if (deps?.vue) ctx.framework = 'Vue'
      else if (deps?.express) ctx.framework = 'Express'
      else if (deps?.fastify) ctx.framework = 'Fastify'
      else if (deps?.electron) ctx.framework = 'Electron'

      ctx.language = deps?.typescript || existsSync(join(cwd, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript'
    } catch { /* ignore parse error */ }
  }

  // Python
  const pyFiles = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile']
  for (const f of pyFiles) {
    if (existsSync(join(cwd, f))) {
      detected = true
      ctx.language = 'Python'
      if (existsSync(join(cwd, 'Pipfile'))) ctx.packageManager = 'pipenv'
      else if (existsSync(join(cwd, 'poetry.lock'))) ctx.packageManager = 'poetry'
      else if (existsSync(join(cwd, 'uv.lock'))) ctx.packageManager = 'uv'
      else ctx.packageManager = 'pip'

      ctx.testCommand = 'pytest'
      if (existsSync(join(cwd, 'pyproject.toml'))) {
        try {
          const toml = readFileSync(join(cwd, 'pyproject.toml'), 'utf-8')
          if (toml.includes('django')) ctx.framework = 'Django'
          else if (toml.includes('fastapi')) ctx.framework = 'FastAPI'
          else if (toml.includes('flask')) ctx.framework = 'Flask'
        } catch { /* ignore */ }
      }
      break
    }
  }

  // Go
  if (existsSync(join(cwd, 'go.mod'))) {
    detected = true
    ctx.language = 'Go'
    ctx.packageManager = 'go mod'
    ctx.testCommand = 'go test ./...'
    ctx.buildCommand = 'go build ./...'
  }

  // Rust
  if (existsSync(join(cwd, 'Cargo.toml'))) {
    detected = true
    ctx.language = 'Rust'
    ctx.packageManager = 'cargo'
    ctx.testCommand = 'cargo test'
    ctx.buildCommand = 'cargo build'
    ctx.devCommand = 'cargo run'
  }

  // Scala / sbt
  if (existsSync(join(cwd, 'build.sbt'))) {
    detected = true
    ctx.language = 'Scala'
    ctx.packageManager = 'sbt'
    ctx.testCommand = 'sbt test'
    ctx.buildCommand = 'sbt compile'
  }

  // Gradle (Java/Kotlin)
  if (existsSync(join(cwd, 'build.gradle')) || existsSync(join(cwd, 'build.gradle.kts'))) {
    detected = true
    ctx.language = existsSync(join(cwd, 'build.gradle.kts')) ? 'Kotlin' : 'Java'
    ctx.packageManager = existsSync(join(cwd, 'gradlew')) ? './gradlew' : 'gradle'
    ctx.testCommand = `${ctx.packageManager} test`
    ctx.buildCommand = `${ctx.packageManager} build`
  }

  // Maven
  if (existsSync(join(cwd, 'pom.xml'))) {
    detected = true
    ctx.language = 'Java'
    ctx.packageManager = existsSync(join(cwd, 'mvnw')) ? './mvnw' : 'mvn'
    ctx.testCommand = `${ctx.packageManager} test`
    ctx.buildCommand = `${ctx.packageManager} package`
  }

  return detected ? ctx : null
}

function buildProjectSection(ctx: ProjectContext): string {
  const lines: string[] = ['\n## Project Context (auto-detected)\n']

  if (ctx.language) lines.push(`- **Language**: ${ctx.language}`)
  if (ctx.framework) lines.push(`- **Framework**: ${ctx.framework}`)
  if (ctx.packageManager) lines.push(`- **Package manager**: ${ctx.packageManager}`)

  const commands: string[] = []
  if (ctx.devCommand) commands.push(`- Dev server: \`${ctx.devCommand}\``)
  if (ctx.buildCommand) commands.push(`- Build: \`${ctx.buildCommand}\``)
  if (ctx.testCommand) commands.push(`- Test: \`${ctx.testCommand}\``)
  if (ctx.lintCommand) commands.push(`- Lint: \`${ctx.lintCommand}\``)

  if (commands.length > 0) {
    lines.push('\n**Common commands:**')
    lines.push(...commands)
  }

  return lines.join('\n')
}

export function ensureDevHubAIClaudeMd(cwd: string, rtkEnabled?: boolean) {
  try {
    const claudeMdPath = join(cwd, 'CLAUDE.md')
    const marker = '# DevHub-AI'

    let fullContent = DEVHUB_AI_ENV_MD

    // Auto-detect project context and append
    const ctx = detectProjectContext(cwd)
    if (ctx) {
      fullContent += buildProjectSection(ctx)
    }

    if (rtkEnabled) {
      fullContent += DEVHUB_AI_RTK_MD
    }

    if (existsSync(claudeMdPath)) {
      const content = readFileSync(claudeMdPath, 'utf-8')
      if (content.includes(marker)) return
      writeFileSync(claudeMdPath, content + '\n\n' + fullContent)
    } else {
      writeFileSync(claudeMdPath, fullContent)
    }
  } catch { /* ignore — non-critical */ }
}
