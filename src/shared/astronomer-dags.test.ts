import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import {
  isAstronomerDagsRepo,
  findAstronomerDagsRoot,
  discoverLocalAirflowPort,
} from './astronomer-dags'

describe('astronomer-dags', () => {
  const root = join(tmpdir(), `devhub-ai-astro-test-${Date.now()}`)

  it('detects repo by astronomer-local layout', () => {
    mkdirSync(join(root, 'astronomer-local'), { recursive: true })
    writeFileSync(join(root, 'astronomer-local', 'project.toml'), '')
    mkdirSync(join(root, 'premium'), { recursive: true })
    expect(isAstronomerDagsRepo(root)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('finds nested wix-astronomer-dags folder', () => {
    const parent = join(tmpdir(), `devhub-ai-astro-parent-${Date.now()}`)
    const repo = join(parent, 'wix-astronomer-dags')
    mkdirSync(join(repo, 'astronomer-local'), { recursive: true })
    writeFileSync(join(repo, 'astronomer-local', 'Dockerfile'), '')
    expect(findAstronomerDagsRoot(parent)).toBe(repo)
    rmSync(parent, { recursive: true, force: true })
  })

  it('reads UI port from docker-compose.override.yml', () => {
    const repo = join(tmpdir(), `devhub-ai-astro-port-${Date.now()}`)
    mkdirSync(join(repo, 'astronomer-local'), { recursive: true })
    writeFileSync(
      join(repo, 'astronomer-local', 'docker-compose.override.yml'),
      'ports:\n  - "8083:8080"\n',
    )
    expect(discoverLocalAirflowPort(repo)).toBe(8083)
    rmSync(repo, { recursive: true, force: true })
  })
})
