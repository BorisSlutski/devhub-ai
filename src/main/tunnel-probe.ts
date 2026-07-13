import { createConnection } from 'net'

/** Quick TCP probe — port accepting connections on 127.0.0.1 (SSH local forward). */
export function isLocalPortReachable(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const started = Date.now()
    const probe = () => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.destroy()
        finish(true)
      })
      sock.on('error', () => {
        sock.destroy()
        if (Date.now() - started >= timeoutMs) finish(false)
        else setTimeout(probe, 200)
      })
    }
    probe()
    setTimeout(() => finish(false), timeoutMs)
  })
}

/** True when a MySQL error likely means the SSH forward is dead, not bad credentials. */
export function isLikelyTunnelFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|timed out|Connection lost|PROTOCOL_CONNECTION_LOST|ENOTCONN/i.test(
    msg,
  )
}
