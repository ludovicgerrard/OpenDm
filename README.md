# OpenDM

**OpenDM** is a fast, local-first download manager for Windows — think IDM (Internet
Download Manager) rebuilt on open tools. It downloads plain files at full speed with
multi-segment connections, grabs HLS video streams, and handles YouTube (and 1000+
other sites) through yt-dlp. A browser extension sends links, media and cookies from
any page to the app with one click.

Everything runs on your machine: no accounts, no telemetry, no cloud.

## What it's for

- **Everyday downloads** — links, images, videos from any page (context menu or
  floating button), segmented parallel connections with resume.
- **Video sites** — YouTube watch/shorts/embed pages are parsed by yt-dlp; you pick a
  quality (1080p, audio-only, …) in the app, then download.
- **Streaming players** (HLS `.m3u8`) — the extension sniffs the manifest, shows an
  IDM-style quality menu, and OpenDM downloads + merges the segments.
- **Browser download takeover** — when the browser starts a download, the extension
  can cancel it and hand it to OpenDM instead (like IDM).
- **Cookies travel with the link** — age-restricted or members-only content works,
  cookies are sent only to the local app.

## The tools it uses (installed from inside the app)

| Tool | Required | Why |
|---|---|---|
| **yt-dlp** | for YouTube/video sites | metadata (`-J`), quality list, download |
| **Deno** | optional | unlocks every YouTube format (yt-dlp's JS runtime) |
| **FFmpeg + FFprobe** | for merging | merges video+audio streams, HLS merge |

Plain HTTP and HLS downloads work without any of them. Tools are installed to
`tools/` next to the app (release channel: stable / nightly / master for yt-dlp).

## Tech stack

- **Engine + app: Rust** — workspace with three crates:
  - `opdm-core` — download engine (multi-segment HTTP, HLS with AES-128, resume),
    settings/jobs persistence, yt-dlp pipeline + tool manager, WebSocket server.
  - `opdm-app` — Tauri 2 desktop app that hosts the engine and exposes 18 IPC
    commands to the UI. Binary: `OpenDM.exe`.
  - `opdm-host` — native-messaging host (`OpenDMMsgHost.exe`), the extension's
    fallback channel (like IDM's `IDMMsgHost.exe`).
- **UI: React 19 + TypeScript + Vite + Tailwind CSS 4** (shadcn-style components,
  Zustand, React Router), built at compile time and **embedded into the exe**.
- **Browser extension: Chrome/Brave/Edge (Manifest V3)** — WebSocket primary +
  native-messaging fallback, media sniffing via `webRequest`, download takeover.
- **No databases** — portable JSON files (`OpenDM.json`, `jobs.json`) live next to
  the exe; `logs/engine.log` for diagnostics.

## Build (Windows, from WSL)

```bash
# 1. frontend — must be built BEFORE the Rust build (assets are embedded)
cd crates/opdm-app/webui
npm ci
npm run build

# 2. backend (cross-compiles; .cargo/config.toml selects the mingw linker)
cd ../../..
cargo build --release --target x86_64-pc-windows-gnu
# → target/x86_64-pc-windows-gnu/release/OpenDM.exe
```

Or just `./deploy.sh` — builds both steps and deploys the program files
(`OpenDM.exe`, `OpenDMMsgHost.exe`, `OpenDMMsgHost.json`, `WebView2Loader.dll`,
`extension/`) to the install folder `C:\Users\ludov\OpenDM`. It **never touches
user data** (`OpenDM.json`, `jobs.json`, `tools/`, `logs/`, downloads).

## Install / use the browser extension

1. `chrome://extensions` (or `brave://extensions`) → enable **Developer mode**
2. **Load unpacked** → select `C:\Users\ludov\OpenDM\extension`
3. The registry keys
   `HKCU\Software\{Google\Chrome|BraveSoftware\Brave-Browser|Microsoft\Edge}\NativeMessagingHosts\app.opendm.host`
   already point at the deployed `OpenDMMsgHost.json` (fallback channel).

The extension ID is pinned by the manifest `key` field
(`ojkooabcagmjbkllfemmfgaehhhcjhcg`, also in `ext_id.txt`). After a key rotation:
update `ext_id.txt` and redeploy — `deploy.sh` refreshes the native-messaging
manifest automatically.

## Develop the UI

```bash
cd crates/opdm-app/webui
npm run dev     # vite on http://localhost:1420 — runs in a browser with mock data
```

Inside Tauri the same code calls the real backend; the mapping lives in
`crates/opdm-app/webui/src/lib/{tauri,backend}.ts`. The frontend follows the
capability-flag pattern (`src/lib/capabilities.ts`): unsupported controls are
hidden, not deleted — each maps to a backend addition in **`TODO.md`**.

**Agent work on this repo?** Read **`agent.md`** first — it is the complete
technical reference (contracts, file formats, build pitfalls).

## Tests

```bash
cargo test -p opdm-core   # engine tests, runs on the Linux host
```
