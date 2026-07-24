#!/usr/bin/env bash
# Regenerate assets/icon.icns from assets/termivin-logo.png (macOS only).
# Requires sips + iconutil (ship with macOS).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/assets/termivin-logo.png"
out="$root/assets/icon.icns"
tmp="$(mktemp -d)/icon.iconset"
mkdir -p "$tmp"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size"           "$src" --out "$tmp/icon_${size}x${size}.png"     >/dev/null
  sips -z $((size*2)) $((size*2))   "$src" --out "$tmp/icon_${size}x${size}@2x.png"  >/dev/null
done

iconutil -c icns "$tmp" -o "$out"
rm -rf "$tmp"
echo "wrote $out"
