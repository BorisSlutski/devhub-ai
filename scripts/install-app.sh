#!/bin/bash
# Build (if needed) and copy DevHub-AI.app to /Applications
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="DevHub-AI"
SRC="$PROJECT_DIR/dist/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"

if [ ! -d "$SRC" ]; then
  echo "dist/$APP_NAME.app not found — running npm run package first..."
  cd "$PROJECT_DIR"
  npm run package
fi

if pgrep -f "$DEST" >/dev/null 2>&1 || pgrep -f "$APP_NAME" >/dev/null 2>&1; then
  echo "Closing running $APP_NAME..."
  osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || true
  sleep 1
fi

echo "Installing to $DEST ..."
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

if [ -x "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" ]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
fi

echo ""
echo "Installed $APP_NAME to Applications."
echo ""
echo "Launching..."
open "$DEST"
echo ""
echo "Or open manually:"
echo "  open /Applications/$APP_NAME.app"
echo ""
echo "Add to Dock: right-click Dock icon → Options → Keep in Dock."
