# openDM

Download manager: Rust workspace (engine + Tauri 2 desktop app + native-messaging host)
with a React 19 + Vite + Tailwind 4 web UI embedded at compile time.

## Build the release app (Windows, from WSL)

```bash
# 1. frontend (must be built BEFORE the Rust build — assets are embedded at compile time)
cd crates/opdm-app/webui
npm ci
npm run build

# 2. backend
cd ../../..
cargo build --release -p opdm-app          # binary: target/x86_64-pc-windows-gnu/release/OpenDM.exe
# (this repo cross-compiles; .cargo/config.toml selects the mingw linker)
```

`./deploy.sh` at the repo root does both steps and copies the program files to the
install folder — it never touches user data (OpenDM.json, jobs.json, ui-state.json,
tools/, logs/, downloads).

## Develop the UI

```bash
cd crates/opdm-app/webui
npm run dev        # vite on http://localhost:1420 — runs in a browser with mock data
```

Inside Tauri the same code calls the real backend commands/events; the mapping lives
in `crates/opdm-app/webui/src/lib/{tauri,backend}.ts` — see
`crates/opdm-app/webui/docs` notes: the frontend follows
`MIGRATE_TO_NEW_FRONTEND.md` (real contract + capability flags), while
`BACKEND_INTEGRATION.md`/`SETTINGS_PAGE.md` describe an idealized backend whose
command names do **not** exist here.

## Tests

```bash
cargo test -p opdm-core
```
