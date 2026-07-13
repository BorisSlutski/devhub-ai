/** Stop a timed-out query on the server (PyCharm/JDBC-style) using the sibling socket. */
export async function killServerQuery(killConn: any, victimConn: any): Promise<void> {
  const threadId = victimConn?.threadId
  if (!killConn || typeof threadId !== 'number') return
  try {
    await killConn.query(`KILL QUERY ${threadId}`)
  } catch {
    // best effort — tunnel may already be dead
  }
}
