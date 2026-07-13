import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'

const defaultProps = {
  currentPath: '/path',
  currentScanDepth: 50,
  rtkEnabled: false,
  dangerousMode: false,
  chatInputEnabled: false,
  defaultModel: '',
  onSave: vi.fn(),
  onClose: vi.fn(),
}

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.mocked(window.api.selectFolder).mockResolvedValue(null)
    vi.mocked(window.api.rtkDetect).mockResolvedValue({ installed: false, version: null, hookActive: false, path: null })
    vi.mocked(window.api.rtkGain).mockResolvedValue(null)
    vi.mocked(window.api.enhancerGetConfig).mockResolvedValue({ enabled: false, apiKey: '', model: 'gpt-4.1-nano', baseUrl: '' })
    vi.mocked(window.api.enhancerGetTotalCost).mockResolvedValue({ totalUsd: 0, calls: 0 })
  })

  it('renders with current path in input', () => {
    render(
      <SettingsModal
        currentPath="/Users/test/workspace"
        currentScanDepth={50}
        rtkEnabled={false}
        dangerousMode={false}
        chatInputEnabled={false}
        defaultModel=""
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    )
    const input = screen.getByDisplayValue('/Users/test/workspace')
    expect(input).toBeInTheDocument()
  })

  it('browse button calls window.api.selectFolder', async () => {
    render(<SettingsModal {...defaultProps} />)
    fireEvent.click(screen.getByText('Browse'))
    expect(window.api.selectFolder).toHaveBeenCalledTimes(1)
  })

  it('updates input when folder is selected', async () => {
    vi.mocked(window.api.selectFolder).mockResolvedValue('/Users/new/folder')
    render(<SettingsModal {...defaultProps} />)
    fireEvent.click(screen.getByText('Browse'))
    expect(await screen.findByDisplayValue('/Users/new/folder')).toBeInTheDocument()
  })

  it('save button calls onSave with path, rtk and dangerousMode', () => {
    const onSave = vi.fn()
    render(<SettingsModal {...defaultProps} onSave={onSave} />)
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith('/path', 50, false, false, false, '', false)
  })

  it('cancel button calls onClose', () => {
    const onClose = vi.fn()
    render(<SettingsModal {...defaultProps} onClose={onClose} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking overlay calls onClose', () => {
    const onClose = vi.fn()
    render(<SettingsModal {...defaultProps} onClose={onClose} />)
    const overlay = document.querySelector('.modal-overlay')
    if (overlay) fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })

  it('shows Dangerous Mode OFF badge when dangerousMode is false', () => {
    render(<SettingsModal {...defaultProps} dangerousMode={false} />)
    const offBadges = screen.getAllByText('OFF')
    expect(offBadges.length).toBeGreaterThanOrEqual(1)
  })

  it('shows Dangerous Mode ON badge when dangerousMode is true', () => {
    render(<SettingsModal {...defaultProps} dangerousMode={true} />)
    const onBadges = screen.getAllByText('ON')
    expect(onBadges.length).toBeGreaterThanOrEqual(1)
  })

  /** Enhancer/RTK sections also have Enable/Disable — Dangerous Mode is last in the modal */
  const getDangerousModeEnableButton = () => {
    const buttons = screen.getAllByRole('button', { name: 'Enable' })
    return buttons[buttons.length - 1]
  }

  const getDangerousModeDisableButton = () => {
    const buttons = screen.getAllByRole('button', { name: 'Disable' })
    return buttons[buttons.length - 1]
  }

  it('clicking Enable shows confirmation dialog', () => {
    render(<SettingsModal {...defaultProps} dangerousMode={false} />)
    fireEvent.click(getDangerousModeEnableButton())
    expect(screen.getByTestId('dangerous-confirm-input')).toBeInTheDocument()
  })

  it('confirmation input must match exactly to enable Confirm button', () => {
    render(<SettingsModal {...defaultProps} dangerousMode={false} />)
    fireEvent.click(getDangerousModeEnableButton())
    const input = screen.getByTestId('dangerous-confirm-input')
    fireEvent.change(input, { target: { value: 'wrong text' } })
    const confirmBtn = screen.getByText('Confirm')
    expect(confirmBtn).toBeDisabled()
  })

  it('typing correct confirmation and clicking Confirm enables dangerous mode', () => {
    render(<SettingsModal {...defaultProps} dangerousMode={false} />)
    fireEvent.click(getDangerousModeEnableButton())
    const input = screen.getByTestId('dangerous-confirm-input')
    fireEvent.change(input, { target: { value: 'I understand the risks' } })
    fireEvent.click(screen.getByText('Confirm'))
    expect(screen.getAllByText('ON').length).toBeGreaterThanOrEqual(1)
  })

  it('clicking Cancel in confirmation dialog hides it', () => {
    render(<SettingsModal {...defaultProps} dangerousMode={false} />)
    fireEvent.click(getDangerousModeEnableButton())
    expect(screen.getByTestId('dangerous-confirm-input')).toBeInTheDocument()
    const cancelButtons = screen.getAllByText('Cancel')
    fireEvent.click(cancelButtons[0])
    expect(screen.queryByTestId('dangerous-confirm-input')).not.toBeInTheDocument()
  })

  it('clicking Disable when dangerous mode is on disables it immediately', () => {
    render(<SettingsModal {...defaultProps} dangerousMode={true} />)
    expect(screen.getAllByText('ON').length).toBeGreaterThanOrEqual(1)
    fireEvent.click(getDangerousModeDisableButton())
    const offBadges = screen.getAllByText('OFF')
    expect(offBadges.length).toBeGreaterThanOrEqual(2)
  })

  it('save passes dangerousMode=true after enabling', () => {
    const onSave = vi.fn()
    render(<SettingsModal {...defaultProps} onSave={onSave} dangerousMode={false} />)
    fireEvent.click(getDangerousModeEnableButton())
    const input = screen.getByTestId('dangerous-confirm-input')
    fireEvent.change(input, { target: { value: 'I understand the risks' } })
    fireEvent.click(screen.getByText('Confirm'))
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith('/path', 50, false, true, false, '', false)
  })

  it('confirmation text is case-sensitive', () => {
    render(<SettingsModal {...defaultProps} dangerousMode={false} />)
    fireEvent.click(getDangerousModeEnableButton())
    const input = screen.getByTestId('dangerous-confirm-input')
    fireEvent.change(input, { target: { value: 'i understand the risks' } })
    const confirmBtn = screen.getByText('Confirm')
    expect(confirmBtn).toBeDisabled()
  })
})
