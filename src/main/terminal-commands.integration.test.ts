/**
 * @vitest-environment node
 *
 * Integration tests that spawn REAL PTY processes and execute actual shell commands.
 * These verify the terminal works correctly as a real terminal — not mocked.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn as ptySpawn } from 'node-pty'
import { tmpdir } from 'os'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

// Helper: spawn a PTY, run a command, collect output, wait for it to appear
function runInPty(
  command: string,
  opts?: { cwd?: string; cols?: number; rows?: number; timeout?: number; env?: Record<string, string> }
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const timeout = opts?.timeout ?? 10000
    let output = ''
    let exited = false

    const proc = ptySpawn('/bin/zsh', ['-c', command], {
      name: 'xterm-256color',
      cols: opts?.cols ?? 120,
      rows: opts?.rows ?? 24,
      cwd: opts?.cwd ?? tmpdir(),
      env: { ...process.env, TERM: 'xterm-256color', ...opts?.env } as Record<string, string>,
    })

    proc.onData((data: string) => {
      output += data
    })

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      exited = true
      resolve({ output, exitCode })
    })

    const timer = setTimeout(() => {
      if (!exited) {
        proc.kill()
        reject(new Error(`Timed out after ${timeout}ms. Output so far: ${output.substring(0, 500)}`))
      }
    }, timeout)

    proc.onExit(() => clearTimeout(timer))
  })
}

// Helper: spawn interactive PTY, write commands, collect output
function runInteractive(opts?: {
  cwd?: string; cols?: number; rows?: number; timeout?: number; env?: Record<string, string>
}): {
  write: (data: string) => void
  waitForOutput: (match: string | RegExp, timeoutMs?: number) => Promise<string>
  getOutput: () => string
  destroy: () => void
  onExit: () => Promise<number>
} {
  let output = ''
  let exitCode = -1
  let exitResolve: ((code: number) => void) | null = null

  const proc = ptySpawn('/bin/zsh', ['-i'], {
    name: 'xterm-256color',
    cols: opts?.cols ?? 120,
    rows: opts?.rows ?? 24,
    cwd: opts?.cwd ?? tmpdir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      DISABLE_AUTO_UPDATE: 'true',
      DISABLE_UPDATE_PROMPT: 'true',
      ...opts?.env,
    } as Record<string, string>,
  })

  proc.onData((data: string) => {
    output += data
  })

  proc.onExit(({ exitCode: code }: { exitCode: number }) => {
    exitCode = code
    if (exitResolve) exitResolve(code)
  })

  return {
    write(data: string) {
      proc.write(data)
    },
    waitForOutput(match: string | RegExp, timeoutMs = 8000): Promise<string> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (typeof match === 'string' ? output.includes(match) : match.test(output)) {
            resolve(output)
          } else if (timeoutMs <= 0) {
            reject(new Error(
              `Timed out waiting for ${match}.\nOutput so far (last 600 chars):\n${output.slice(-600)}`
            ))
          } else {
            timeoutMs -= 100
            setTimeout(check, 100)
          }
        }
        check()
      })
    },
    getOutput: () => output,
    destroy() {
      try { proc.kill() } catch { /* already dead */ }
    },
    onExit(): Promise<number> {
      if (exitCode >= 0) return Promise.resolve(exitCode)
      return new Promise(resolve => { exitResolve = resolve })
    },
  }
}

// Temp directory for each test
let tempDir: string
function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'devhub-ai-test-'))
  return tempDir
}

afterEach(() => {
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// Strip ANSI escape codes for cleaner assertions
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// ─── BASIC COMMANDS ─────────────────────────────────────────────
describe('Basic command execution', () => {
  it('echo prints output correctly', async () => {
    const { output } = await runInPty('echo "HELLO_DEVHUB_AI_TEST"')
    expect(output).toContain('HELLO_DEVHUB_AI_TEST')
  })

  it('pwd shows current directory', async () => {
    const dir = makeTempDir()
    const { output } = await runInPty('pwd', { cwd: dir })
    expect(output).toContain(dir)
  })

  it('ls lists files in directory', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'testfile.txt'), 'content')
    writeFileSync(join(dir, 'another.md'), 'content')
    const { output } = await runInPty('ls', { cwd: dir })
    expect(output).toContain('testfile.txt')
    expect(output).toContain('another.md')
  })

  it('cat reads file content', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'hello.txt'), 'DEVHUB_AI_FILE_CONTENT_123')
    const { output } = await runInPty('cat hello.txt', { cwd: dir })
    expect(output).toContain('DEVHUB_AI_FILE_CONTENT_123')
  })

  it('command exit code is 0 for success', async () => {
    const { exitCode } = await runInPty('true')
    expect(exitCode).toBe(0)
  })

  it('command exit code is non-zero for failure', async () => {
    const { exitCode } = await runInPty('false')
    expect(exitCode).not.toBe(0)
  })

  it('command not found returns error output and non-zero exit', async () => {
    const { output, exitCode } = await runInPty('nonexistent_command_xyz_123 2>&1')
    expect(stripAnsi(output)).toMatch(/not found|command not found/i)
    expect(exitCode).not.toBe(0)
  })

  it('which finds common tools', async () => {
    const { output } = await runInPty('which git')
    expect(stripAnsi(output).trim()).toMatch(/\/git/)
  })
})

// ─── PIPES AND REDIRECTION ─────────────────────────────────────
describe('Pipes and redirection', () => {
  it('pipe output between commands', async () => {
    const { output } = await runInPty('echo "alpha\\nbeta\\ngamma" | grep beta')
    expect(output).toContain('beta')
    expect(output).not.toContain('alpha')
  })

  it('write and read via redirection', async () => {
    const dir = makeTempDir()
    const { output } = await runInPty(
      'echo "REDIRECT_TEST_DATA" > out.txt && cat out.txt',
      { cwd: dir }
    )
    expect(output).toContain('REDIRECT_TEST_DATA')
  })

  it('append redirection works', async () => {
    const dir = makeTempDir()
    const { output } = await runInPty(
      'echo "LINE1" > f.txt && echo "LINE2" >> f.txt && cat f.txt',
      { cwd: dir }
    )
    expect(output).toContain('LINE1')
    expect(output).toContain('LINE2')
  })

  it('stderr can be redirected', async () => {
    const dir = makeTempDir()
    const { output } = await runInPty(
      'ls /nonexistent_path 2> err.txt; cat err.txt',
      { cwd: dir }
    )
    expect(stripAnsi(output)).toMatch(/no such file|not found|cannot access/i)
  })

  it('pipe chain with multiple stages', async () => {
    const { output } = await runInPty('echo "aaa\\nbbb\\nccc\\naab" | sort | grep aa')
    const clean = stripAnsi(output)
    expect(clean).toContain('aaa')
    expect(clean).toContain('aab')
  })

  it('wc counts lines correctly', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'lines.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    const { output } = await runInPty('wc -l < lines.txt', { cwd: dir })
    expect(stripAnsi(output).trim()).toMatch(/5/)
  })
})

// ─── ENVIRONMENT VARIABLES ──────────────────────────────────────
describe('Environment variables', () => {
  it('reads inherited env vars', async () => {
    const { output } = await runInPty('echo $HOME')
    expect(output).toContain(process.env.HOME!)
  })

  it('sets and reads local env vars', async () => {
    const { output } = await runInPty('MY_TEST_VAR="devhub-ai_val_42" && echo $MY_TEST_VAR')
    expect(output).toContain('devhub-ai_val_42')
  })

  it('export makes var available to subprocesses', async () => {
    const { output } = await runInPty(
      'export DEVHUB_AI_EXPORT_TEST="exported_val" && /bin/zsh -c \'echo $DEVHUB_AI_EXPORT_TEST\''
    )
    expect(output).toContain('exported_val')
  })

  it('custom env vars are passed through', async () => {
    const { output } = await runInPty('echo $CUSTOM_PTY_VAR', {
      env: { CUSTOM_PTY_VAR: 'pty_test_value' },
    })
    expect(output).toContain('pty_test_value')
  })

  it('PATH is functional', async () => {
    const { output } = await runInPty('echo $PATH')
    expect(output).toContain('/usr')
  })
})

// ─── SUBSHELLS AND COMMAND SUBSTITUTION ─────────────────────────
describe('Subshells and command substitution', () => {
  it('$() command substitution works', async () => {
    const { output } = await runInPty('echo "Today is $(date +%Y)"')
    const year = new Date().getFullYear().toString()
    expect(output).toContain(year)
  })

  it('backtick substitution works', async () => {
    const { output } = await runInPty('echo "Home is `echo $HOME`"')
    expect(output).toContain(process.env.HOME!)
  })

  it('subshell with parentheses runs in isolation', async () => {
    const { output } = await runInPty(
      'X=outer && (X=inner && echo "inside: $X") && echo "outside: $X"'
    )
    expect(output).toContain('inside: inner')
    expect(output).toContain('outside: outer')
  })

  it('arithmetic expansion works', async () => {
    const { output } = await runInPty('echo "Result: $((6 * 7))"')
    expect(output).toContain('Result: 42')
  })
})

// ─── MULTI-LINE AND COMPLEX COMMANDS ────────────────────────────
describe('Multi-line and complex commands', () => {
  it('for loop executes correctly', async () => {
    const { output } = await runInPty(
      'for i in 1 2 3; do echo "item_$i"; done'
    )
    expect(output).toContain('item_1')
    expect(output).toContain('item_2')
    expect(output).toContain('item_3')
  })

  it('if/else conditional works', async () => {
    const { output } = await runInPty(
      'if [ -d /tmp ]; then echo "DIR_EXISTS"; else echo "NO_DIR"; fi'
    )
    expect(output).toContain('DIR_EXISTS')
  })

  it('while loop with counter', async () => {
    const { output } = await runInPty(
      'i=0; while [ $i -lt 3 ]; do echo "count_$i"; i=$((i+1)); done'
    )
    expect(output).toContain('count_0')
    expect(output).toContain('count_1')
    expect(output).toContain('count_2')
  })

  it('command chaining with && works', async () => {
    const { output } = await runInPty('echo "first" && echo "second" && echo "third"')
    const clean = stripAnsi(output)
    expect(clean).toContain('first')
    expect(clean).toContain('second')
    expect(clean).toContain('third')
  })

  it('command chaining with || handles failure', async () => {
    const { output } = await runInPty('false || echo "FALLBACK_RAN"')
    expect(output).toContain('FALLBACK_RAN')
  })

  it('&& stops on failure', async () => {
    const { output } = await runInPty('false && echo "SHOULD_NOT_APPEAR"; echo "AFTER"')
    expect(output).not.toContain('SHOULD_NOT_APPEAR')
    expect(output).toContain('AFTER')
  })
})

// ─── FILE SYSTEM OPERATIONS ─────────────────────────────────────
describe('File system operations', () => {
  it('mkdir and cd work', async () => {
    const dir = makeTempDir()
    const { output } = await runInPty(
      'mkdir -p subdir/nested && cd subdir/nested && pwd',
      { cwd: dir }
    )
    expect(output).toContain('subdir/nested')
  })

  it('cp and mv work', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'original.txt'), 'COPY_TEST')
    const { output } = await runInPty(
      'cp original.txt copy.txt && mv copy.txt moved.txt && cat moved.txt',
      { cwd: dir }
    )
    expect(output).toContain('COPY_TEST')
  })

  it('rm removes files', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'delete_me.txt'), 'temp')
    const { output } = await runInPty(
      'rm delete_me.txt && ls',
      { cwd: dir }
    )
    expect(output).not.toContain('delete_me.txt')
  })

  it('find locates files', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'deep', 'nested'), { recursive: true })
    writeFileSync(join(dir, 'deep', 'nested', 'target.txt'), 'found')
    const { output } = await runInPty(
      'find . -name "target.txt"',
      { cwd: dir }
    )
    expect(output).toContain('target.txt')
  })

  it('handles paths with spaces', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'dir with spaces'))
    writeFileSync(join(dir, 'dir with spaces', 'file.txt'), 'SPACE_PATH_CONTENT')
    const { output } = await runInPty(
      'cat "dir with spaces/file.txt"',
      { cwd: dir }
    )
    expect(output).toContain('SPACE_PATH_CONTENT')
  })
})

// ─── GIT OPERATIONS ─────────────────────────────────────────────
describe('Git operations', () => {
  it('git init creates a repository', async () => {
    const dir = makeTempDir()
    const { output, exitCode } = await runInPty(
      'git init && git status',
      { cwd: dir }
    )
    expect(exitCode).toBe(0)
    const clean = stripAnsi(output)
    expect(clean).toMatch(/initialized|on branch/i)
  })

  it('git add and commit work', async () => {
    const dir = makeTempDir()
    const { output, exitCode } = await runInPty(
      'git init && git config user.email "test@test.com" && git config user.name "Test" && ' +
      'echo "hello" > file.txt && git add file.txt && git commit -m "initial" && ' +
      'git log --oneline',
      { cwd: dir, timeout: 15000, env: { GIT_PAGER: '' } }
    )
    expect(exitCode).toBe(0)
    expect(stripAnsi(output)).toContain('initial')
  }, 20000)

  it('git branch and checkout work', async () => {
    const dir = makeTempDir()
    const { output, exitCode } = await runInPty(
      'git init && git config user.email "t@t.com" && git config user.name "T" && ' +
      'echo "a" > f.txt && git add f.txt && git commit -m "init" && ' +
      'git checkout -b test-branch && git branch',
      { cwd: dir, timeout: 15000, env: { GIT_PAGER: '' } }
    )
    expect(exitCode).toBe(0)
    expect(stripAnsi(output)).toContain('test-branch')
  }, 20000)

  it('git diff shows changes', async () => {
    const dir = makeTempDir()
    const { output } = await runInPty(
      'git init && git config user.email "t@t.com" && git config user.name "T" && ' +
      'echo "original" > f.txt && git add f.txt && git commit -m "init" && ' +
      'echo "modified" > f.txt && git --no-pager diff',
      { cwd: dir, timeout: 15000, env: { GIT_PAGER: '' } }
    )
    const clean = stripAnsi(output)
    expect(clean).toContain('original')
    expect(clean).toContain('modified')
  }, 20000)
})

// ─── LARGE OUTPUT AND STREAMING ─────────────────────────────────
describe('Large output and streaming', () => {
  it('handles 1000 lines of output', async () => {
    const { output, exitCode } = await runInPty('seq 1 1000')
    expect(exitCode).toBe(0)
    expect(output).toContain('1')
    expect(output).toContain('500')
    expect(output).toContain('1000')
  })

  it('handles 10000 lines without crash', async () => {
    const { output, exitCode } = await runInPty('seq 1 10000', { timeout: 15000 })
    expect(exitCode).toBe(0)
    expect(output).toContain('10000')
  })

  it('yes piped to head works (infinite producer with limit)', async () => {
    const { output, exitCode } = await runInPty('yes "REPEAT" | head -5')
    expect(exitCode).toBe(0)
    const count = (output.match(/REPEAT/g) || []).length
    expect(count).toBeGreaterThanOrEqual(5)
  })

  it('handles output with ANSI color codes', async () => {
    const { output } = await runInPty('printf "\\033[31mRED\\033[0m \\033[32mGREEN\\033[0m"')
    expect(stripAnsi(output)).toContain('RED')
    expect(stripAnsi(output)).toContain('GREEN')
    // Raw output should have escape codes
    expect(output).toContain('\x1b[')
  })
})

// ─── INTERACTIVE PTY BEHAVIOR ───────────────────────────────────
describe('Interactive PTY behavior', () => {
  it('interactive shell responds to typed commands', async () => {
    const pty = runInteractive()
    try {
      // Wait for shell prompt
      await pty.waitForOutput(/[\$%#>]/, 5000)
      pty.write('echo "INTERACTIVE_TEST_OUTPUT"\r')
      await pty.waitForOutput('INTERACTIVE_TEST_OUTPUT', 5000)
      expect(pty.getOutput()).toContain('INTERACTIVE_TEST_OUTPUT')
    } finally {
      pty.destroy()
    }
  })

  it('can run multiple commands sequentially', async () => {
    const pty = runInteractive()
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      pty.write('echo "CMD_ONE"\r')
      await pty.waitForOutput('CMD_ONE', 5000)
      pty.write('echo "CMD_TWO"\r')
      await pty.waitForOutput('CMD_TWO', 5000)
      pty.write('echo "CMD_THREE"\r')
      await pty.waitForOutput('CMD_THREE', 5000)
      const out = pty.getOutput()
      expect(out).toContain('CMD_ONE')
      expect(out).toContain('CMD_TWO')
      expect(out).toContain('CMD_THREE')
    } finally {
      pty.destroy()
    }
  })

  it('Ctrl+C interrupts a running command', async () => {
    const pty = runInteractive()
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      pty.write('sleep 999\r')
      await new Promise(r => setTimeout(r, 500))
      pty.write('\x03') // Ctrl+C
      await new Promise(r => setTimeout(r, 500))
      // Verify shell is still alive by running another command
      pty.write('echo "AFTER_CTRL_C"\r')
      await pty.waitForOutput('AFTER_CTRL_C', 8000)
    } finally {
      pty.destroy()
    }
  }, 15000)

  it('terminal resize updates COLUMNS', async () => {
    const pty = runInteractive({ cols: 80 })
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      pty.write('echo $COLUMNS\r')
      await pty.waitForOutput('80', 5000)
    } finally {
      pty.destroy()
    }
  })

  it('exit command terminates the shell', async () => {
    const pty = runInteractive()
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      pty.write('exit 0\r')
      const code = await pty.onExit()
      expect(code).toBe(0)
    } finally {
      pty.destroy()
    }
  })

  it('handles rapid sequential input', async () => {
    const pty = runInteractive()
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      // Send 20 rapid echo commands
      for (let i = 0; i < 20; i++) {
        pty.write(`echo "rapid_${i}"\r`)
      }
      // All should eventually appear
      await pty.waitForOutput('rapid_19', 10000)
      const out = pty.getOutput()
      for (let i = 0; i < 20; i++) {
        expect(out).toContain(`rapid_${i}`)
      }
    } finally {
      pty.destroy()
    }
  })
})

// ─── SPECIAL CHARACTERS AND UNICODE ─────────────────────────────
describe('Special characters and unicode', () => {
  it('handles single quotes in echo', async () => {
    const { output } = await runInPty("echo 'hello world'")
    expect(output).toContain('hello world')
  })

  it('handles double quotes with variables', async () => {
    const { output } = await runInPty('X=test && echo "value is $X"')
    expect(output).toContain('value is test')
  })

  it('handles backslashes in output', async () => {
    const { output } = await runInPty(String.raw`printf 'a\\b\\c\n'`)
    expect(output).toContain('a\\b\\c')
  })

  it('handles unicode characters', async () => {
    const { output } = await runInPty('echo "Hello 世界 🌍"')
    expect(output).toContain('Hello')
    expect(output).toContain('世界')
  })

  it('handles tab characters in output', async () => {
    const { output } = await runInPty('printf "col1\\tcol2\\tcol3\\n"')
    expect(stripAnsi(output)).toMatch(/col1.*col2.*col3/)
  })

  it('handles filenames with special characters', async () => {
    const dir = makeTempDir()
    const { output } = await runInPty(
      'echo "content" > "file with spaces.txt" && cat "file with spaces.txt"',
      { cwd: dir }
    )
    expect(output).toContain('content')
  })
})

// ─── PROCESS AND SIGNAL HANDLING ────────────────────────────────
describe('Process and signal handling', () => {
  it('background process with & works', async () => {
    const { output, exitCode } = await runInPty(
      'sleep 0.1 & echo "BG_STARTED" && wait && echo "BG_DONE"',
      { timeout: 5000 }
    )
    expect(exitCode).toBe(0)
    expect(output).toContain('BG_STARTED')
    expect(output).toContain('BG_DONE')
  })

  it('$? captures exit code of last command', async () => {
    const { output } = await runInPty('false; echo "exit_code=$?"')
    expect(output).toContain('exit_code=1')
  })

  it('trap command works', async () => {
    const { output } = await runInPty(
      'trap "echo TRAPPED" EXIT; echo "before_exit"'
    )
    expect(output).toContain('before_exit')
    expect(output).toContain('TRAPPED')
  })

  it('$$ returns PID', async () => {
    const { output } = await runInPty('echo "pid=$$"')
    expect(output).toMatch(/pid=\d+/)
  })
})

// ─── BRACKETED PASTE (DevHub-AI ChatInputBar send mechanism) ──────
describe('Bracketed paste input (ChatInputBar simulation)', () => {
  // This is exactly how DevHub-AI sends text from ChatInputBar to the PTY:
  // Step 1: \x1b[200~text\x1b[201~ (bracketed paste)
  // Step 2: \r (Enter key, sent separately)

  it('bracketed paste + \\r in single write executes command', async () => {
    const pty = runInteractive()
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      // Single write: paste markers + \r together (original approach)
      pty.write('\x1b[200~echo "BP_SINGLE_TEST"\x1b[201~\r')
      await pty.waitForOutput('BP_SINGLE_TEST', 5000)
      expect(pty.getOutput()).toContain('BP_SINGLE_TEST')
    } finally {
      pty.destroy()
    }
  })

  it('bracketed paste then delayed \\r executes command', async () => {
    const pty = runInteractive()
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      // Two writes: paste first, then \r after 50ms (current DevHub-AI approach)
      pty.write('\x1b[200~echo "BP_DELAYED_TEST"\x1b[201~')
      await new Promise(r => setTimeout(r, 50))
      pty.write('\r')
      await pty.waitForOutput('BP_DELAYED_TEST', 5000)
      expect(pty.getOutput()).toContain('BP_DELAYED_TEST')
    } finally {
      pty.destroy()
    }
  })

  it('plain text + \\r without bracketed paste executes command', async () => {
    const pty = runInteractive()
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      // Simplest approach: just text + \r
      pty.write('echo "PLAIN_TEST"\r')
      await pty.waitForOutput('PLAIN_TEST', 5000)
      expect(pty.getOutput()).toContain('PLAIN_TEST')
    } finally {
      pty.destroy()
    }
  })

  it('plain text + \\n without bracketed paste executes command', async () => {
    const pty = runInteractive()
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      // Alternative: text + \n instead of \r
      pty.write('echo "NEWLINE_TEST"\n')
      await pty.waitForOutput('NEWLINE_TEST', 5000)
      expect(pty.getOutput()).toContain('NEWLINE_TEST')
    } finally {
      pty.destroy()
    }
  })

  it('bracketed paste + \\n executes command', async () => {
    const pty = runInteractive()
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      // Bracketed paste with \n instead of \r
      pty.write('\x1b[200~echo "BP_NEWLINE_TEST"\x1b[201~\n')
      await pty.waitForOutput('BP_NEWLINE_TEST', 5000)
      expect(pty.getOutput()).toContain('BP_NEWLINE_TEST')
    } finally {
      pty.destroy()
    }
  })

  it('bracketed paste into node readline — single write with \\r', async () => {
    // Simulates Claude Code: a Node.js program using readline
    const dir = makeTempDir()
    writeFileSync(join(dir, 'rl.js'), `
const rl = require('readline');
const i = rl.createInterface({ input: process.stdin, output: process.stdout });
i.question('INPUT> ', (answer) => { console.log('GOT:' + answer + ':'); i.close(); });
`)
    const pty = runInteractive({ cwd: dir })
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      pty.write('node rl.js\r')
      await pty.waitForOutput('INPUT>', 5000)
      // Send bracketed paste + \r in single write
      pty.write('\x1b[200~hello_bp_cr\x1b[201~\r')
      await pty.waitForOutput('GOT:hello_bp_cr:', 5000)
    } finally {
      pty.destroy()
    }
  }, 15000)

  it('plain text + \\r into node readline works', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'rl.js'), `
const rl = require('readline');
const i = rl.createInterface({ input: process.stdin, output: process.stdout });
i.question('INPUT> ', (answer) => { console.log('GOT:' + answer + ':'); i.close(); });
`)
    const pty = runInteractive({ cwd: dir })
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      pty.write('node rl.js\r')
      await pty.waitForOutput('INPUT>', 5000)
      // Plain text + \r (no bracketed paste)
      pty.write('hello_plain_cr\r')
      await pty.waitForOutput('GOT:hello_plain_cr:', 5000)
    } finally {
      pty.destroy()
    }
  }, 15000)

  it('plain text + \\n into node readline works', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'rl.js'), `
const rl = require('readline');
const i = rl.createInterface({ input: process.stdin, output: process.stdout });
i.question('INPUT> ', (answer) => { console.log('GOT:' + answer + ':'); i.close(); });
`)
    const pty = runInteractive({ cwd: dir })
    try {
      await pty.waitForOutput(/[\$%#>]/, 5000)
      pty.write('node rl.js\r')
      await pty.waitForOutput('INPUT>', 5000)
      // Plain text + \n
      pty.write('hello_plain_nl\n')
      await pty.waitForOutput('GOT:hello_plain_nl:', 5000)
    } finally {
      pty.destroy()
    }
  }, 15000)
})
