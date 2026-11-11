# TODO — backend additions that unlock hidden UI controls

The frontend hides unsupported controls behind capability flags
(`crates/opdm-app/webui/src/lib/capabilities.ts`), following
`docs/MIGRATE_TO_NEW_FRONTEND.md` §8/§10. Do not delete the UI code: implement the
backend addition below, flip the flag, and wire the call in `webui/src/lib/tauri.ts`.

| Flag | Backend addition | What to implement |
|---|---|---|
| `CAP.retry` | **B2** | `retry_job(id)`: if state is 5 → clear error, set ST_QUEUED, engine().start(jc) (keep fmtsel for yt-dlp). `job.rs` needs `clear_err`. |
| `CAP.saveToFolder` | **B1** | `parse_confirm` gains `folder: Option<String>` → pass to `queue(...)` / `queue_ytdlp(...)` (both already take `folder`). |
| `CAP.pickFolder` | **B4** | `tauri-plugin-dialog = "2"`, `.plugin(tauri_plugin_dialog::init())`, `capabilities/default.json` with `core:default` + `dialog:default`; frontend uses `@tauri-apps/plugin-dialog`. Then replace `api.pickFolder/pickFile` stubs. |
| `CAP.maxConcurrent` / `CAP.fragmentThreads` / `CAP.speedLimit` / `CAP.proxy` / `CAP.cookies` / `CAP.postProcess` / `CAP.filenameTemplate` / `CAP.notifications` / `CAP.restoreQueue` / `CAP.autoStart` | **B5** | Settings fields + engine behavior (semaphore, --limit-rate, --proxy, cookies, post-process flags, -o template). Keep `#[serde(default)]`; make `save_settings` accept a struct instead of 5 positional args. |
| `CAP.toolRemove` / `CAP.toolCustomPath` / `CAP.toolLatestCheck` | **B6** | `remove_tool`, `set_tool_path`, `check_tool_update` (GitHub releases API). Then wire `api.removeTool/checkTool/setToolPath` to real commands. |
| `CAP.appUpdate` | — | tauri-plugin-updater; wire `api.checkAppUpdate`. |
| `CAP.extensionFolder` | **B8/§10** | Ship the extension folder as a Tauri resource; `open_extension_folder` copies it to app data first. |
| `CAP.plugins` | — | Plugin manager commands (`list_plugins`/`install_plugin`/`remove_plugin`) per docs/SETTINGS_PAGE.md §3. |
| `CAP.cli` | — | tauri-plugin-cli (`--url`, `--cookies`, `--dir`, …); second invocation forwards to the running instance. |

Also worth doing (from docs/MIGRATE_TO_NEW_FRONTEND.md §10/§12):

- **B3**: emit `job-added`/`job-removed` and drop list polling to a 10 s safety net.
- **B7**: one version source — the WS `ping` reply currently hard-codes `"1.7.0"`; use `env!("CARGO_PKG_VERSION")`.
- **B8**: `created_at` in `JobCore`/`DbJob` + final file name / quality in `job_details` so the details panel can show real "Added"/"Quality" values and Open works without guessing.
- **SECURITY_FIXES.md** (separate work stream): WS Origin/Host check, stop persisting cookies of finished jobs, app-data-dir migration, remove stray `crates/opdm-app/ui/` + root `src/` (already removed here).
