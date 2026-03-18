#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="DevDock"
DIST_DIR="$PROJECT_DIR/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
ELECTRON_APP="$PROJECT_DIR/node_modules/electron/dist/Electron.app"

echo "Rebuilding native modules for Electron..."
cd "$PROJECT_DIR"
npx electron-rebuild -f -w node-pty

echo "Building $APP_NAME..."
npx electron-vite build

echo "Packaging $APP_NAME.app..."
rm -rf "$APP_DIR"
mkdir -p "$DIST_DIR"
cp -R "$ELECTRON_APP" "$APP_DIR"

# Rename the binary
mv "$APP_DIR/Contents/MacOS/Electron" "$APP_DIR/Contents/MacOS/$APP_NAME"

# Copy app code into Resources/app
mkdir -p "$APP_DIR/Contents/Resources/app"
cp -R "$PROJECT_DIR/out" "$APP_DIR/Contents/Resources/app/out"
cp -R "$PROJECT_DIR/resources" "$APP_DIR/Contents/Resources/app/resources"
cp "$PROJECT_DIR/package.json" "$APP_DIR/Contents/Resources/app/package.json"

# Copy node_modules (only production deps needed at runtime)
mkdir -p "$APP_DIR/Contents/Resources/app/node_modules"
if [ -d "$PROJECT_DIR/node_modules/detect-port" ]; then
  cp -R "$PROJECT_DIR/node_modules/detect-port" "$APP_DIR/Contents/Resources/app/node_modules/"
fi
# node-pty native module (required for embedded terminals)
if [ -d "$PROJECT_DIR/node_modules/node-pty" ]; then
  cp -R "$PROJECT_DIR/node_modules/node-pty" "$APP_DIR/Contents/Resources/app/node_modules/"
fi

# Copy the icon
cp "$PROJECT_DIR/resources/icon.icns" "$APP_DIR/Contents/Resources/electron.icns"
cp "$PROJECT_DIR/resources/icon.icns" "$APP_DIR/Contents/Resources/$APP_NAME.icns"

# Update Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>DevDock</string>
  <key>CFBundleDisplayName</key>
  <string>DevDock</string>
  <key>CFBundleIdentifier</key>
  <string>com.devdock.app</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>DevDock</string>
  <key>CFBundleIconFile</key>
  <string>DevDock.icns</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>10.15.0</string>
</dict>
</plist>
PLIST

# Remove macOS quarantine flags that block native modules
xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true
# Ensure spawn-helper is executable
chmod +x "$APP_DIR/Contents/Resources/app/node_modules/node-pty/build/Release/spawn-helper" 2>/dev/null || true

echo ""
echo "Done! $APP_NAME.app created at: $DIST_DIR/$APP_NAME.app"
echo ""
echo "To install, run:"
echo "  cp -R \"$DIST_DIR/$APP_NAME.app\" /Applications/"
echo ""
echo "Then you can open it from Spotlight or add it to your Dock!"
