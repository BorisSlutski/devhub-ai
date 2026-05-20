#!/bin/bash
# Regenerate macOS app icons and README logo assets from resources/icon.svg
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$PROJECT_DIR/resources/icon.svg"
ICONSET="$PROJECT_DIR/resources/icon.iconset"

if [ ! -f "$SVG" ]; then
  echo "Missing $SVG"
  exit 1
fi

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert required (brew install librsvg)"
  exit 1
fi

echo "Generating icon.png (1024)..."
rsvg-convert -w 1024 -h 1024 "$SVG" -o "$PROJECT_DIR/resources/icon.png"

echo "Generating logo.jpeg (README hero)..."
sips -s format jpeg "$PROJECT_DIR/resources/icon.png" \
  --out "$PROJECT_DIR/resources/logo.jpeg" >/dev/null

echo "Generating icon.iconset..."
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  dbl=$((size * 2))
  rsvg-convert -w "$size" -h "$size" "$SVG" -o "$ICONSET/icon_${size}x${size}.png"
  rsvg-convert -w "$dbl" -h "$dbl" "$SVG" -o "$ICONSET/icon_${size}x${size}@2x.png"
done

echo "Generating icon.icns..."
if ! iconutil -c icns "$ICONSET" -o "$PROJECT_DIR/resources/icon.icns"; then
  echo "iconutil failed — try: iconutil -c icns \"$ICONSET\" -o \"$PROJECT_DIR/resources/icon.icns\""
  exit 1
fi

echo "Done:"
echo "  resources/icon.png"
echo "  resources/logo.jpeg"
echo "  resources/icon.icns"
