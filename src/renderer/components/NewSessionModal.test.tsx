import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewSessionModal } from './NewSessionModal'
import type { WorkspaceFolder } from '../../shared/types'

const mockFolders: WorkspaceFolder[] = [
  { name: 'project-a', path: '/Users/test/project-a', modifiedAt: '', gitBranch: null, gitRemote: null },
  { name: 'project-b', path: '/Users/test/project-b', modifiedAt: '', gitBranch: null, gitRemote: null },
]

describe('NewSessionModal', () => {
  beforeEach(() => {
    vi.mocked(window.api.listWorkspaceFolders).mockResolvedValue(mockFolders)
  })

  it('renders modal title "New Claude Session"', async () => {
    render(<NewSessionModal scanPath="/tmp" onStart={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('New Claude Session')).toBeInTheDocument()
    await screen.findByText('project-a')
  })

  it('shows loading state initially', () => {
    vi.mocked(window.api.listWorkspaceFolders).mockImplementation(() => new Promise(() => {}))
    render(<NewSessionModal scanPath="/tmp" onStart={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('renders folder list after loading', async () => {
    render(<NewSessionModal scanPath="/tmp" onStart={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText('project-a')).toBeInTheDocument()
    expect(screen.getByText('project-b')).toBeInTheDocument()
  })

  it('search input filters folders', async () => {
    render(<NewSessionModal scanPath="/tmp" onStart={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('project-a')
    const searchInput = screen.getByPlaceholderText('Filter folders...')
    fireEvent.change(searchInput, { target: { value: 'project-a' } })
    expect(screen.getByText('project-a')).toBeInTheDocument()
    expect(screen.queryByText('project-b')).not.toBeInTheDocument()
  })

  it('worktree checkbox is unchecked by default', async () => {
    render(<NewSessionModal scanPath="/tmp" onStart={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('project-a')
    const checkbox = screen.getByRole('checkbox', { name: /Create git worktree/ })
    expect(checkbox).not.toBeChecked()
  })

  it('clicking a folder calls onStart with the folder and useWorktree value', async () => {
    const onStart = vi.fn()
    render(<NewSessionModal scanPath="/tmp" onStart={onStart} onClose={vi.fn()} />)
    const folderA = await screen.findByText('project-a')
    fireEvent.click(folderA)
    expect(onStart).toHaveBeenCalledWith(mockFolders[0], false)
  })

  it('close button calls onClose', async () => {
    const onClose = vi.fn()
    render(<NewSessionModal scanPath="/tmp" onStart={vi.fn()} onClose={onClose} />)
    await screen.findByText('project-a')
    const closeBtn = screen.getByRole('button', { name: 'x' })
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
