import { BrowserWindow } from 'electron'
import { execSync, spawn } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { PipelineRun, PipelineStage, PipelineStageLog, PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../shared/pipeline-types'
import { getShellPath } from './process-manager'
import { loadState } from './store'

// Resolve the full path to claude CLI once
let claudePath: string | null = null
function getClaudePath(): string {
  if (claudePath) return claudePath
  try {
    claudePath = require('child_process').execSync('/bin/zsh -ilc "which claude"', {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    claudePath = 'claude' // fallback
  }
  return claudePath
}

class PipelineManager {
  private runs = new Map<string, PipelineRun>()
  private mainWindow: BrowserWindow | null = null
  private runningProcesses = new Map<string, ReturnType<typeof spawn>>()
  private configs = new Map<string, PipelineConfig>() // per-project configs

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  getConfig(folderPath: string): PipelineConfig {
    return this.configs.get(folderPath) || { ...DEFAULT_PIPELINE_CONFIG }
  }

  setConfig(folderPath: string, config: PipelineConfig) {
    this.configs.set(folderPath, config)
    this.saveConfigs()
  }

  private getConfigPath(): string {
    const dir = join(homedir(), '.devhub-ai')
    mkdirSync(dir, { recursive: true })
    return join(dir, 'pipeline-configs.json')
  }

  loadConfigs() {
    try {
      const path = this.getConfigPath()
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, 'utf-8'))
        for (const [k, v] of Object.entries(data)) {
          this.configs.set(k, v as PipelineConfig)
        }
      }
    } catch { /* ignore */ }
  }

  private saveConfigs() {
    try {
      const obj: Record<string, PipelineConfig> = {}
      for (const [k, v] of this.configs) {
        obj[k] = v
      }
      writeFileSync(this.getConfigPath(), JSON.stringify(obj, null, 2))
    } catch { /* ignore */ }
  }

  private notify(run: PipelineRun) {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('pipeline-event', run)
      }
    } catch { /* ignore */ }
    this.saveRuns()
  }

  private getRunsPath(): string {
    const dir = join(homedir(), '.devhub-ai')
    mkdirSync(dir, { recursive: true })
    return join(dir, 'pipeline-runs.json')
  }

  private saveRuns() {
    try {
      const runs = Array.from(this.runs.values()).map(r => ({
        ...r,
        // Trim large log outputs for storage (keep last 2000 chars per log)
        logs: r.logs.map(l => ({
          ...l,
          output: l.output.length > 2000 ? '...' + l.output.slice(-2000) : l.output
        }))
      }))
      writeFileSync(this.getRunsPath(), JSON.stringify(runs, null, 2))
    } catch { /* ignore */ }
  }

  loadRuns() {
    try {
      const data = readFileSync(this.getRunsPath(), 'utf-8')
      const runs: PipelineRun[] = JSON.parse(data)
      for (const run of runs) {
        // Mark any previously-running pipelines as failed (app crashed)
        if (!['done', 'failed', 'paused'].includes(run.stage)) {
          run.stage = 'failed'
          run.error = 'App restarted while pipeline was running'
        }
        this.runs.set(run.id, run)
      }
    } catch { /* ignore — no saved runs yet */ }
  }

  getRun(id: string): PipelineRun | undefined {
    return this.runs.get(id)
  }

  getAllRuns(): PipelineRun[] {
    return Array.from(this.runs.values())
  }

  async startPipeline(folderName: string, folderPath: string, taskDescription: string): Promise<PipelineRun> {
    const id = `pipeline-${Date.now().toString(36)}`
    const config = this.getConfig(folderPath)

    const run: PipelineRun = {
      id,
      folderName,
      folderPath,
      taskDescription,
      stage: 'planning',
      retryCount: 0,
      maxRetries: config.maxRetries,
      logs: [],
      createdAt: new Date().toISOString()
    }

    this.runs.set(id, run)
    this.notify(run)

    // Start the pipeline async
    this.executePipeline(run, config).catch(err => {
      run.stage = 'failed'
      run.error = err instanceof Error ? err.message : String(err)
      this.notify(run)
    })

    return run
  }

  cancelPipeline(id: string) {
    const run = this.runs.get(id)
    if (!run) return

    // Kill any running process
    const proc = this.runningProcesses.get(id)
    if (proc) {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      this.runningProcesses.delete(id)
    }

    run.stage = 'failed'
    run.error = 'Cancelled by user'
    this.notify(run)

    // Cleanup worktrees
    this.cleanupWorktrees(run)
  }

  private async executePipeline(run: PipelineRun, config: PipelineConfig) {
    try {
      // Stage 1: Planning
      await this.runStage(run, 'planning', config)
      if (run.stage === 'failed') return

      // Stage 2-4: Implement → Validate → Review loop
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        run.retryCount = attempt

        // Stage 2: Implementing
        await this.runStage(run, 'implementing', config)
        if (run.stage === 'failed') return

        // Stage 3: Validating (build + test)
        await this.runStage(run, 'validating', config)
        if (run.stage === 'failed' && attempt >= config.maxRetries) return

        const validationLog = run.logs[run.logs.length - 1]

        if (validationLog?.success === false && attempt < config.maxRetries) {
          this.appendRetryMarker(run, 'Validation failed', attempt + 1, config.maxRetries)
          continue
        }

        // Stage 4: Reviewing
        await this.runStage(run, 'reviewing', config)
        if (run.stage === 'failed') return

        const reviewLog = run.logs[run.logs.length - 1]
        if (reviewLog?.success === true) {
          run.stage = 'done'
          this.notify(run)
          return
        }

        if (attempt < config.maxRetries) {
          // Extract reviewer feedback summary for the retry marker
          const feedback = reviewLog?.output?.includes('VERDICT:')
            ? reviewLog.output.substring(reviewLog.output.indexOf('VERDICT:'))
            : 'Changes requested'
          this.appendRetryMarker(run, feedback.slice(0, 200), attempt + 1, config.maxRetries)
          continue
        }
      }

      // Exhausted retries — show as done with warning, not paused/stuck
      run.stage = 'done'
      run.error = `Completed after ${config.maxRetries} review cycles. Check the branch for results.`
      this.notify(run)
    } catch (err) {
      run.stage = 'failed'
      run.error = err instanceof Error ? err.message : String(err)
      this.notify(run)
    }
  }

  private async runStage(run: PipelineRun, stage: PipelineStage, config: PipelineConfig) {
    run.stage = stage
    const log: PipelineStageLog = {
      stage,
      startedAt: new Date().toISOString(),
      output: ''
    }
    run.logs.push(log)
    this.notify(run)

    try {
      switch (stage) {
        case 'planning':
          await this.runPlanner(run, log)
          break
        case 'implementing':
          await this.runImplementer(run, log, config)
          break
        case 'validating':
          await this.runValidator(run, log, config)
          break
        case 'reviewing':
          await this.runReviewer(run, log)
          break
      }
    } catch (err) {
      log.success = false
      log.output += `\nError: ${err instanceof Error ? err.message : String(err)}`
      log.endedAt = new Date().toISOString()
      run.stage = 'failed'
      run.error = err instanceof Error ? err.message : String(err)
      this.notify(run)
    }
  }

  private getDefaultBranch(folderPath: string): string {
    // Try to detect the default branch (main/master) from remote
    try {
      const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
        cwd: folderPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      // refs/remotes/origin/main → main
      return remoteHead.replace('refs/remotes/origin/', '')
    } catch { /* ignore */ }

    // Fallback: check if main or master exists
    try {
      execSync('git rev-parse --verify main', {
        cwd: folderPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      })
      return 'main'
    } catch { /* ignore */ }

    try {
      execSync('git rev-parse --verify master', {
        cwd: folderPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      })
      return 'master'
    } catch { /* ignore */ }

    // Last resort: use current branch
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: folderPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  }

  private createWorktree(folderPath: string, label: string): { worktreePath: string; branchName: string; baseBranch: string } {
    const timestamp = Date.now().toString(36)
    const slug = label.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()
    const worktreeBase = join(homedir(), '.devhub-ai', 'worktrees', slug)
    const worktreePath = join(worktreeBase, `pipeline-${timestamp}`, 'worktree')
    const branchName = `devhub-ai/pipeline-${slug}-${timestamp}`

    const baseBranch = this.getDefaultBranch(folderPath)

    mkdirSync(join(worktreeBase, `pipeline-${timestamp}`), { recursive: true })
    execSync(
      `git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`,
      { cwd: folderPath, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
    )

    return { worktreePath, branchName, baseBranch }
  }

  private async runClaude(cwd: string, prompt: string, runId: string, log: PipelineStageLog): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, TERM: 'xterm-256color', PATH: getShellPath() }
      delete env.CLAUDECODE

      // Write prompt to a temp file to avoid stdin buffering issues with large prompts
      const promptDir = join(homedir(), '.devhub-ai', 'tmp')
      mkdirSync(promptDir, { recursive: true })
      const promptFile = join(promptDir, `prompt-${runId}.txt`)
      writeFileSync(promptFile, prompt)

      // Use resolved full path to claude with stream-json for real-time output
      const claude = getClaudePath()
      const permFlag = loadState().dangerousMode ? ' --dangerously-skip-permissions' : ''
      const proc = spawn('/bin/zsh', ['-c', `cat "${promptFile}" | "${claude}" -p${permFlag} --output-format stream-json --verbose`], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      this.runningProcesses.set(runId, proc)
      let resultText = ''
      let buffer = ''

      proc.stdout.on('data', (data: Buffer) => {
        buffer += data.toString()
        // Process complete JSON lines
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'assistant' && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'text' && block.text) {
                  log.output += block.text
                  resultText += block.text
                  this.notify(this.runs.get(runId)!)
                }
              }
            } else if (msg.type === 'assistant' && msg.message?.role === 'assistant') {
              // Tool use or other assistant message — show a brief status
              const content = msg.message.content || []
              for (const block of content) {
                if (block.type === 'tool_use') {
                  const toolName = block.name || 'unknown'
                  const brief = `[using ${toolName}...]\n`
                  log.output += brief
                  this.notify(this.runs.get(runId)!)
                }
              }
            } else if (msg.type === 'result') {
              if (msg.result) {
                resultText = msg.result
              }
            }
          } catch {
            // Not JSON, just append raw
            log.output += line + '\n'
            resultText += line + '\n'
            this.notify(this.runs.get(runId)!)
          }
        }
      })

      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString()
        log.output += `[stderr] ${text}`
        this.notify(this.runs.get(runId)!)
      })

      proc.on('close', (code) => {
        this.runningProcesses.delete(runId)
        try { require('fs').unlinkSync(promptFile) } catch { /* ignore */ }
        if (code === 0) {
          resolve(resultText)
        } else {
          reject(new Error(`Claude exited with code ${code}`))
        }
      })

      proc.on('error', (err) => {
        this.runningProcesses.delete(runId)
        try { require('fs').unlinkSync(promptFile) } catch { /* ignore */ }
        reject(err)
      })
    })
  }

  private appendRetryMarker(run: PipelineRun, reason: string, nextAttempt: number, maxRetries: number) {
    // Add a visible log entry marking the retry transition
    const retryLog: PipelineStageLog = {
      stage: 'implementing',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      output: `--- Retry ${nextAttempt}/${maxRetries} ---\nReason: ${reason}\nRe-running implementation with feedback from previous attempt...\n`,
      success: undefined
    }
    run.logs.push(retryLog)
    this.notify(run)
  }

  private appendLog(run: PipelineRun, log: PipelineStageLog, msg: string) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
    log.output += `[${ts}] ${msg}\n`
    this.notify(run)
  }

  private async runPlanner(run: PipelineRun, log: PipelineStageLog) {
    this.appendLog(run, log, 'Creating planner worktree...')
    const { worktreePath, baseBranch } = this.createWorktree(run.folderPath, `${run.folderName}-plan`)
    run.plannerWorktree = worktreePath
    this.appendLog(run, log, `Worktree created from ${baseBranch} at ${worktreePath}`)
    this.appendLog(run, log, 'Starting Claude planner agent...')

    const prompt = `You are a planning agent. Analyze the codebase and create a detailed implementation plan for this task:

${run.taskDescription}

Output a structured plan with:
1. Files to create or modify
2. Step-by-step implementation approach
3. Acceptance criteria (what tests should pass, what behavior to verify)
4. Potential risks or edge cases

Write the plan to a file called PIPELINE_PLAN.md in the project root.
Do NOT implement the changes — only plan.`

    const output = await this.runClaude(worktreePath, prompt, run.id, log)

    this.appendLog(run, log, 'Claude planner finished.')

    // Copy the plan to a temp location for the implementer
    const planPath = join(worktreePath, 'PIPELINE_PLAN.md')
    if (existsSync(planPath)) {
      const planContent = readFileSync(planPath, 'utf-8')
      this.appendLog(run, log, `Plan written (${planContent.length} chars). Saved for next stages.`)
      // Store plan in a separate field so we don't overwrite progress logs
      log.plan = planContent
    } else {
      this.appendLog(run, log, 'Warning: No PIPELINE_PLAN.md found. Using Claude output as plan.')
    }

    log.success = true
    log.endedAt = new Date().toISOString()
    this.appendLog(run, log, 'Cleaning up planner worktree...')

    // Cleanup planner worktree
    this.cleanupSingleWorktree(worktreePath, run.folderPath)
    run.plannerWorktree = undefined
    this.appendLog(run, log, 'Planning stage complete.')
  }

  private async runImplementer(run: PipelineRun, log: PipelineStageLog, config: PipelineConfig) {
    // Create implementer worktree (reuse if retrying)
    if (!run.implementerWorktree) {
      this.appendLog(run, log, 'Creating implementer worktree...')
      const { worktreePath, branchName, baseBranch } = this.createWorktree(run.folderPath, `${run.folderName}-impl`)
      run.implementerWorktree = worktreePath
      run.implementerBranch = branchName
      this.appendLog(run, log, `Base: ${baseBranch} → Branch: ${branchName}`)
      this.appendLog(run, log, `Worktree: ${worktreePath}`)
    } else {
      this.appendLog(run, log, `Reusing existing worktree (retry ${run.retryCount})`)
    }

    // Get the plan from the planning stage
    const planLog = run.logs.find(l => l.stage === 'planning' && l.success)
    const plan = planLog?.plan || planLog?.output || run.taskDescription

    // Build retry context if this is a retry
    let retryContext = ''
    if (run.retryCount > 0) {
      const prevLogs = run.logs.filter(l =>
        (l.stage === 'validating' || l.stage === 'reviewing') && l.success === false
      )
      if (prevLogs.length > 0) {
        retryContext = `\n\nPREVIOUS ATTEMPT FAILED. Here is the feedback:\n${prevLogs.map(l => l.output).join('\n---\n')}\n\nFix the issues and try again.`
      }
    }

    this.appendLog(run, log, 'Starting Claude implementer agent...')

    const prompt = `You are an implementation agent. Implement the following plan:

${plan}
${retryContext}

Implement all changes. Run tests if available. Make sure the code compiles.
${config.buildCommand ? `Build command: ${config.buildCommand}` : ''}
${config.testCommand ? `Test command: ${config.testCommand}` : ''}`

    await this.runClaude(run.implementerWorktree, prompt, run.id, log)

    this.appendLog(run, log, 'Implementation stage complete.')
    log.success = true
    log.endedAt = new Date().toISOString()
    this.notify(run)
  }

  private isCommandAvailable(cmd: string): boolean {
    // Extract the binary name from the command (first word)
    const binary = cmd.split(/\s+/)[0]
    try {
      execSync(`/bin/zsh -lc "which ${binary}"`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      return true
    } catch {
      return false
    }
  }

  private async runValidator(run: PipelineRun, log: PipelineStageLog, config: PipelineConfig) {
    if (!run.implementerWorktree) {
      log.success = false
      log.output = 'No implementer worktree found'
      log.endedAt = new Date().toISOString()
      return
    }

    const cwd = run.implementerWorktree
    let allPassed = true
    const shellPath = getShellPath()

    // Auto-detect commands if not configured
    let buildCmd = config.buildCommand || this.detectBuildCommand(cwd)
    let testCmd = config.testCommand || this.detectTestCommand(cwd)

    // Verify detected tools are actually installed
    if (buildCmd && !this.isCommandAvailable(buildCmd)) {
      this.appendLog(run, log, `Build tool not available: ${buildCmd.split(/\s+/)[0]} — skipping build`)
      buildCmd = ''
    }
    if (testCmd && !this.isCommandAvailable(testCmd)) {
      this.appendLog(run, log, `Test tool not available: ${testCmd.split(/\s+/)[0]} — skipping tests`)
      testCmd = ''
    }

    this.appendLog(run, log, `Build command: ${buildCmd || '(none — skipped)'}`)
    this.appendLog(run, log, `Test command: ${testCmd || '(none — skipped)'}`)

    if (buildCmd) {
      this.appendLog(run, log, `Running build: ${buildCmd}`)
      log.output += `\n--- Running build: ${buildCmd} ---\n`
      this.notify(run)
      try {
        const env = { ...process.env, PATH: shellPath }
        const buildOutput = execSync(buildCmd, { cwd, env, encoding: 'utf-8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
        log.output += buildOutput + '\nBuild: PASSED\n'
      } catch (err: unknown) {
        const msg = err instanceof Error ? (err as any).stderr || err.message : String(err)
        log.output += msg + '\nBuild: FAILED\n'
        allPassed = false
      }
    }

    if (testCmd) {
      this.appendLog(run, log, `Running tests: ${testCmd}`)
      log.output += `\n--- Running tests: ${testCmd} ---\n`
      this.notify(run)
      try {
        const env = { ...process.env, PATH: shellPath }
        const testOutput = execSync(testCmd, { cwd, env, encoding: 'utf-8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] })
        log.output += testOutput + '\nTests: PASSED\n'
      } catch (err: unknown) {
        const msg = err instanceof Error ? (err as any).stderr || err.message : String(err)
        log.output += msg + '\nTests: FAILED\n'
        allPassed = false
      }
    }

    if (!buildCmd && !testCmd) {
      this.appendLog(run, log, 'No build or test tools available for this project. Skipping validation.')
      allPassed = true // Don't fail the pipeline when we can't validate
    }

    log.success = allPassed
    log.endedAt = new Date().toISOString()
    this.notify(run)
  }

  private async runReviewer(run: PipelineRun, log: PipelineStageLog) {
    if (!run.implementerWorktree) {
      log.success = false
      log.output = 'No implementer worktree to review'
      log.endedAt = new Date().toISOString()
      return
    }

    this.appendLog(run, log, 'Creating reviewer worktree...')
    // Create reviewer worktree
    const { worktreePath } = this.createWorktree(run.folderPath, `${run.folderName}-review`)
    run.reviewerWorktree = worktreePath
    this.appendLog(run, log, `Reviewer worktree: ${worktreePath}`)

    // Get the diff from the implementer
    this.appendLog(run, log, 'Extracting diff from implementer...')
    let diff = ''
    try {
      diff = execSync('git diff HEAD', {
        cwd: run.implementerWorktree, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore']
      })
      if (!diff.trim()) {
        diff = execSync('git log --oneline -5 && git diff HEAD~1', {
          cwd: run.implementerWorktree, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore']
        })
      }
    } catch { /* ignore */ }

    const planLog = run.logs.find(l => l.stage === 'planning' && l.success)
    const plan = planLog?.output || run.taskDescription

    this.appendLog(run, log, `Diff size: ${diff.length} chars`)
    this.appendLog(run, log, 'Starting Claude reviewer agent...')

    const prompt = `You are a code review agent. You have NOT seen the implementation process — only the diff and the original plan.

ORIGINAL TASK:
${run.taskDescription}

PLAN:
${plan}

DIFF:
${diff}

Review this diff for:
1. Correctness — does it implement the plan properly?
2. Security — any vulnerabilities introduced?
3. Code quality — naming, structure, edge cases
4. Completeness — anything missing from the acceptance criteria?

Output your verdict at the END in exactly this format:
VERDICT: APPROVED
or
VERDICT: CHANGES_REQUESTED
followed by specific feedback on what to fix.`

    const output = await this.runClaude(worktreePath, prompt, run.id, log)

    const approved = output.includes('VERDICT: APPROVED')
    this.appendLog(run, log, `Review verdict: ${approved ? 'APPROVED' : 'CHANGES REQUESTED'}`)
    log.success = approved
    log.endedAt = new Date().toISOString()

    this.appendLog(run, log, 'Cleaning up reviewer worktree...')
    // Cleanup reviewer worktree
    this.cleanupSingleWorktree(worktreePath, run.folderPath)
    run.reviewerWorktree = undefined
    this.appendLog(run, log, 'Review stage complete.')
  }

  private detectBuildCommand(cwd: string): string {
    if (existsSync(join(cwd, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'))
        if (pkg.scripts?.build) return 'npm run build'
      } catch { /* ignore */ }
    }
    if (existsSync(join(cwd, 'build.sbt'))) return 'sbt compile'
    if (existsSync(join(cwd, 'pom.xml'))) return 'mvn compile'
    if (existsSync(join(cwd, 'build.gradle')) || existsSync(join(cwd, 'build.gradle.kts'))) return 'gradle build'
    if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo build'
    if (existsSync(join(cwd, 'go.mod'))) return 'go build ./...'
    return ''
  }

  private detectTestCommand(cwd: string): string {
    if (existsSync(join(cwd, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'))
        if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          return 'npm test'
        }
      } catch { /* ignore */ }
    }
    if (existsSync(join(cwd, 'build.sbt'))) return 'sbt test'
    if (existsSync(join(cwd, 'pom.xml'))) return 'mvn test'
    if (existsSync(join(cwd, 'build.gradle')) || existsSync(join(cwd, 'build.gradle.kts'))) return 'gradle test'
    if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo test'
    if (existsSync(join(cwd, 'go.mod'))) return 'go test ./...'
    if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'setup.py'))) return 'pytest'
    return ''
  }

  private cleanupSingleWorktree(worktreePath: string, folderPath: string) {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: folderPath, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch { /* ignore */ }
  }

  private cleanupWorktrees(run: PipelineRun) {
    if (run.plannerWorktree) this.cleanupSingleWorktree(run.plannerWorktree, run.folderPath)
    if (run.implementerWorktree) this.cleanupSingleWorktree(run.implementerWorktree, run.folderPath)
    if (run.reviewerWorktree) this.cleanupSingleWorktree(run.reviewerWorktree, run.folderPath)
  }

  destroyAll() {
    for (const [id, proc] of this.runningProcesses) {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
    }
    this.runningProcesses.clear()
  }
}

export const pipelineManager = new PipelineManager()
