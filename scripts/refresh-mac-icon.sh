#!/bin/bash
# Re-apply DevHub-AI icon to the installed .app and refresh macOS icon cache.
set -euo pipefail

APP="/Applications/DevHub-AI.app"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ICNS="$PROJECT_DIR/resources/icon.icns"

if [ ! -f "$ICNS" ]; then
  echo "Run npm run icons first."
  exit 1
fi

if [ ! -d "$APP" ]; then
  echo "$APP not found — run: npm run install-app"
  exit 1
fi

osascript -e 'quit app "DevHub-AI"' 2>/dev/null || true
sleep 1

echo "Copying icon into app bundle..."
cp "$ICNS" "$APP/Contents/Resources/DevHub-AI.icns"
cp "$ICNS" "$APP/Contents/Resources/electron.icns"

/usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile DevHub-AI' "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string DevHub-AI' "$APP/Contents/Info.plist"

touch "$APP"
xattr -cr "$APP" 2>/dev/null || true

# Register with Launch Services so `open -a DevHub-AI` works
if [ -x "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" ]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
fi

echo "Refreshing Dock icon cache (Dock will restart briefly)..."
killall Dock 2>/dev/null || true

echo ""
echo "Done. Launching DevHub-AI..."
open "$APP"

echo ""
echo "Note: npm run dev uses the generic Electron icon — only the packaged app shows the custom icon."
echo "If open fails, use: open /Applications/DevHub-AI.app"
