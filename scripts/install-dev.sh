#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="DevHub-AI"
APP_DIR="/Applications/$APP_NAME.app"
ELECTRON_APP="$PROJECT_DIR/node_modules/electron/dist/Electron.app"

if pgrep -f "$APP_DIR" > /dev/null 2>&1; then
  echo "Closing running DevHub-AI..."
  osascript -e 'quit app "DevHub-AI"' 2>/dev/null || true
  sleep 1
fi

echo "Rebuilding native modules for Electron..."
cd "$PROJECT_DIR"
npx electron-rebuild -f -w node-pty

echo "Building $APP_NAME..."
npx electron-vite build

echo "Installing $APP_NAME.app with dev symlinks..."
rm -rf "$APP_DIR"
cp -R "$ELECTRON_APP" "$APP_DIR"

mv "$APP_DIR/Contents/MacOS/Electron" "$APP_DIR/Contents/MacOS/$APP_NAME"

mkdir -p "$APP_DIR/Contents/Resources/app"

# Symlink app code — changes propagate automatically after `npm run build`
ln -s "$PROJECT_DIR/out" "$APP_DIR/Contents/Resources/app/out"
ln -s "$PROJECT_DIR/resources" "$APP_DIR/Contents/Resources/app/resources"
ln -s "$PROJECT_DIR/package.json" "$APP_DIR/Contents/Resources/app/package.json"
ln -s "$PROJECT_DIR/node_modules" "$APP_DIR/Contents/Resources/app/node_modules"

cp "$PROJECT_DIR/resources/icon.icns" "$APP_DIR/Contents/Resources/electron.icns"
cp "$PROJECT_DIR/resources/icon.icns" "$APP_DIR/Contents/Resources/$APP_NAME.icns"

cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>DevHub-AI</string>
  <key>CFBundleDisplayName</key>
  <string>DevHub-AI</string>
  <key>CFBundleIdentifier</key>
  <string>com.devhub-ai.app</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>DevHub-AI</string>
  <key>CFBundleIconFile</key>
  <string>DevHub-AI</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>10.15.0</string>
</dict>
</plist>
PLIST

echo ""
echo "Done! Dev install complete."
echo ""
echo "From now on, to update the app:"
echo "  npm run build        — rebuild, then relaunch DevHub-AI"
echo "  npm run build:watch  — auto-rebuild on file changes"
echo ""
echo "No more copying to /Applications needed!"
