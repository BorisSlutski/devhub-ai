import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { Project } from '../shared/types'
import { randomUUID } from 'crypto'

interface PackageJson {
  name?: string
  description?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  yoshi?: { servers?: { cdn?: { port?: number } }; bundle?: { port?: number } }
}

function safeRead(filePath: string): string | null {
  try {
    if (existsSync(filePath)) return readFileSync(filePath, 'utf-8')
  } catch { /* ignore */ }
  return null
}

function detectTechStack(pkgJson: PackageJson | null, projectPath: string): string[] {
  const stack: string[] = []

  // Check for Python projects
  const hasPythonFiles = existsSync(join(projectPath, 'requirements.txt')) ||
                         existsSync(join(projectPath, 'pyproject.toml')) ||
                         existsSync(join(projectPath, 'Pipfile'))
  if (hasPythonFiles) {
    stack.push('Python')
    const reqContent = safeRead(join(projectPath, 'requirements.txt')) || ''
    const pyprojectContent = safeRead(join(projectPath, 'pyproject.toml')) || ''
    const allPy = reqContent + pyprojectContent
    if (allPy.includes('flask')) stack.push('Flask')
    if (allPy.includes('fastapi')) stack.push('FastAPI')
    if (allPy.includes('django')) stack.push('Django')
    if (allPy.includes('streamlit')) stack.push('Streamlit')
  }

  // JVM projects
  if (existsSync(join(projectPath, 'build.sbt'))) {
    stack.push('Scala', 'sbt')
    const sbtContent = safeRead(join(projectPath, 'build.sbt')) || ''
    if (sbtContent.includes('akka')) stack.push('Akka')
    if (sbtContent.includes('play')) stack.push('Play')
    if (sbtContent.includes('http4s')) stack.push('http4s')
    if (sbtContent.includes('zio')) stack.push('ZIO')
  }
  if (existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts'))) {
    const gradleContent = safeRead(join(projectPath, 'build.gradle')) || safeRead(join(projectPath, 'build.gradle.kts')) || ''
    if (gradleContent.includes('kotlin')) stack.push('Kotlin')
    else stack.push('Java')
    stack.push('Gradle')
    if (gradleContent.includes('spring')) stack.push('Spring')
  }
  if (existsSync(join(projectPath, 'pom.xml'))) {
    stack.push('Java', 'Maven')
    const pomContent = safeRead(join(projectPath, 'pom.xml')) || ''
    if (pomContent.includes('spring')) stack.push('Spring')
  }

  // Go projects
  if (existsSync(join(projectPath, 'go.mod'))) {
    stack.push('Go')
    const goMod = safeRead(join(projectPath, 'go.mod')) || ''
    if (goMod.includes('gin-gonic')) stack.push('Gin')
    if (goMod.includes('fiber')) stack.push('Fiber')
    if (goMod.includes('echo')) stack.push('Echo')
  }

  // Rust projects
  if (existsSync(join(projectPath, 'Cargo.toml'))) {
    stack.push('Rust')
    const cargoContent = safeRead(join(projectPath, 'Cargo.toml')) || ''
    if (cargoContent.includes('actix')) stack.push('Actix')
    if (cargoContent.includes('axum')) stack.push('Axum')
    if (cargoContent.includes('rocket')) stack.push('Rocket')
  }

  // Ruby projects
  if (existsSync(join(projectPath, 'Gemfile'))) {
    stack.push('Ruby')
    const gemfile = safeRead(join(projectPath, 'Gemfile')) || ''
    if (gemfile.includes('rails')) stack.push('Rails')
    if (gemfile.includes('sinatra')) stack.push('Sinatra')
  }

  if (!pkgJson) {
    if (existsSync(join(projectPath, 'docker-compose.yml')) || existsSync(join(projectPath, 'docker-compose.yaml'))) {
      stack.push('Docker')
    }
    return stack.length > 0 ? [...new Set(stack)] : []
  }

  const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies }

  if (allDeps['react']) stack.push('React')
  if (allDeps['next']) stack.push('Next.js')
  if (allDeps['vue']) stack.push('Vue')
  if (allDeps['svelte']) stack.push('Svelte')
  if (allDeps['express']) stack.push('Express')
  if (allDeps['fastify']) stack.push('Fastify')
  if (allDeps['electron']) stack.push('Electron')
  if (allDeps['typescript']) stack.push('TypeScript')
  if (allDeps['vite']) stack.push('Vite')
  if (allDeps['webpack']) stack.push('Webpack')
  if (allDeps['tailwindcss']) stack.push('Tailwind')
  if (allDeps['prisma'] || allDeps['@prisma/client']) stack.push('Prisma')
  if (allDeps['mongoose'] || allDeps['mongodb']) stack.push('MongoDB')
  if (allDeps['pg'] || allDeps['postgres']) stack.push('PostgreSQL')
  if (allDeps['yoshi'] || allDeps['yoshi-flow-library'] || allDeps['yoshi-flow-bm']) stack.push('Yoshi')

  if (existsSync(join(projectPath, 'docker-compose.yml')) || existsSync(join(projectPath, 'docker-compose.yaml'))) {
    stack.push('Docker')
  }
  if (existsSync(join(projectPath, 'Dockerfile'))) {
    stack.push('Docker')
  }

  if (stack.length === 0) stack.push('Node.js')

  return [...new Set(stack)]
}

function detectRunCommand(pkgJson: PackageJson | null, projectPath: string): string {
  // Check for Python entry points - first known names, then scan all .py files
  const knownPyFiles = ['main.py', 'app.py', 'server.py', 'run.py']
  const allPyFiles = [...knownPyFiles]

  // Also scan root for any .py files that could be entry points
  try {
    for (const file of readdirSync(projectPath)) {
      if (file.endsWith('.py') && !allPyFiles.includes(file)) {
        allPyFiles.push(file)
      }
    }
  } catch { /* ignore */ }

  for (const pyFile of allPyFiles) {
    if (!existsSync(join(projectPath, pyFile))) continue
    const content = safeRead(join(projectPath, pyFile)) || ''

    // Check if this file has a __main__ block or is a runnable script
    const isRunnable = content.includes('__main__') ||
                       content.includes('flask') || content.includes('Flask') ||
                       content.includes('fastapi') || content.includes('FastAPI') ||
                       content.includes('streamlit') ||
                       content.includes('.run(') ||
                       content.includes('app.listen') ||
                       content.includes('uvicorn')

    if (!isRunnable) continue

    if (content.includes('streamlit')) {
      return `streamlit run ${pyFile}`
    }
    if (content.includes('uvicorn')) {
      const uvicornMatch = content.match(/uvicorn\.run\(\s*["']([^"']+)["']/)
      if (uvicornMatch) return `uvicorn ${uvicornMatch[1]} --reload`
      return `python3 ${pyFile}`
    }
    return `python3 ${pyFile}`
  }

  // Node.js / JavaScript projects
  if (pkgJson?.scripts) {
    const scripts = pkgJson.scripts
    if (scripts['dev']) return 'npm run dev'
    if (scripts['start:dev']) return 'npm run start:dev'
    if (scripts['develop']) return 'npm run develop'
    if (scripts['serve']) return 'npm run serve'
    if (scripts['start']) return 'npm start'
    if (scripts['watch']) return 'npm run watch'
  }

  // Scala / sbt projects
  if (existsSync(join(projectPath, 'build.sbt'))) {
    return 'sbt run'
  }

  // Gradle projects (Kotlin or Groovy)
  if (existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts'))) {
    const gradleContent = safeRead(join(projectPath, 'build.gradle')) || safeRead(join(projectPath, 'build.gradle.kts')) || ''
    if (gradleContent.includes('application')) return './gradlew run'
    if (gradleContent.includes('spring')) return './gradlew bootRun'
    return './gradlew run'
  }

  // Maven projects
  if (existsSync(join(projectPath, 'pom.xml'))) {
    const pomContent = safeRead(join(projectPath, 'pom.xml')) || ''
    if (pomContent.includes('spring-boot')) return 'mvn spring-boot:run'
    return 'mvn exec:java'
  }

  // Go projects
  if (existsSync(join(projectPath, 'go.mod'))) {
    if (existsSync(join(projectPath, 'main.go'))) return 'go run main.go'
    if (existsSync(join(projectPath, 'cmd'))) {
      try {
        const cmds = readdirSync(join(projectPath, 'cmd'))
        if (cmds.length > 0) return `go run ./cmd/${cmds[0]}`
      } catch { /* ignore */ }
    }
    return 'go run .'
  }

  // Rust projects
  if (existsSync(join(projectPath, 'Cargo.toml'))) {
    return 'cargo run'
  }

  // Ruby projects
  if (existsSync(join(projectPath, 'Gemfile'))) {
    if (existsSync(join(projectPath, 'config.ru'))) return 'bundle exec rackup'
    if (existsSync(join(projectPath, 'bin', 'rails'))) return 'bundle exec rails server'
  }

  return ''
}

function detectPort(pkgJson: PackageJson | null, projectPath: string): number | null {
  // 1. Check vite.config.ts/js for server.port
  const viteConfigs = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']
  for (const configName of viteConfigs) {
    const content = safeRead(join(projectPath, configName))
    if (content) {
      const portMatch = content.match(/server\s*:\s*\{[^}]*port\s*:\s*(\d{3,5})/)
      if (portMatch) return parseInt(portMatch[1])
    }
  }

  // Also check vite configs in packages/* (monorepos)
  const packagesDir = join(projectPath, 'packages')
  if (existsSync(packagesDir)) {
    try {
      for (const pkg of readdirSync(packagesDir)) {
        const pkgPath = join(packagesDir, pkg)
        if (!statSync(pkgPath).isDirectory()) continue
        for (const configName of viteConfigs) {
          const content = safeRead(join(pkgPath, configName))
          if (content) {
            const portMatch = content.match(/server\s*:\s*\{[^}]*port\s*:\s*(\d{3,5})/)
            if (portMatch) return parseInt(portMatch[1])
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Check Express/Node server files for hardcoded ports
  const serverFiles = ['server.js', 'server.ts', 'index.js', 'index.ts', 'app.js', 'app.ts']
  for (const serverFile of serverFiles) {
    const content = safeRead(join(projectPath, serverFile))
    if (content) {
      // Match patterns like: const PORT = 3456, port = 8080, .listen(3000)
      const patterns = [
        /(?:PORT|port)\s*=\s*(\d{3,5})/,
        /\.listen\(\s*(\d{3,5})/
      ]
      for (const pattern of patterns) {
        const match = content.match(pattern)
        if (match) return parseInt(match[1])
      }
    }
  }

  // 3. Check Python files for Flask/FastAPI ports
  const pythonFiles = ['main.py', 'app.py', 'server.py', 'run.py']
  for (const pyFile of pythonFiles) {
    const content = safeRead(join(projectPath, pyFile))
    if (content) {
      // Match: LOCAL_PORT = 5555, port=8000, .run(port=5000)
      const patterns = [
        /(?:PORT|port|LOCAL_PORT)\s*=\s*(\d{3,5})/,
        /\.run\([^)]*port\s*=\s*(\d{3,5})/,
        /uvicorn\.run\([^)]*port\s*=\s*(\d{3,5})/
      ]
      for (const pattern of patterns) {
        const match = content.match(pattern)
        if (match) return parseInt(match[1])
      }
    }
  }
  // Also check any *_*.py files in root (e.g. pmm_investigator.py)
  try {
    for (const file of readdirSync(projectPath)) {
      if (file.endsWith('.py') && !pythonFiles.includes(file)) {
        const content = safeRead(join(projectPath, file))
        if (content) {
          const match = content.match(/(?:PORT|port|LOCAL_PORT)\s*=\s*(\d{3,5})/)
          if (match) return parseInt(match[1])
        }
      }
    }
  } catch { /* ignore */ }

  // 4. Check Yoshi config in package.json (Wix projects)
  if (pkgJson?.yoshi) {
    const yoshiPort = pkgJson.yoshi.servers?.cdn?.port || pkgJson.yoshi.bundle?.port
    if (yoshiPort) return yoshiPort
  }
  // Also check nested package.json in packages/* for Yoshi port (monorepos)
  if (existsSync(packagesDir)) {
    try {
      for (const pkg of readdirSync(packagesDir)) {
        const nestedPkgPath = join(packagesDir, pkg, 'package.json')
        const content = safeRead(nestedPkgPath)
        if (content) {
          try {
            const nestedPkg = JSON.parse(content)
            const yoshiPort = nestedPkg.yoshi?.servers?.cdn?.port || nestedPkg.yoshi?.bundle?.port
            if (yoshiPort) return yoshiPort
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // 5. Check package.json scripts for PORT= or --port flags
  if (pkgJson?.scripts) {
    const allScripts = Object.values(pkgJson.scripts).join(' ')
    const portMatch = allScripts.match(/(?:PORT=|--port[= ])(\d{3,5})/)
    if (portMatch) return parseInt(portMatch[1])
  }

  // 6. Check .env and .env.local files
  for (const envFile of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    const content = safeRead(join(projectPath, envFile))
    if (content) {
      const match = content.match(/^PORT=(\d{3,5})/m)
      if (match) return parseInt(match[1])
    }
  }

  // 7. Check next.config for custom port
  for (const nextConfig of ['next.config.js', 'next.config.ts', 'next.config.mjs']) {
    const content = safeRead(join(projectPath, nextConfig))
    if (content) {
      const match = content.match(/port\s*:\s*(\d{3,5})/)
      if (match) return parseInt(match[1])
    }
  }

  // 8. Framework defaults (only if we know the framework)
  if (pkgJson) {
    const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies }
    if (allDeps['next']) return 3000
    if (allDeps['react-scripts']) return 3000
    if (allDeps['vite']) return 5173
    if (allDeps['express']) return 3000
  }

  return null
}

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '__pycache__', 'vendor', 'target', '.next', '.nuxt',
  'bazel-out', 'bazel-bin', 'bazel-testlogs', 'bazel-genfiles',  // Bazel build outputs
  '.cache', '.tmp', '.idea', '.vscode',                           // IDE / cache dirs
  'out', '.gradle', '.m2', '.sbt',                                // Build tool caches
])

const DEFAULT_MAX_DEPTH = 3

function isProjectDir(dirPath: string): { isProject: boolean; pkgJson: PackageJson | null } {
  let pkgJson: PackageJson | null = null
  const pkgPath = join(dirPath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    } catch { /* ignore */ }
  }

  const hasDockerCompose = existsSync(join(dirPath, 'docker-compose.yml')) ||
                           existsSync(join(dirPath, 'docker-compose.yaml'))
  const hasMakefile = existsSync(join(dirPath, 'Makefile'))
  const hasPython = existsSync(join(dirPath, 'requirements.txt')) ||
                    existsSync(join(dirPath, 'pyproject.toml')) ||
                    existsSync(join(dirPath, 'Pipfile'))
  const hasSbt = existsSync(join(dirPath, 'build.sbt'))
  const hasGradle = existsSync(join(dirPath, 'build.gradle')) ||
                    existsSync(join(dirPath, 'build.gradle.kts'))
  const hasMaven = existsSync(join(dirPath, 'pom.xml'))
  const hasGo = existsSync(join(dirPath, 'go.mod'))
  const hasRust = existsSync(join(dirPath, 'Cargo.toml'))
  const hasRuby = existsSync(join(dirPath, 'Gemfile'))

  const isProject = !!(pkgJson || hasDockerCompose || hasMakefile || hasPython ||
                       hasSbt || hasGradle || hasMaven || hasGo || hasRust || hasRuby)

  return { isProject, pkgJson }
}

let _scanDirsVisited = 0
let _scanLastLog = 0

/** Yield the main-process event loop every N directories so UI stays responsive. */
const SCAN_YIELD_EVERY = 48

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function scanRecursiveAsync(
  dirPath: string,
  depth: number,
  maxDepth: number,
  projects: Project[],
): Promise<void> {
  if (depth > maxDepth) return

  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return
  }

  _scanDirsVisited++
  if (_scanDirsVisited - _scanLastLog >= 500) {
    console.log(`[scanner] progress: ${_scanDirsVisited} dirs visited, ${projects.length} projects found, depth=${depth}, current: ${dirPath}`)
    _scanLastLog = _scanDirsVisited
  }
  if (_scanDirsVisited % SCAN_YIELD_EVERY === 0) {
    await yieldEventLoop()
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry)
    try {
      if (!statSync(fullPath).isDirectory()) continue
    } catch {
      continue
    }

    if (entry.startsWith('.') || entry.startsWith('bazel-') || SKIP_DIRS.has(entry)) continue

    const { isProject, pkgJson } = isProjectDir(fullPath)

    if (isProject) {
      const hasDockerCompose = existsSync(join(fullPath, 'docker-compose.yml')) ||
                               existsSync(join(fullPath, 'docker-compose.yaml'))
      const hasMakefile = existsSync(join(fullPath, 'Makefile'))

      let runCommand = detectRunCommand(pkgJson, fullPath)
      if (!runCommand && hasDockerCompose) runCommand = 'docker-compose up'
      if (!runCommand && hasMakefile) runCommand = 'make'

      projects.push({
        id: randomUUID(),
        name: pkgJson?.name || entry,
        path: fullPath,
        tags: [],
        description: pkgJson?.description || '',
        techStack: detectTechStack(pkgJson, fullPath),
        runCommand,
        port: detectPort(pkgJson, fullPath),
        lastOpened: null,
        hidden: false
      })
    } else {
      await scanRecursiveAsync(fullPath, depth + 1, maxDepth, projects)
    }
  }
}

function scanRecursive(dirPath: string, depth: number, maxDepth: number, projects: Project[]): void {
  if (depth > maxDepth) return

  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return
  }

  _scanDirsVisited++
  // Log progress every 500 dirs so we can see if/where it's slow
  if (_scanDirsVisited - _scanLastLog >= 500) {
    console.log(`[scanner] progress: ${_scanDirsVisited} dirs visited, ${projects.length} projects found, depth=${depth}, current: ${dirPath}`)
    _scanLastLog = _scanDirsVisited
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry)
    try {
      if (!statSync(fullPath).isDirectory()) continue
    } catch {
      continue
    }

    if (entry.startsWith('.') || entry.startsWith('bazel-') || SKIP_DIRS.has(entry)) continue

    const { isProject, pkgJson } = isProjectDir(fullPath)

    if (isProject) {
      const hasDockerCompose = existsSync(join(fullPath, 'docker-compose.yml')) ||
                               existsSync(join(fullPath, 'docker-compose.yaml'))
      const hasMakefile = existsSync(join(fullPath, 'Makefile'))

      let runCommand = detectRunCommand(pkgJson, fullPath)
      if (!runCommand && hasDockerCompose) runCommand = 'docker-compose up'
      if (!runCommand && hasMakefile) runCommand = 'make'

      projects.push({
        id: randomUUID(),
        name: pkgJson?.name || entry,
        path: fullPath,
        tags: [],
        description: pkgJson?.description || '',
        techStack: detectTechStack(pkgJson, fullPath),
        runCommand,
        port: detectPort(pkgJson, fullPath),
        lastOpened: null,
        hidden: false
      })
    } else {
      scanRecursive(fullPath, depth + 1, maxDepth, projects)
    }
  }
}

export function scanWorkspace(scanPath: string, maxDepth: number = DEFAULT_MAX_DEPTH): Project[] {
  console.log('[scanner] scanWorkspace called — path:', scanPath, 'maxDepth:', maxDepth)
  _scanDirsVisited = 0
  _scanLastLog = 0
  const t0 = Date.now()
  const projects: Project[] = []
  scanRecursive(scanPath, 0, maxDepth, projects)
  console.log(`[scanner] scanWorkspace DONE — ${projects.length} projects, ${_scanDirsVisited} dirs visited, ${Date.now() - t0}ms`)
  return projects.sort((a, b) => a.name.localeCompare(b.name))
}

/** Non-blocking workspace scan — yields to the event loop during traversal. */
export async function scanWorkspaceAsync(
  scanPath: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<Project[]> {
  console.log('[scanner] scanWorkspaceAsync called — path:', scanPath, 'maxDepth:', maxDepth)
  _scanDirsVisited = 0
  _scanLastLog = 0
  const t0 = Date.now()
  const projects: Project[] = []
  await scanRecursiveAsync(scanPath, 0, maxDepth, projects)
  console.log(`[scanner] scanWorkspaceAsync DONE — ${projects.length} projects, ${_scanDirsVisited} dirs visited, ${Date.now() - t0}ms`)
  return projects.sort((a, b) => a.name.localeCompare(b.name))
}
