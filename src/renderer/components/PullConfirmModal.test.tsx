import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PullConfirmModal } from './PullConfirmModal'

describe('PullConfirmModal', () => {
  it('offers stash and discard when tracked files changed', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <PullConfirmModal
        folderName="wix-astronomer-dags"
        baseBranch="master"
        changes={{ tracked: ['CLAUDE.md'], untracked: [] }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText(/Tracked changes \(1\)/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Stash & pull/i }))
    expect(onConfirm).toHaveBeenCalledWith({
      action: 'pull',
      localChanges: 'stash',
      stashUntracked: false,
    })
  })

  it('asks to continue when only untracked files exist', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <PullConfirmModal
        folderName="my-repo"
        baseBranch="main"
        changes={{ tracked: [], untracked: ['.octocode/'] }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Continue pull/i }))
    expect(onConfirm).toHaveBeenCalledWith({ action: 'pull' })
  })
})
