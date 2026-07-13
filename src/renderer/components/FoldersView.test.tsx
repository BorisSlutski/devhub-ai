import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FoldersView } from './FoldersView'

class MockIntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: ReadonlyArray<number> = []
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
  unobserve() {}
  disconnect() {}
}

describe('FoldersView', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    vi.mocked(window.api.listWorkspaceFolders).mockResolvedValue([
      {
        name: 'my-repo',
        path: '/tmp/my-repo',
        modifiedAt: new Date().toISOString(),
        gitBranch: null,
        gitRemote: null,
      },
    ])
    vi.mocked(window.api.getFolderGitMeta).mockResolvedValue({
      gitBranch: 'main',
      gitRemote: 'https://github.com/org/my-repo',
      isGitRepo: true,
      baseBranch: 'main',
      currentBranch: 'main',
      commitsBehind: 3,
      commitsAhead: 0,
      uncommitted: 0,
      state: 'behind',
    })
  })

  it('renders table headers and sync badge after git load', async () => {
    render(<FoldersView scanPath="/tmp" />)

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: 'Folder' })).toBeInTheDocument()
    })
    expect(screen.getByRole('columnheader', { name: 'Sync' })).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('3 behind')).toBeInTheDocument()
    })
  })

  it('sorts favorites first when ordering by name', async () => {
    vi.mocked(window.api.listWorkspaceFolders).mockResolvedValue([
      {
        name: 'zebra',
        path: '/tmp/zebra',
        modifiedAt: new Date().toISOString(),
        gitBranch: null,
        gitRemote: null,
      },
      {
        name: 'alpha',
        path: '/tmp/alpha',
        modifiedAt: new Date().toISOString(),
        gitBranch: null,
        gitRemote: null,
      },
    ])

    render(
      <FoldersView
        scanPath="/tmp"
        favoriteFolderPaths={['/tmp/zebra']}
        foldersSortBy="name"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('zebra')).toBeInTheDocument()
    })

    const names = screen.getAllByText(/^(zebra|alpha)$/).map((el) => el.textContent)
    expect(names[0]).toBe('zebra')
    expect(names[1]).toBe('alpha')
  })

  it('toggles favorite via star button', async () => {
    const user = userEvent.setup()
    const onToggleFavorite = vi.fn()

    render(
      <FoldersView scanPath="/tmp" onToggleFavorite={onToggleFavorite} />,
    )

    await waitFor(() => {
      expect(screen.getByLabelText(/Favorite my-repo/i)).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText(/Favorite my-repo/i))
    expect(onToggleFavorite).toHaveBeenCalledWith('/tmp/my-repo')
  })

  it('shows only favorites when filter is on', async () => {
    const user = userEvent.setup()
    vi.mocked(window.api.listWorkspaceFolders).mockResolvedValue([
      {
        name: 'fav-repo',
        path: '/tmp/fav-repo',
        modifiedAt: new Date().toISOString(),
        gitBranch: null,
        gitRemote: null,
      },
      {
        name: 'other-repo',
        path: '/tmp/other-repo',
        modifiedAt: new Date().toISOString(),
        gitBranch: null,
        gitRemote: null,
      },
    ])

    render(
      <FoldersView
        scanPath="/tmp"
        favoriteFolderPaths={['/tmp/fav-repo']}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('fav-repo')).toBeInTheDocument()
      expect(screen.getByText('other-repo')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /Favorites/i }))

    expect(screen.getByText('fav-repo')).toBeInTheDocument()
    expect(screen.queryByText('other-repo')).not.toBeInTheDocument()
  })

  it('shows pull confirm modal when tracked files block pull', async () => {
    const user = userEvent.setup()
    vi.mocked(window.api.getFolderGitMeta).mockResolvedValue({
      gitBranch: 'master',
      gitRemote: 'https://github.com/org/my-repo',
      isGitRepo: true,
      baseBranch: 'master',
      currentBranch: 'master',
      commitsBehind: 68,
      commitsAhead: 0,
      uncommitted: 1,
      state: 'dirty',
    })
    vi.mocked(window.api.getFolderWorkingTree).mockResolvedValue({
      tracked: ['CLAUDE.md'],
      untracked: [],
    })

    render(<FoldersView scanPath="/tmp" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pull' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Pull' }))

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText(/CLAUDE.md/)).toBeInTheDocument()
    })
    expect(window.api.startPullFolderToBase).not.toHaveBeenCalled()
  })

  it('per-row refresh fetches git sync status', async () => {
    const user = userEvent.setup()
    render(<FoldersView scanPath="/tmp" />)

    await waitFor(() => {
      expect(screen.getByLabelText(/Refresh git status for my-repo/i)).toBeInTheDocument()
    })

    vi.mocked(window.api.getFolderGitMeta).mockClear()
    await user.click(screen.getByLabelText(/Refresh git status for my-repo/i))

    await waitFor(() => {
      expect(window.api.getFolderGitMeta).toHaveBeenCalledWith('/tmp/my-repo', true)
    })
  })
})
