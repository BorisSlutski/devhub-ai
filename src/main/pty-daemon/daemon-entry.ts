/**
 * Daemon Entry Point — this is the script that gets spawned as a detached process.
 *
 * It imports and starts the daemon server. Must be plain Node.js — no Electron APIs.
 * Launched by the DaemonClient via `child_process.spawn` with detached: true.
 */

import { startDaemon } from './daemon'

// Start the daemon server
startDaemon()
