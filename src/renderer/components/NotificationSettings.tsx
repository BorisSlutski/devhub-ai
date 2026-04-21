import React from 'react'
import { useNotifications } from '../hooks/useNotifications'

export function NotificationSettings() {
  const { enabled, quietMode, setEnabled, setQuietMode } = useNotifications()

  return (
    <div style={{
      marginBottom: 20,
      padding: 14,
      borderRadius: 8,
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            Desktop Notifications
          </label>
          <span style={{
            marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 4,
            background: enabled ? 'var(--green)' : 'var(--text-muted)',
            color: '#000', fontWeight: 600
          }}>
            {enabled ? 'ON' : 'OFF'}
          </span>
        </div>
        <button
          className={`btn btn-sm ${enabled ? 'btn-accent' : 'btn-primary'}`}
          onClick={() => setEnabled(!enabled)}
          style={{ minWidth: 80 }}
        >
          {enabled ? 'Disable' : 'Enable'}
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 10px' }}>
        Get notified when a Claude session finishes a task and is waiting for your input.
        Notifications appear as desktop alerts and are triggered after 8 seconds of terminal idle.
      </p>

      {enabled && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 10px', borderRadius: 6,
          background: 'var(--bg-tertiary, var(--bg-primary))',
        }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
              Suppress when focused
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              Only notify when DevHub-AI is in the background
            </div>
          </div>
          <button
            className={`btn btn-sm ${quietMode ? 'btn-accent' : ''}`}
            onClick={() => setQuietMode(!quietMode)}
            style={{ minWidth: 50, fontSize: 11 }}
          >
            {quietMode ? 'On' : 'Off'}
          </button>
        </div>
      )}
    </div>
  )
}
