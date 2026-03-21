import { useState, useEffect, useCallback, useRef } from 'react'
import type { ResourceSnapshot, SessionMetrics } from '../../shared/ipc-types'

export function useResourceMonitor(enabled = true) {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const subscribedRef = useRef(false)

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)

    // Fetch initial snapshot
    window.api.resourceGetSnapshot()
      .then((snap) => {
        setSnapshot(snap)
        setIsLoading(false)
      })
      .catch(() => setIsLoading(false))

    // Subscribe to periodic updates
    window.api.resourceSubscribe()
    subscribedRef.current = true

    const unsub = window.api.onResourceUpdate((snap) => {
      setSnapshot(snap)
      setIsLoading(false)
    })

    return () => {
      unsub()
      if (subscribedRef.current) {
        window.api.resourceUnsubscribe()
        subscribedRef.current = false
      }
    }
  }, [enabled])

  const getSessionMetrics = useCallback(
    (sessionId: string): SessionMetrics | null => {
      if (!snapshot) return null
      return snapshot.sessions.find(s => s.sessionId === sessionId) ?? null
    },
    [snapshot]
  )

  return { snapshot, getSessionMetrics, isLoading }
}
