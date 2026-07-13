#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="DevHub-AI"
DIST_DIR="$PROJECT_DIR/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
ELECTRON_APP="$PROJECT_DIR/node_modules/electron/dist/Electron.app"

echo "Rebuilding native modules for Electron..."
cd "$PROJECT_DIR"
npx electron-rebuild -f -w node-pty

echo "Building $APP_NAME..."
npx electron-vite build

echo "Regenerating icon.icns from resources/icon.png..."
npm run icons

echo "Packaging $APP_NAME.app..."
rm -rf "$APP_DIR"
mkdir -p "$DIST_DIR"
cp -R "$ELECTRON_APP" "$APP_DIR"

# Rename the binary and update Info.plist so macOS can find it
mv "$APP_DIR/Contents/MacOS/Electron" "$APP_DIR/Contents/MacOS/$APP_NAME"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $APP_NAME" "$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$APP_DIR/Contents/Info.plist" 2>/dev/null || true

# Replace the default electron.icns with the DevHub-AI icon so the dock/Finder
# shows the right artwork. Info.plist still points at electron.icns, which is
# why we overwrite in place rather than renaming.
if [ -f "$PROJECT_DIR/resources/icon.icns" ]; then
  cp "$PROJECT_DIR/resources/icon.icns" "$APP_DIR/Contents/Resources/electron.icns"
fi

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
# mysql2 + its runtime deps (required for DB Access feature)
for mod in mysql2 aws-ssl-profiles denque iconv-lite long named-placeholders generate-function sql-escaper lru.min is-property safer-buffer; do
  if [ -d "$PROJECT_DIR/node_modules/$mod" ]; then
    cp -R "$PROJECT_DIR/node_modules/$mod" "$APP_DIR/Contents/Resources/app/node_modules/"
  fi
done

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

# Remove macOS quarantine flags that block native modules
xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true
# Ensure spawn-helper is executable
chmod +x "$APP_DIR/Contents/Resources/app/node_modules/node-pty/build/Release/spawn-helper" 2>/dev/null || true

echo ""
echo "Done! $APP_NAME.app created at: $DIST_DIR/$APP_NAME.app"
echo ""
echo "To install to Applications (Dock icon included), run:"
echo "  npm run install-app"
echo ""
echo "Or manually:"
echo "  cp -R \"$DIST_DIR/$APP_NAME.app\" /Applications/"
echo "  open -a \"$APP_NAME\""
echo ""
echo "Dock: launch the app → right-click Dock icon → Options → Keep in Dock"
