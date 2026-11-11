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

# Windows locks running executables — stop the app AND the native-messaging
# host (it lingers while a browser keeps its pipe open). Best-effort: with
# --no-build on a fresh box neither may be running.
/mnt/c/Windows/System32/taskkill.exe /IM OpenDMMsgHost.exe /F >/dev/null 2>&1 || true
/mnt/c/Windows/System32/taskkill.exe /IM OpenDM.exe /F >/dev/null 2>&1 || true
sleep 1

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

# Browser extension → $DEST/extension (mirrored: stale files don't linger).
if [[ -d extension ]]; then
  rm -rf "$DEST/extension"
  cp -r extension "$DEST/extension"
fi

# Native-messaging manifest for the browser extension: created if missing,
# refreshed when the id in ext_id.txt changes (key rotation → update ext_id.txt
# and redeploy; the file is only rewritten when the id actually differs).
EXT_ID="$(tr -d '[:space:]' < ext_id.txt 2>/dev/null || true)"
if [[ ! -f "$DEST/OpenDMMsgHost.json" ]] || ! grep -q "chrome-extension://${EXT_ID}/" "$DEST/OpenDMMsgHost.json" 2>/dev/null; then
  cat > "$DEST/OpenDMMsgHost.json" <<EOF
{
  "name": "app.opendm.host",
  "description": "OpenDM browser bridge (native messaging to WebSocket)",
  "path": "OpenDMMsgHost.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXT_ID}/"]
}
EOF
  echo "wrote $DEST/OpenDMMsgHost.json (extension id: ${EXT_ID:-?})"
fi

echo "deployed to $DEST:"
ls -lh "$DEST" | awk 'NR>1 {print "  " $5 "\t" $9}'
