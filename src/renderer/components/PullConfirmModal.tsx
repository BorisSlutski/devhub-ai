import React, { useState } from 'react'
import type { GitPullLocalChanges, GitWorkingTreeChanges } from '../../shared/ipc-types'

export type PullConfirmChoice =
  | { action: 'cancel' }
  | { action: 'pull' }
  | { action: 'pull'; localChanges: GitPullLocalChanges; stashUntracked?: boolean }

interface Props {
  folderName: string
  baseBranch: string | null
  changes: GitWorkingTreeChanges
  onConfirm: (choice: PullConfirmChoice) => void
  onClose: () => void
}

const MAX_LIST = 8

function FileList({ paths, label }: { paths: string[]; label: string }) {
  if (paths.length === 0) return null
  const shown = paths.slice(0, MAX_LIST)
  const more = paths.length - shown.length
  return (
    <div className="pull-confirm-file-group">
      <div className="pull-confirm-file-label">{label}</div>
      <ul className="pull-confirm-file-list">
        {shown.map((p) => (
          <li key={p} title={p}>
            {p}
          </li>
        ))}
        {more > 0 && <li className="pull-confirm-more">…and {more} more</li>}
      </ul>
    </div>
  )
}

export function PullConfirmModal({
  folderName,
  baseBranch,
  changes,
  onConfirm,
  onClose,
}: Props) {
  const hasTracked = changes.tracked.length > 0
  const hasUntracked = changes.untracked.length > 0
  const [stashUntracked, setStashUntracked] = useState(false)

  const baseLabel = baseBranch ? `origin/${baseBranch}` : 'main/master'

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal pull-confirm-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="pull-confirm-title"
      >
        <h2 id="pull-confirm-title">Pull {folderName}?</h2>
        <p className="pull-confirm-lead">
          {hasTracked
            ? `Local changes must be handled before checking out ${baseLabel} and pulling.`
            : `This repo has untracked files. Pull will update tracked branches; untracked files are left as-is.`}
        </p>

        <FileList
          paths={changes.tracked}
          label={`Tracked changes (${changes.tracked.length})`}
        />
        <FileList
          paths={changes.untracked}
          label={`Untracked (${changes.untracked.length})`}
        />

        {hasTracked && hasUntracked && (
          <label className="pull-confirm-checkbox">
            <input
              type="checkbox"
              checked={stashUntracked}
              onChange={(e) => setStashUntracked(e.target.checked)}
            />
            Also stash untracked files when stashing
          </label>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onConfirm({ action: 'cancel' })}>
            Cancel
          </button>
          {hasTracked ? (
            <>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => onConfirm({ action: 'pull', localChanges: 'discard' })}
              >
                Discard tracked changes & pull
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  onConfirm({
                    action: 'pull',
                    localChanges: 'stash',
                    stashUntracked: stashUntracked && hasUntracked,
                  })
                }
              >
                Stash & pull
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onConfirm({ action: 'pull' })}
            >
              Continue pull
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
