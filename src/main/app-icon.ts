import { app, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

const ICON_NAMES = ['icon.png', 'icon.icns'] as const

/** Resolve resources/ whether running from out/main, packaged .app, or project root (dev). */
export function resolveResourcesDir(): string {
  const candidates = [
    join(__dirname, '../../resources'),
    join(app.getAppPath(), 'resources'),
    join(process.cwd(), 'resources'),
  ]
  for (const dir of candidates) {
    if (ICON_NAMES.some((name) => existsSync(join(dir, name)))) {
      return dir
    }
  }
  return join(process.cwd(), 'resources')
}

export function resolveAppIconPath(prefer: 'png' | 'icns' = 'png'): string {
  const dir = resolveResourcesDir()
  const order =
    prefer === 'icns' ? (['icon.icns', 'icon.png'] as const) : (['icon.png', 'icon.icns'] as const)
  for (const name of order) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return join(dir, 'icon.png')
}

/** macOS Dock icon (dev + packaged). Process icon in dev comes from patch-electron-dev-icon.sh. */
export function applyMacDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return

  const pngPath = resolveAppIconPath('png')
  const icnsPath = resolveAppIconPath('icns')

  for (const path of [pngPath, icnsPath]) {
    if (!existsSync(path)) continue
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) {
      app.dock.setIcon(image)
      return
    }
  }
}
