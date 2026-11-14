# Changelog

All notable changes to OpenDM are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versioning is semantic
(MAJOR.MINOR.PATCH): PATCH = fixes, MINOR = features, bumped **before** every
deploy so the running exe always reports its true version (About page,
engine.log, exe metadata — all read the workspace version from `Cargo.toml`).

## [1.1.0] — 2026-11-14

### Added
- **Compact view on the Home downloads list** — a `Compact` switch (right end of
  the select-all header line) toggles dense single-line rows; preference
  persists across restarts (`opendm-ui` store, `compactHome`).
- **Graceful exit** — tray → Exit stops every running download/background job
  first (`Engine::shutdown()`: pause all, 600 ms grace, force PAUSED, persist,
  clear the parse slot); even a force-kill of the app leaves zero orphan
  yt-dlp/ffmpeg processes.

### Fixed
- **yt-dlp pause/delete never stopped downloads** (root cause proven live via
  WebView2 CDP): the official yt-dlp.exe is a PyInstaller onefile build that
  spawns a second worker process — killing the spawned bootloader left the
  worker orphaned and downloading. Every spawned yt-dlp (download AND `-J`
  parse) is now assigned to a Windows **Job Object** with KILL_ON_JOB_CLOSE;
  pause/cancel terminates the whole tree, and app death takes every tree with it.
- Deleting a mid-download job now also sweeps its orphan `.part`/`.ytdl`
  fragments (previously some survived, e.g. killed jobs with no tracked outputs).
- Playlist URLs hijacked single downloads — `--no-playlist` on every yt-dlp
  download call.
- Light theme rendered near-black until the first toggle (hard-coded
  `#09090b` pre-paint background); theme now applies pre-paint from the
  persisted store, with themed scrollbars.
- Version single-source-of-truth: `tauri.conf.json` dropped its hardcoded
  `version` so About / engine.log / exe metadata all derive from `Cargo.toml`.

## [1.0.0] — baseline

Initial stable release: download engine (classic + HLS + yt-dlp), batch
download page, browser-extension capture, tools manager, tray, plugin
WebSocket server.
