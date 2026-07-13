#!/bin/bash
# Verify DevHub-AI.app has a valid macOS icon bundle (post package/install).
set -euo pipefail

APP="${1:-/Applications/DevHub-AI.app}"
PLIST="$APP/Contents/Info.plist"
RES="$APP/Contents/Resources"

if [ ! -d "$APP" ]; then
  echo "App not found: $APP"
  echo "Run: npm run install-app"
  exit 1
fi

ICON_FILE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$PLIST" 2>/dev/null || true)
if [ -z "$ICON_FILE" ]; then
  echo "FAIL: CFBundleIconFile missing in Info.plist"
  exit 1
fi

if [ "$ICON_FILE" = "${ICON_FILE%.icns}" ]; then
  ICNS="$RES/${ICON_FILE}.icns"
else
  echo "WARN: CFBundleIconFile should not include .icns extension (got: $ICON_FILE)"
  ICNS="$RES/$ICON_FILE"
fi

if [ ! -f "$ICNS" ]; then
  echo "FAIL: Icon file not found: $ICNS"
  exit 1
fi

if [ ! -f "$RES/electron.icns" ]; then
  echo "FAIL: electron.icns missing in Resources"
  exit 1
fi

echo "OK: $APP"
echo "  CFBundleIconFile=$ICON_FILE"
echo "  icon=$ICNS"
echo "  electron.icns present"
