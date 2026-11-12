// Capability flags: unsupported controls render only `if (CAP.x)`. When a backend
// addition ships (docs/MIGRATE_TO_NEW_FRONTEND.md §10), flip the flag and wire the
// call in lib/tauri.ts — do not delete the UI code.
// restoreQueue / cli are extra flags beyond the doc's list, same idea.
// (autoDownload is NOT gated: it is a real backend setting since the batch
// feature — cfg.rs auto_download, toggled on the New page and in Settings.)
export const CAP = {
  retry: false,            // B2: retry_job
  saveToFolder: false,     // B1: parse_confirm folder argument
  pickFolder: false,       // B4: tauri-plugin-dialog + capabilities
  maxConcurrent: false,    // B5: settings + Engine semaphore
  fragmentThreads: false,  // B5: --concurrent-fragments
  speedLimit: false,       // B5: --limit-rate
  proxy: false,            // B5: --proxy
  cookies: false,          // B5: cookie settings
  postProcess: false,      // B5: re-encode / embeds
  filenameTemplate: false, // B5: -o template
  notifications: false,    // B5: notification plugin
  plugins: false,          // plugin manager commands
  toolRemove: false,       // B6: remove_tool
  toolCustomPath: false,   // B6: set_tool_path
  toolLatestCheck: false,  // B6: check_tool_update
  appUpdate: false,        // updater plugin
  extensionFolder: false,  // B8/§10: bundled extension resources
  restoreQueue: false,     // B5: re-enqueue unfinished jobs at launch
  cli: false,              // tauri-plugin-cli
}
