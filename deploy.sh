#!/usr/bin/env bash
# Build OpenDM for Windows and deploy the runtime files to the install folder.
#
#   ./deploy.sh              build (if needed) + copy
#   ./deploy.sh --no-build   copy the last built artifacts only
#
# Copies ONLY program files — user data already in the destination
# (OpenDM.json, jobs.json, ui-state.json, tools/, logs/, downloads) is never
# touched. The native-messaging manifest is created if missing (the Chrome
# registry key HKCU\Software\Google\Chrome\NativeMessagingHosts\app.opendm.host
# points at <dest>\OpenDMMsgHost.json).
set -euo pipefail
cd "$(dirname "$0")"

DEST="${OPENDM_DEST:-/mnt/c/Users/ludov/OpenDM}"
REL="target/x86_64-pc-windows-gnu/release"
FILES=(OpenDM.exe OpenDMMsgHost.exe WebView2Loader.dll)

if [[ "${1:-}" != "--no-build" ]]; then
  # Plain cargo build embeds webui/dist at compile time (tauri.conf.json has no
  # devUrl, so even a dev-profile-style build loads the embedded assets — the
  # frontend must be built BEFORE the Rust build:  cd crates/opdm-app/webui &&
  # npm ci && npm run build).
  cargo build --release --target x86_64-pc-windows-gnu
fi

if [[ ! -f "$REL/OpenDM.exe" ]]; then
  echo "error: $REL/OpenDM.exe not found — run without --no-build first" >&2
  exit 1
fi

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  if ! cp -f "$REL/$f" "$DEST/$f" 2>/dev/null; then
    echo "error: could not replace $DEST/$f — is OpenDM.exe still running on Windows?" >&2
    exit 1
  fi
done

# Native-messaging manifest for the browser extension (created if missing;
# never overwritten — rotate the extension id there when you rotate keys).
if [[ ! -f "$DEST/OpenDMMsgHost.json" ]]; then
  EXT_ID="$(tr -d '[:space:]' < ext_id.txt 2>/dev/null || true)"
  cat > "$DEST/OpenDMMsgHost.json" <<EOF
{
  "name": "app.opendm.host",
  "description": "OpenDM browser bridge (native messaging to WebSocket)",
  "path": "OpenDMMsgHost.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXT_ID}/"]
}
EOF
  echo "created $DEST/OpenDMMsgHost.json (extension id: ${EXT_ID:-?})"
fi

echo "deployed to $DEST:"
ls -lh "$DEST" | awk 'NR>1 {print "  " $5 "\t" $9}'
