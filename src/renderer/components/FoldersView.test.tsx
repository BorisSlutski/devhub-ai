import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FoldersView } from './FoldersView'

describe('FoldersView', () => {
  beforeEach(() => {
    vi.mocked(window.api.listWorkspaceFolders).mockResolvedValue([
      {
        name: 'my-repo',
        path: '/tmp/my-repo',
        modifiedAt: new Date().toISOString(),
        gitBranch: null,
        gitRemote: null,
      },
    ])
    vi.mocked(window.api.getGitInfo).mockResolvedValue({
      gitBranch: 'main',
      gitRemote: 'https://github.com/org/my-repo',
    })
    vi.mocked(window.api.getGitSyncStatus).mockResolvedValue({
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

  it('per-row refresh fetches git sync status', async () => {
    const user = userEvent.setup()
    render(<FoldersView scanPath="/tmp" />)

    await waitFor(() => {
      expect(screen.getByLabelText(/Refresh git status for my-repo/i)).toBeInTheDocument()
    })

    vi.mocked(window.api.getGitSyncStatus).mockClear()
    await user.click(screen.getByLabelText(/Refresh git status for my-repo/i))

    await waitFor(() => {
      expect(window.api.getGitSyncStatus).toHaveBeenCalledWith('/tmp/my-repo', true)
    })
  })
})
