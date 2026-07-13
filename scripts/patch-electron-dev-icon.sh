#!/bin/bash
# Patch node_modules Electron.app so `npm run dev` shows the DevHub-AI icon (Dock + app switcher).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ICNS="$PROJECT_DIR/resources/icon.icns"
ELECTRON_APP="$PROJECT_DIR/node_modules/electron/dist/Electron.app"
TARGET="$ELECTRON_APP/Contents/Resources/electron.icns"

if [ ! -f "$ICNS" ]; then
  echo "patch-electron-dev-icon: skip (no resources/icon.icns — run npm run icons)"
  exit 0
fi

if [ ! -d "$ELECTRON_APP" ]; then
  echo "patch-electron-dev-icon: skip (electron not installed yet)"
  exit 0
fi

cp "$ICNS" "$TARGET"
touch "$ELECTRON_APP"
echo "Patched dev Electron icon: $TARGET"
