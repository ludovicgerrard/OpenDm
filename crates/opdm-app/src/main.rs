// OpenDM — Tauri app (Rust backend) + browser-capture WebSocket + IPC commands
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use opdm_core::{cfg, db, diag, dlm, wssrv, ytdlp};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            cfg::init();
            diag::init(&cfg::app_dir());
            diag::info(&format!("boot: engine up, download dir={}", cfg::settings().download_dir.to_string_lossy()));
            let settings = cfg::settings();
            let _ = std::fs::create_dir_all(&settings.download_dir); // self-heal empty first run
            let cfg_arc: Arc<Mutex<cfg::Settings>> = Arc::new(Mutex::new(settings));
            let (tx, rx) = mpsc::channel::<dlm::Ev>();
            dlm::Engine::init(cfg_arc, tx);
            let eng = dlm::engine();

            db::load_into(eng);
            eng.persist();

            // ---- yt-dlp event bus: tool installs + YouTube parse stage → webview ----
            // Registered before the WS sink so an extension-sent YouTube URL that
            // arrives instantly still finds the emitters attached.
            let handle = app.handle().clone();
            ytdlp::set_emitter(Arc::new(move |event: &str, payload: Value| {
                let _ = handle.emit(event, &payload);
                // the parse page lives in the webview: bring the main window
                // up whenever a new download lands on the parse stage
                if event == "parse-state" {
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }));

            // ---- WebSocket sink: extension commands → engine / window ----
            struct Sink { app: tauri::AppHandle }
            impl wssrv::WsSink for Sink {
                fn cmd(&self, c: wssrv::WsCmd) -> Value {
                    match c {
                        wssrv::WsCmd::Ping => json!({"ok": true, "app": "OpenDM", "version": "1.7.0"}),
                        wssrv::WsCmd::Show => {
                            if let Some(w) = self.app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            json!({"ok": true})
                        }
                        wssrv::WsCmd::Add { url, referer, filename, cookies, .. } => {
                            // every kind lands on the parse page first (review,
                            // rename, pick a quality) — the queued download starts
                            // from the UI's Download button
                            if url::Url::parse(&url).is_err() {
                                return json!({"ok": false, "error": "invalid url"});
                            }
                            // extension click parity with Show: bring the window
                            // up right away so the parse page is visible, then
                            // parse (the page reacts to parse-state events)
                            if let Some(w) = self.app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            diag::info(&format!("ws add: url from extension, host={}", url::Url::parse(&url).ok().and_then(|u| u.host_str().map(|s| s.to_string())).unwrap_or_else(|| "?".into())));
                            ytdlp::from_send(&url, filename, referer, cookies);
                            json!({"ok": true, "parse": true})
                        }
                    }
                }
            }
            let handle = app.handle().clone();
            let port = cfg::settings().port;
            let sink: Arc<dyn wssrv::WsSink> = Arc::new(Sink { app: handle });
            std::thread::Builder::new().name("ws-accept".into()).spawn(move || {
                let _ = wssrv::spawn(port, sink);
            }).ok();

            // ---- Engine event pump → webview ----
            let handle = app.handle().clone();
            std::thread::Builder::new().name("ev-pump".into()).spawn(move || {
                for ev in rx {
                    let payload = match &ev {
                        dlm::Ev::Progress { id, done, total, speed } => {
                            json!({"type": "progress", "id": id, "done": done, "total": total, "speed": speed})
                        }
                        dlm::Ev::State { id, state, name, error } => {
                            json!({"type": "state", "id": id, "state": state, "name": name, "error": error})
                        }
                    };
                    let _ = handle.emit("job-update", &payload);
                }
            }).ok();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_download, list_jobs, job_details, pause_job, resume_job, stop_job, remove_job,
            open_folder, open_file, get_settings, save_settings,
            yt_status, yt_install_tool, set_ytdlp_channel, yt_log,
            parse_state, parse_clear, parse_confirm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/* ---------------- helpers ---------------- */

fn jobs_json() -> Value {
    let eng = dlm::engine();
    let arr: Vec<Value> = eng.list().into_iter().map(|li| {
        json!({
            "id": li.id,
            "url": li.url,
            "name": li.name,
            "folder": li.folder.to_string_lossy(),
            "state": li.row.state,
            "done": li.row.done,
            "total": li.row.total,
            "speed": li.row.speed,
            "error": li.error,
            "kind": li.kind,
            "stage": li.stage,
        })
    }).collect();
    json!(arr)
}

fn spawn_open(p: &PathBuf) -> Result<(), String> {
    // explorer.exe is a GUI program: no console flash. For folders it opens a
    // window; for files it runs the default "open" association via ShellExecute.
    #[cfg(target_os = "windows")]
    {
        if p.is_dir() {
            std::fs::create_dir_all(p).ok(); // self-heal missing Downloads
        }
        std::process::Command::new("explorer")
            .arg(p)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/* ---------------- commands ---------------- */

#[tauri::command(rename_all = "camelCase")]
fn add_download(url: String, referer: Option<String>, filename: Option<String>) -> Result<String, String> {
    if url::Url::parse(url.trim()).is_err() {
        return Err("invalid url".into());
    }
    // pasted URLs land on the parse page too (review/rename before downloading)
    ytdlp::from_send(url.trim(), filename, referer, None);
    Ok("parse".into())
}

#[tauri::command]
fn list_jobs() -> Value { jobs_json() }

#[tauri::command]
fn pause_job(id: String) {
    if let Some(j) = dlm::engine().find(&id) { dlm::engine().pause(j) }
}

#[tauri::command]
fn resume_job(id: String) {
    if let Some(j) = dlm::engine().find(&id) { dlm::engine().resume(j) }
}

#[tauri::command]
fn stop_job(id: String) {
    if let Some(j) = dlm::engine().find(&id) { dlm::engine().stop(j) }
}

#[tauri::command(rename_all = "camelCase")]
fn remove_job(id: String, del_files: bool) {
    if let Some(j) = dlm::engine().find(&id) { dlm::engine().remove(j, del_files) }
}

/// Full detail of one job, incl. per-segment progress for the details panel
/// (dlman-style segment visualization).
#[tauri::command]
fn job_details(id: String) -> Option<Value> {
    let jc = dlm::engine().find(&id)?;
    let meta = &jc.meta;
    let speed = f64::from_bits(jc.speed_bits());
    let kind = jc.kind.lock().unwrap().clone();
    let stage = jc.stage.lock().unwrap().clone();

    // per-segment view (ytdlp jobs have none — yt-dlp manages its own pieces)
    let segs: Vec<Value>;
    let mut hls = None;
    if kind == "ytdlp" {
        segs = Vec::new();
    } else if kind == "hls" {
        segs = Vec::new();
        // plan + finished segs live under the parts dir (removed after merge)
        let dir = jc.parts_dir();
        if let Ok(raw) = std::fs::read(dir.join("meta.json")) {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) {
                let total = v.get("segs").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0);
                if total > 0 {
                    let mut done = 0usize;
                    for i in 0..total { if dir.join(format!("seg{i}.part")).exists() { done += 1; } }
                    hls = Some(json!({ "total": total, "done": done }));
                }
            }
        }
    } else {
        segs = jc.segs.lock().unwrap().iter().enumerate().map(|(idx, s)| {
            let span = s.end.saturating_sub(s.start).max(1);
            json!({
                "idx": idx,
                "frac": if s.done { 1.0 } else { s.pos.saturating_sub(s.start) as f64 / span as f64 },
                "done": s.done,
            })
        }).collect();
    }

    Some(json!({
        "id": meta.id,
        "url": meta.url,
        "referer": meta.referer,
        "cookiesSent": meta.cookies.is_some(),
        "folder": meta.folder.to_string_lossy(),
        "name": jc.name(),
        "state": jc.state(),
        "done": jc.done(),
        "total": jc.total(),
        "speed": speed,
        "error": jc.error(),
        "kind": if kind.is_empty() { "range" } else { kind.as_str() },
        "stage": stage,
        "segs": segs,
        "hls": hls,
    }))
}

#[tauri::command]
fn open_folder(id: Option<String>) -> Result<(), String> {
    let p = id
        .and_then(|i| dlm::engine().find(&i))
        .map(|j| j.meta.folder.clone())
        .unwrap_or_else(|| cfg::settings().download_dir);
    spawn_open(&p)
}

#[tauri::command]
fn open_file(id: String) -> Result<(), String> {
    let (folder, name) = dlm::engine()
        .find(&id)
        .map(|j| (j.meta.folder.clone(), j.name()))
        .ok_or("not found")?;
    spawn_open(&folder.join(name))
}

#[tauri::command]
fn get_settings() -> Value {
    let s = cfg::settings();
    json!({
        "port": s.port,
        "max_segments": s.max_segments,
        "download_dir": s.download_dir.to_string_lossy(),
        "user_agent": s.user_agent,
        "integrate_takeover": s.integrate_takeover,
        "ytdlp_channel": s.ytdlp_channel,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn save_settings(port: u16, max_segments: usize, download_dir: String, user_agent: String, integrate_takeover: bool) {
    let dir = PathBuf::from(download_dir);
    let _ = std::fs::create_dir_all(&dir);
    cfg::update(|s| {
        if port > 0 { s.port = port; }
        s.max_segments = max_segments.clamp(1, 16);
        s.download_dir = dir;
        s.user_agent = user_agent;
        s.integrate_takeover = integrate_takeover;
    });
}

/* ---------------- YouTube pipeline commands ---------------- */

/// Status of the managed tools (yt-dlp / Deno / FFmpeg+FFprobe) + channel.
#[tauri::command]
fn yt_status() -> Value {
    json!({
        "tools": ytdlp::all_tool_status(),
        "channel": cfg::settings().ytdlp_channel,
    })
}

/// Install or update a managed tool. Progress rides the `tool-update` event.
#[tauri::command]
fn yt_install_tool(tool: String, operation: Option<String>) -> Result<(), String> {
    if !ytdlp::TOOLS.contains(&tool.as_str()) {
        return Err(format!("unknown tool {tool}"));
    }
    let operation = operation.filter(|o| o == "install" || o == "update").unwrap_or_else(|| "install".into());
    ytdlp::install_async(&tool, &operation);
    Ok(())
}

/// yt-dlp release channel: stable | nightly | master (applies on next install/update).
#[tauri::command]
fn set_ytdlp_channel(channel: String) -> Result<(), String> {
    match channel.as_str() {
        "stable" | "nightly" | "master" => {
            cfg::update(|s| s.ytdlp_channel = channel.clone());
            Ok(())
        }
        _ => Err("channel must be stable, nightly or master".into()),
    }
}

/// Poll: current parse-state slot (seq, payload). Falls back when a Tauri
/// event fired before the webview finished loading.
#[tauri::command]
fn parse_state() -> Value {
    let (seq, p) = ytdlp::parse_state_get();
    json!({ "seq": seq, "payload": p })
}

/// Cancel/ack the parse page: the slot is cleared so stale entries never
/// reappear after a restart.
#[tauri::command]
fn parse_clear() {
    ytdlp::parse_state_clear();
}

/// The parse page's Download button: queue either kind of job.
#[tauri::command(rename_all = "camelCase")]
fn parse_confirm(url: String, kind: String, filename: Option<String>, fmt: Option<String>, referer: Option<String>, cookies: Option<String>) -> Result<String, String> {
    ytdlp::parse_state_clear(); // ack — page closes, slot freed
    if kind == "ytdlp" {
        Ok(dlm::engine().queue_ytdlp(
            &url,
            filename.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "YouTube video".into()),
            fmt.as_deref().unwrap_or(""),
            cookies.filter(|c| !c.trim().is_empty()),
            None, // keep the default download folder (cfg.download_dir)
        ))
    } else {
        dlm::engine().queue(&url, referer, filename, None, cookies).ok_or_else(|| "invalid url".to_string())
    }
}

/// yt-dlp subprocess log of one job (details-dock collapsible log).
#[tauri::command]
fn yt_log(id: String) -> Option<String> {
    dlm::engine().yt_log(&id)
}
