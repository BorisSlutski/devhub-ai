#!/bin/bash
# Regenerate macOS app icons from resources/icon.png (source of truth)
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PNG="$PROJECT_DIR/resources/icon.png"
ICONSET="$PROJECT_DIR/resources/icon.iconset"

if [ ! -f "$PNG" ]; then
  echo "Missing $PNG"
  exit 1
fi

echo "Generating icon.iconset from icon.png..."
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  dbl=$((size * 2))
  sips -z "$size" "$size" "$PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$dbl" "$dbl" "$PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

echo "Generating icon.icns..."
if ! iconutil -c icns "$ICONSET" -o "$PROJECT_DIR/resources/icon.icns"; then
  echo "iconutil failed — try: iconutil -c icns \"$ICONSET\" -o \"$PROJECT_DIR/resources/icon.icns\""
  exit 1
fi
rm -rf "$ICONSET"

echo "Patching node_modules Electron.app for npm run dev..."
bash "$PROJECT_DIR/scripts/patch-electron-dev-icon.sh"

echo "Done:"
echo "  resources/icon.png  (source)"
echo "  resources/icon.icns   (generated)"
