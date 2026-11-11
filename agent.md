# agent.md — technical reference for agents working on OpenDM

Everything an agent needs to **update, upgrade or debug** this app without breaking it.
Written from the actual code (workspace version 1.0.0). When this file and the code
disagree, the code wins — then fix this file.

---

## 0. Ground rules (non-negotiable)

1. **The Rust contract is frozen.** The 18 Tauri commands, 4 event names, WS message
   shape and on-disk JSON fields are relied on by the frontend adapter and the
   extension. Add things; don't rename or reshape them.
2. **Owner-managed, never touch:** git history (no filter-repo/force-push),
   `ext_priv.pem` / `ext_key.txt` (removed from tracking — key rotation is done).
3. **`deploy.sh` never overwrites user data** (`OpenDM.json`, `jobs.json`,
   `ui-state.json`, `tools/`, `logs/`, `tmp/`, downloads).
4. **Never log cookie values.** Only `cookiesSent: bool` is exposed anywhere.
5. The idealized docs (`BACKEND_INTEGRATION.md`, `SETTINGS_PAGE.md`) describe an
   **imaginary** backend (`parse_url`, `start_download`, `download://…`) — those
   command names do **not** exist here. The authority is
   `MIGRATE_TO_NEW_FRONTEND.md` (in the owner's frontend folder,
   `/mnt/c/Users/ludov/Downloads/OpenDM-frontend (1)/opendm/docs/`) — this file
   inlines everything important from it, so you don't need the external docs.

---

## 1. Repo map

```
Cargo.toml                  workspace (resolver 2): version 1.0.0, edition 2021
                            release: opt-level 2, strip, lto off
.cargo/config.toml          cross-compile: linker x86_64-w64-mingw32-gcc (+ar)
crates/
  opdm-core/   (lib)        engine + everything non-UI
    src/cfg.rs              Settings, OpenDM.json, app_dir(), UA/mime helpers
    src/job.rs              JobCore, states ST_*, uuid(), filename sanitize
    src/dlm.rs              Engine singleton, queue/start/pause/resume/stop/remove
    src/db.rs               jobs.json persist/restore (DbJob)
    src/ytdlp.rs            yt-dlp pipeline, parse slot, tool manager
    src/wssrv.rs            RFC6455-subset WebSocket server
    src/diag.rs             logs/engine.log (+engine.log.1, ~2 MB rotate)
  opdm-app/    (bin OpenDM) Tauri 2 app: IPC commands, WS sink, event pump
    src/main.rs             setup + 18 commands
    tauri.conf.json         productName OpenDM, identifier app.opendm.desktop,
                            frontendDist webui/dist (NO devUrl), withGlobalTauri
    capabilities/default.json  REQUIRED (see §9.1)
    webui/                  React frontend (builds → dist/, embedded at compile time)
  opdm-host/   (bin OpenDMMsgHost)  native-messaging host (extension fallback)
extension/                  Chrome/Brave/Edge extension (MV3), mirrored on deploy
ext_id.txt                  pinned extension ID (single source for the NM manifest)
deploy.sh                   build + deploy program files to the install folder
README.md, TODO.md          user docs / backend-addition backlog
```

Core dependencies: `serde/serde_json`, `url`, `sha1`+`base64` (WS handshake),
`ureq 2.10` (tls+gzip — all HTTP), `dirs 6`, `aes`+`cbc` (HLS AES-128),
`zip 2` (deflate — tool archives). App: `tauri 2` with the **devtools** feature
(F12 opens the WebView2 console in the shipped app — keep it). Host: `serde_json`,
`sha1`, `base64`.

Frontend stack: React 19 + TypeScript, Vite 8, Tailwind CSS 4 (+ tw-animate-css,
@fontsource-variable/schibsted-grotesk), shadcn-style `components/ui/*`, Zustand 5,
react-router 7 (**hash router**), react-resizable-panels **^2** (v4 is a different
API — do not upgrade), lucide-react, @tauri-apps/api 2.

---

## 2. Runtime layout (portable install)

App dir = **folder of the exe** (`cfg::app_dir()`), i.e. `C:\Users\ludov\OpenDM\`:

```
OpenDM.exe            Tauri app (UI embedded in the binary)
OpenDMMsgHost.exe     native-messaging host
OpenDMMsgHost.json    NM manifest {name:"app.opendm.host", path:"OpenDMMsgHost.exe",
                      allowed_origins:["chrome-extension://<EXT_ID>/"]}
WebView2Loader.dll
extension/            load-unpacked in the browser (see §7)
OpenDM.json           settings (schema §5.4)
jobs.json             full job list incl. segment positions + cookies (schema §5.5)
ui-state.json         leftover from the old UI, harmless, unused
tools/                yt-dlp.exe, deno/, ffmpeg.exe, ffprobe.exe (managed installs)
logs/engine.log(.1)   diagnostic trail
tmp/                  in-flight parts (also parts_dir() beside HLS meta.json)
```

Windows registry (already registered, points at the deployed JSON):
`HKCU\Software\{Google\Chrome|BraveSoftware\Brave-Browser|Microsoft\Edge}\NativeMessagingHosts\app.opendm.host`.

---

## 3. Data flow (every entry point funnels through the parse slot)

```
extension (WS add/takeover, NM fallback) ─┐
header paste box (add_download)           ├→ parse slot (sticky, seq-ordered)
New page Analyze                          ┘        │
                                            parse-state event / parse_state poll
                                                     ▼
                                          UI /new page: name + quality pick
                                                     │ parse_confirm(url,kind,
                                                     │  filename,fmt,referer,cookies)
                                                     ▼
                          engine().queue() [classic] or queue_ytdlp() [yt-dlp]
                                                     │ ST_QUEUED → ST_RUNNING
                                                     ▼
                     workers (multi-segment HTTP / HLS / yt-dlp subprocess)
                                                     │
                            Ev::Progress / Ev::State → "job-update" events
                            (+ 1.5 s list poll reconciles everything)
```

The slot is **sticky**: it survives until `parse_clear`/`parse_confirm`, so the UI
must poll `parse_state` too (the window can be hidden when the event fires). The
event emitter also **raises/focuses the main window** on every `parse-state` —
extension click parity with `Show`.

WS `add` **and** `takeover` both become `WsCmd::Add` → window shown → `from_send`.
Nothing ever auto-downloads; the UI Download button calls `parse_confirm`.

---

## 4. Job state machine

`job.rs`: `ST_QUEUED=1, ST_RUNNING=2, ST_PAUSED=3, ST_DONE=4, ST_ERROR=5`.

- `Engine::start` only accepts QUEUED|PAUSED → RUNNING; workers end in
  DONE/ERROR/PAUSED (pause flag) or **QUEUED** (stop keeps parts, resume later).
- Boot restore (`db.rs::load_into`): persisted `state 2 → 3 (PAUSED)`, `0 → 1`;
  **nothing auto-starts**. Segment positions restore exactly (`start,end,pos,done`).
- Job `kind`: `"" / "range"` = classic multi-segment HTTP, `"hls"`, `"ytdlp"`.
  `stage`: `"" | "downloading" | "merging"` (merging = ffmpeg concat).
- Job ids: `uuid()` = time-based uppercase hex (`{:04X}{:04X}{:04X}{:08X}`).
- yt-dlp jobs have **no extension in `name` until the merge finishes** — the UI
  splits name/ext heuristically and `open_file` may fail → fall back to
  `open_folder`.

---

## 5. Contracts (exact)

### 5.1 Tauri commands (`opdm-app/src/main.rs`, all 18)

| Command | Args (camelCase where noted) | Returns / effect |
|---|---|---|
| `add_download` | `url, referer?, filename?` | fills the **parse slot** (never queues); returns `"parse"` |
| `list_jobs` | – | array of `{id,url,name,folder,state,done,total,speed,error,kind,stage}` |
| `job_details` | `id` | `Option<Value>`: list row + `referer`, `cookiesSent`, `segs:[{idx,frac,done}]` (range only), `hls:{total,done}` (hls only, counted from `seg{i}.part` files) |
| `pause_job` / `resume_job` / `stop_job` | `id` | – |
| `remove_job` | `id, delFiles` | – |
| `open_folder` | `id: Option<String>` | no id → the download dir |
| `open_file` | `id` | may fail for yt-dlp jobs (no ext yet) |
| `get_settings` | – | `{port, max_segments, download_dir, user_agent, integrate_takeover, ytdlp_channel}` — **snake_case** |
| `save_settings` | `port, maxSegments, downloadDir, userAgent, integrateTakeover` — **all 5 required**, no partial update | port ignored when `0`; segments clamped 1–16; create_dir_all |
| `yt_status` | – | `{tools:[{tool,installed,runnable,version,path,source,is_managed,can_update}], channel}` |
| `yt_install_tool` | `tool, operation: "install"|"update"` | async; progress rides `tool-update` |
| `set_ytdlp_channel` | `channel` | stable\|nightly\|master, else Err |
| `parse_state` | – | `{seq, payload: ParsePayload\|null}` |
| `parse_clear` | – | acks/clears the slot |
| `parse_confirm` | `url, kind, filename?, fmt?, referer?, cookies?` | job id (string); clears slot first; kind `"ytdlp"` → `queue_ytdlp(fmtsel=fmt, folder=None)` else `queue()` |
| `yt_log` | `id` | `Option<String>` — yt-dlp subprocess log of that job |

### 5.2 Events (webview)

| Event | Payload | Notes |
|---|---|---|
| `job-update` | `{type:"progress", id, done, total, speed}` or `{type:"state", id, state, name?, error?}` | state events for **unknown ids must be ignored** — the 1.5 s poll adds the row |
| `parse-state` | ParsePayload (below); an ack is `payload=null` with a bumped `seq` | also raises the window; UI keeps the **highest seq** |
| `tool-update` | `{tool, operation?, stage:"downloading"\|"installing"\|"complete"\|"error", percent?, error?, downloaded?, total?}` | `ffprobe` events map to the `ffmpeg` card in the UI |
| `dl-log` | `{id, line}` — **NOT EMITTED anywhere today.** The frontend listens but the backend never sends it (the migration doc lists it as the 4th event). yt-dlp logs are hydrated via the `yt_log` command instead. Implement it if you add live log streaming. |

### 5.3 Parse slot payload (ytdlp.rs `parse_base` + variants)

```jsonc
{ "kind": "ytdlp" | "classic",
  "status": "parsing" | "ready" | "error",
  "url": "", "filename": "", "folder": "<download_dir>",
  "cookies": string|null, "referer": string|null,
  "probe": null | {"totalBytes": n, "type": "...", "disposition": "..."},  // classic only, arrives a beat later
  // ytdlp + ready only:
  "title": "", "videoId": "", "duration": n, "uploader": "", "thumbnail": "",
  "rows": [ {"label":"1080p · mp4","size":n,"approx":bool,
             "note":"best"|"muxed"|"video"|"audio","v":"137","a":"140"} ], // v/a optional
  "error": "" }
```

`fmt` sent back by `parse_confirm` (`rowFmt` in the adapter): `best → ""`,
`audio → a`, `video → "v+bestaudio"` (or `"v+a"`), `muxed → v`. `""` = yt-dlp default.

YouTube detection (`ytdlp::youtube_id`) routes watch/youtu.be/shorts/embed URLs to
the yt-dlp pipeline; everything else is classic (instant entry + background HEAD
probe that fills `probe`).

### 5.4 `OpenDM.json` (Settings, serde defaults — old installs stay valid)

`port` (u16, 9100) · `max_segments` (usize, 8) · `download_dir` (OS Downloads,
OneDrive-aware via `dirs::download_dir()`; auto-migrates away from the old
in-app default) · `user_agent` (Chrome 126 UA string) · `integrate_takeover`
(true) · `ytdlp_channel` ("stable").

### 5.5 `jobs.json` (`db.rs::DbJob`)

`id, url, referer, cookies (plaintext — Fix 2 pending), name, folder, state,
done, total, segs:[{start,end,pos,done}], kind ("":"classic"|"ytdlp"), fmtsel`.
Written pretty by `Engine::persist()` on queue/start/stop/finish/error + boot.

### 5.6 WebSocket server (`wssrv.rs`, `127.0.0.1:<port>`)

- Subprotocol `plugin.v3.opendm.local` (echoed if offered).
- Handshake: any `GET` + `Upgrade: websocket` + `Sec-WebSocket-Key`. Query string
  (`?cid=…&rnd=…`) ignored. **No Origin/Host check today** — any local page can
  connect (see §10 Security).
- Ops: `ping`, `add`, `takeover`, `show`; one JSON reply per text message;
  32 MB frame cap; client masking supported.
- Ping reply is hard-coded `{"ok":true,"app":"OpenDM","version":"1.7.0"}` —
  inconsistent with the real version (1.0.0) → TODO **B7**. Don't "fix" by
  bumping Cargo; wire `env!("CARGO_PKG_VERSION")` instead.

### 5.7 Native-messaging host (`opdm-host`)

stdin/stdout length-prefixed (u32 **LE**) JSON, ≤4 MB. `add|takeover` (url must be
http/https/ftp) forwarded verbatim; `ping|show` forwarded as `{"op":…}`; other ops
rejected. Each message = one TCP connection to `ws://127.0.0.1:9100` (`--port=`
arg supported). **It sends no `Origin` header** — any future Origin check must
still allow missing-origin local clients.

---

## 6. Engine internals (what each kind does)

- **range**: segments planned from Content-Length (`max_segments`, 1–16),
  per-segment `start,end,pos,done` → resumable byte ranges; final validated by
  `validate_final` (guards against HTML-error-page "downloads").
- **hls**: `meta.json` (segment plan) + `seg{i}.part` files in `parts_dir()`;
  AES-128 decrypt (aes/cbc); merge via ffmpeg when needed.
- **ytdlp**: subprocess (`-f fmtsel`, managed ffmpeg/deno paths), log captured for
  `yt_log`, then merge stage. yt-dlp runs from `tools/`, channel selects the
  release asset (stable/nightly/master from GitHub; ffmpeg+ffprobe from
  eugeneware/ffmpeg-static — installing `ffmpeg` fetches **both** binaries;
  Deno from denoland/deno releases zip). Tools install into `<app_dir>/tools/`.

---

## 7. Browser extension (`extension/`)

- **Identity**: MV3, `key` field pins the ID = SHA-256(DER SPKI)[:16] hex digits
  mapped 0-9a-f→a-p → **`ojkooabcagmjbkllfemmfgaehhhcjhcg`** (= `ext_id.txt`).
  To rotate: new key → repack → update `ext_id.txt` → `./deploy.sh` (the NM
  manifest is rewritten when the id differs). Registry keys already point at the
  deployed JSON path, so no registry change is needed on rotation.
- **Channels**: WebSocket primary (`ws://127.0.0.1:9100/?cid=<extid8>&rnd=…`,
  reconnect backoff ≤8 s), native messaging `app.opendm.host` as fallback.
  Replies are ignored (fire-and-forget).
- **`addDownload`**: schemes http/https/ftp only; harvests cookies via
  `chrome.cookies` (name=value pairs) and sends `{op, url, referer, filename,
  cookies}`; `op` is `add` or `takeover` (both = `WsCmd::Add` in the backend).
- **Media**: `webRequest` sniffing classifies URLs (hls/dash/seg/file; YouTube
  `videoplayback` allowed but `sabr=1` URLs excluded — they need a protobuf POST);
  per-tab candidate map (15 min prune, ≤40). HLS master playlists are fetched
  (`probeHls`, credentials included) and the content script shows an IDM-style
  quality menu; media playlists are sent directly. YouTube pages: only the page
  URL is sent (app runs yt-dlp).
- **Takeover**: `downloads.onCreated` → skip `text/html` → `add` to app →
  `chrome.downloads.cancel` + `erase`.
- **Config** `chrome.storage.local`: `{port:9100, takeover:true, enabled:true}` —
  **independent of the app's `integrate_takeover` setting** (that setting is
  stored by the app but the WS sink does not consult it). Toolbar icon toggles
  `enabled` (badge "off"); content script hides its floating buttons too.
- **Filename**: page-title → name (`titleToName`: strips brand/noise tails,
  Windows-illegal chars, ≤120 chars) for HLS/player URLs; URL basename otherwise.

---

## 8. Frontend (`crates/opdm-app/webui`)

- **Structure**: `main.tsx` (createHashRouter — safe on the custom protocol),
  `App.tsx` (boot + parse-seq watcher → `/new` + header paste box), pages
  `Home` (list + `DetailsPanel` in resizable panels), `NewDownload`
  (**view of the parse slot**), `Settings` (tools/general/downloads/network/
  browser/about; output+plugins hidden). `lib/backend.ts` = raw contract types +
  mappers (`mapJob`, `mapSettings`, `mapTool` [4 tools → 3 cards, ffprobe merged
  into ffmpeg], `detailSegments`, `rowFmt`, `fullName`). `lib/tauri.ts` = the
  single bridge (mock fallback when `!isTauri`). `store/useStore.ts` = zustand.
- **Boot order matters**: register the 4 event listeners **first**, then fetch
  (`Promise.all` of list_jobs/get_settings/yt_status/parse_state). Reverse order
  loses events. StrictMode-safe (single-flight `booting` promise).
- **Polling** (all `document.hidden`-gated): 1.5 s `list_jobs` reconcile, 1 s
  `parse_state` catch-up, 600 ms `job_details` for the selected job only. Events
  only patch existing rows; the poll reconciles adds/removes and keeps the log
  buffers.
- **Persistence**: zustand persist key `opendm-ui` stores ONLY
  `{theme, language}` (localStorage). Everything else is Rust-owned. Theme/language
  never go into `save_settings`.
- **Log ring buffer**: cap 500, keep first 50 + tail, `...` marker (port of the
  old `lib/logs.js`). Hydrate once per job via `api.ytLog`.
- **Capability flags** (`lib/capabilities.ts`, all false today): unsupported
  controls are hidden, **never deleted** — each maps to a backend addition
  (`retry`→B2, `saveToFolder`→B1, `pickFolder`→B4, the B5 settings set,
  `toolRemove/toolCustomPath/toolLatestCheck`→B6, `appUpdate`, `extensionFolder`,
  `plugins`, `cli`, `restoreQueue`, `autoStart`). Full table in `TODO.md`.
- **Animation rules** (regression guard — scrollbar flicker fix):
  - `html,body,#root { height:100%; overflow:hidden }`; scroll areas use
    `.scroll-y` (`overflow-x:hidden; overflow-y:auto; scrollbar-gutter:stable`).
  - **Never add `slide-in-from-*` inside a `.scroll-y` container** — fade-only
    (`animate-in fade-in`). The only allowed slide-in is "Delete selected" in the
    Home toolbar (doesn't scroll).
  - `overflow-auto` is allowed only in the DetailsPanel log `<pre>` and the
    Settings About code box.
  - New page scrolls full-window-width (`.scroll-y` outer, centered column inner).
- Vite dev server: port **1420** strictPort; in a plain browser everything uses
  mocks (no backend needed).

---

## 9. Build, deploy, verify

### 9.1 Build order (a classic failure source)

1. `cd crates/opdm-app/webui && npm ci && npm run build` — **the frontend must be
   built BEFORE the Rust build**: assets are embedded at compile time via
   `tauri.conf.json → frontendDist: "webui/dist"`, and there is **no `devUrl`**,
   so a stale/missing `dist/` ships a stale/blank UI.
2. `cargo build --release --target x86_64-pc-windows-gnu` (mingw linker from
   `.cargo/config.toml`). `tauri` has no custom-protocol feature toggling here.
3. `capabilities/default.json` (`windows:["main"]`, `permissions:["core:default"]`)
   is **required**: without it the compiled `capabilities.json` is `{}` and
   `plugin:event|listen` is denied — the frontend awaits its listeners in `boot()`
   → boot rejects → **blank page with only the header**. Plain app commands never
   needed permissions; core plugins do. Any new plugin (e.g. dialog for B4) must
   be added to this file.

### 9.2 Deploy

```bash
/mnt/c/Windows/System32/taskkill.exe /IM OpenDM.exe /F   # Windows locks running exes
./deploy.sh            # or ./deploy.sh --no-build to reuse the last artifacts
sha256sum target/x86_64-pc-windows-gnu/release/OpenDM.exe /mnt/c/Users/ludov/OpenDM/OpenDM.exe
```

deploy.sh: copies `OpenDM.exe`, `OpenDMMsgHost.exe`, `WebView2Loader.dll`;
mirrors `extension/` → `<dest>/extension` (rm -rf + cp -r); writes
`OpenDMMsgHost.json` when missing **or when the id in `ext_id.txt` changed**
(greps for `chrome-extension://$EXT_ID/`). Destination `/mnt/c/Users/ludov/OpenDM`
(override with `OPENDM_DEST`). Never touches user data.

### 9.3 Verification checklist for any change

- `npx tsc --noEmit` + `npm run build` in webui (must be clean)
- `cargo test -p opdm-core` (10 tests; host-only — the Windows target can't run tests)
- `cargo check --offline --target x86_64-pc-windows-gnu` (slow first time)
- deploy, checksums match, launch, F12 console clean, exercise the changed path
- backend diagnostics: `logs/engine.log` next to the exe

---

## 10. Known gaps / TODO map (see `TODO.md` too)

| Item | Meaning | Frontend flag |
|---|---|---|
| B1 | `parse_confirm` gains `folder: Option<String>` (both queue fns already take `folder`) | `CAP.saveToFolder` |
| B2 | `retry_job(id)`: state 5 → clear error → QUEUED → start (needs `clear_err` in job.rs) | `CAP.retry` |
| B3 | `job-added`/`job-removed` events → drop list poll to a 10 s safety net | – |
| B4 | tauri-plugin-dialog + capability entry; then real `api.pickFolder/pickFile` | `CAP.pickFolder` |
| B5 | settings fields (`max_concurrent`+semaphore, `speed_limit_kb`, `proxy`, cookies, post-process, `-o` template, notifications, restore-queue, auto-start) — `#[serde(default)]`; consider a struct arg for `save_settings` | the B5 CAPs |
| B6 | `remove_tool`, `set_tool_path`, `check_tool_update` | `toolRemove/toolCustomPath/toolLatestCheck` |
| B7 | single version source (WS ping hard-codes `"1.7.0"`) | – |
| B8 | `created_at` + final name/quality in `job_details`; ship extension as a Tauri resource | `CAP.extensionFolder` |

**Security stream (separate work, in `SECURITY_FIXES.md`, not applied):**
1. WS Origin/Host check — careful: the NM host sends **no Origin** (must stay
   allowed); the extension sends `Origin: chrome-extension://ojkooabcagmjbkllfemmfgaehhhcjhcg`.
2. Stop persisting cookies of finished jobs (`db.rs::persist` keeps them today).
3. App-data-dir migration.

Other facts that look like bugs but aren't (yet): `dl-log` unemitted (§5.2);
`integrate_takeover` stored but unused by the WS sink (§7); extension version
"1.7.0" vs app 1.0.0 (extension is self-versioned); `ui-state.json` leftover.

---

## 11. Gotchas that actually bit (do not rediscover these)

1. Frontend not rebuilt before cargo → stale/blank embedded UI (§9.1).
2. Missing `capabilities/default.json` → blank page, header only (§9.1).
3. Deploy while OpenDM.exe runs → "could not replace … is OpenDM.exe still
   running?" — taskkill first.
4. `save_settings` with missing args fails on the Rust side; partial updates don't
   exist — send all five fields from a validated draft (UI has an explicit Save
   bar, never per-keystroke saves).
5. Port change requires an app restart (WS listener bound once at startup) and the
   extension's port is separate `chrome.storage` — changing the app port does NOT
   reconfigure the extension (default 9100).
6. Event ids unknown to the UI are ignored (never upsert from `state` events) —
   the poll adds rows; upserting from events breaks reconciliation.
7. Parse `seq` is monotonic — always drop payloads with `seq <= current`, ack with
   a local bump (`cancelParse`).
8. yt-dlp job names lack extensions until merge; don't "fix" the ext heuristic by
   splitting on the last dot for `kind === 'ytdlp'`.
9. `react-resizable-panels` must stay on ^2 (v4 renamed `PanelGroup`/
   `PanelResizeHandle` → build breaks).
10. lucide-react icons: `Trash2`, `PackageX`, `ArrowUpCircle`, `Combine` etc. all
    exist in the installed version; check before importing new ones.
11. The extension ignores WS/NM replies; don't add request/response semantics on
    the WS channel without updating `background.js` `onmessage`.
12. `probeHls` fetches the page's own `.m3u8` with credentials — that's the design
    (quality menu), not a privacy issue; data stays between the site and the user.
13. Diagnostics live in `logs/engine.log` (Windows side), not stdout — the release
    exe is `windows_subsystem = "windows"` (no console).
14. `withGlobalTauri: true` is kept, but the frontend uses the npm
    `@tauri-apps/api` package — don't switch to `window.__TAURI__`.
