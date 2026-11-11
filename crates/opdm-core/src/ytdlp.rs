//! YouTube pipeline backed by yt-dlp (mirrors imsyy/yt-dlp-gui):
//!   - external tool management (yt-dlp / Deno / FFmpeg+FFprobe): status,
//!     install, update — plain executables next to OpenDM.exe in `tools/`
//!   - parse stage: `yt-dlp -J` → metadata (title, duration, format rows)
//!   - download args: structured PROGRESS_JSON progress, Deno JS runtime,
//!     `--windows-filenames`, final path via `--print-to-file after_move:filepath`
//!
//! The extension only sends YouTube URLs; everything below runs in the engine.
use crate::cfg;
use crate::job::{self, JobCore};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/* ============ YouTube URL identity (repo: utils/url.ts) ============ */

/// The 11-char video id from watch / youtu.be / shorts / embed / live URLs.
pub fn youtube_id(url: &str) -> Option<String> {
    let u = url::Url::parse(url.trim()).ok()?;
    let host = u.host_str()?.to_ascii_lowercase();
    let is_yt = host == "youtu.be" || host == "youtube.com" || host == "youtube-nocookie.com"
        || host.ends_with(".youtube.com") || host.ends_with(".youtube-nocookie.com");
    if !is_yt {
        return None;
    }
    let path = u.path().to_string();
    if host == "youtu.be" && path.len() > 1 {
        return valid_id(path.trim_start_matches('/'));
    }
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.first() == Some(&"watch") {
        let v = u.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.to_string());
        if let Some(v) = valid_id(v.as_deref().unwrap_or("")) {
            return Some(v);
        }
        if segs.len() == 2 {
            return valid_id(segs[1]);
        }
    }
    if segs.len() == 2 && matches!(segs[0], "shorts" | "embed" | "live" | "v") {
        return valid_id(segs[1]);
    }
    None
}

fn valid_id(s: &str) -> Option<String> {
    if s.len() == 11 && s.chars().all(|c| char::is_alphanumeric(c) || matches!(c, '_' | '-')) {
        Some(s.to_string())
    } else {
        None
    }
}

/// Strip playlist-context params from a single-video URL so yt-dlp does not
/// expand the whole playlist (repo: normalizeDeepLinkVideoUrl — same params).
pub fn normalize_watch_url(url: &str) -> String {
    let Ok(mut u) = url::Url::parse(url.trim()) else { return url.to_string() };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let single = (host == "youtu.be" && u.path().len() > 1)
        || (u.path() == "/watch" && u.query_pairs().any(|(k, _)| k == "v"));
    if single {
        let kept: Vec<(String, String)> = u
            .query_pairs()
            .filter(|(k, _)| !matches!(k.as_ref(), "list" | "index" | "start_radio" | "playnext"))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        u.query_pairs_mut().clear();
        for (k, v) in kept {
            u.query_pairs_mut().append_pair(&k, &v);
        }
    }
    u.to_string()
}

/* ====== external tools (repo: external_tools) ====== */

pub const T_YTDLP: &str = "yt-dlp";
pub const T_DENO: &str = "deno";
pub const T_FFMPEG: &str = "ffmpeg";
pub const T_FFPROBE: &str = "ffprobe";
pub const TOOLS: [&str; 4] = [T_YTDLP, T_DENO, T_FFMPEG, T_FFPROBE];

#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolStatus {
    pub tool: String,
    pub installed: bool,
    pub runnable: bool,
    pub version: String,
    pub path: String,
    /// where the binary came from (repo parity: managed | system | local)
    pub source: String,
    pub is_managed: bool,
    pub can_update: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolProgress {
    pub tool: String,
    pub operation: String, // "install" | "update"
    pub stage: String,     // "downloading" | "installing" | "complete" | "error"
    pub percent: Option<f64>,
    pub error: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,      // "bytes" | "" (percent-only)
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
}

pub fn tools_dir() -> PathBuf {
    cfg::app_dir().join("tools")
}

pub fn tool_path(tool: &str) -> PathBuf {
    tools_dir().join(format!("{tool}.exe"))
}

/// Official release download URLs per platform/channel (repo: releases.rs).
pub fn ytdlp_url() -> String {
    let repo = match cfg::settings().ytdlp_channel.as_str() {
        "nightly" => "yt-dlp/yt-dlp-nightly-builds",
        "master" => "yt-dlp/yt-dlp-master-builds",
        _ => "yt-dlp/yt-dlp",
    };
    let asset = if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp_linux"
    };
    format!("https://github.com/{repo}/releases/latest/download/{asset}")
}

pub fn deno_url() -> String {
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    if cfg!(windows) {
        format!("https://github.com/denoland/deno/releases/latest/download/deno-{arch}-pc-windows-msvc.zip")
    } else if cfg!(target_os = "macos") {
        format!("https://github.com/denoland/deno/releases/latest/download/deno-{arch}-apple-darwin.zip")
    } else {
        format!("https://github.com/denoland/deno/releases/latest/download/deno-{arch}-unknown-linux-gnu.zip")
    }
}

/// ffmpeg-static ships ffmpeg and ffprobe as two separate binaries.
pub fn ffmpeg_urls() -> [(String, String); 2] {
    let plat = if cfg!(windows) {
        "win32-x64"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "darwin-arm64" } else { "darwin-x64" }
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else if cfg!(target_arch = "arm") {
        "linux-arm"
    } else {
        "linux-x64"
    };
    [("ffmpeg".into(), format!("https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-{plat}")),
     ("ffprobe".into(), format!("https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffprobe-{plat}"))]
}

fn spawn_cmd(program: &Path, args: &[impl AsRef<std::ffi::OsStr>]) -> Command {
    let mut c = Command::new(program);
    c.args(args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW — no console flash
    }
    c
}

/// Why a `--version` probe failed.
enum ProbeFailure {
    /// The time cap elapsed — a slowness artifact (cold PyInstaller start +
    /// Defender scan), NOT proof of a broken binary. Measured: `yt-dlp
    /// --version` takes ~4.2 s cold / ~0.2 s warm. Callers may retry.
    Timeout,
    Other(String),
}

impl std::fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeFailure::Timeout => write!(f, "timeout after 15 s (cold start?)"),
            ProbeFailure::Other(e) => write!(f, "{e}"),
        }
    }
}

/// Run `<tool> --version` with a bounded wait and return the trimmed first output line.
/// A hung binary must never stall the caller (boot once froze on the unbounded
/// `.output()` wait) — but the cap must be generous enough for a legitimate cold
/// start, and a timeout must not be reported as "broken" (see ProbeFailure::Timeout).
fn verify_executable(path: &Path, args: &[&str]) -> Result<String, ProbeFailure> {
    let mut child = spawn_cmd(path, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ProbeFailure::Other(format!("spawn: {e}")))?;
    // bounded wait: 300 × 50 ms = 15 s. `--version` output is tiny (<1 KB), so
    // the unread pipes cannot fill and deadlock the child while we poll.
    let mut status = None;
    for _ in 0..300 {
        match child.try_wait() {
            Ok(s) if s.is_some() => { status = s; break; }
            Ok(_) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => { let _ = child.kill(); return Err(ProbeFailure::Other(format!("wait: {e}"))); }
        }
    }
    let status = match status {
        Some(s) => s,
        None => {
            // kill without draining: the result is Err regardless, and if some
            // grandchild inherited the pipe handles, a drain here could block
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProbeFailure::Timeout);
        }
    };
    // drain the pipes after a natural exit — at EOF the read terminates
    let mut txt = String::new();
    let mut err = String::new();
    if let Some(mut s) = child.stdout.take() { let _ = s.read_to_string(&mut txt); }
    if let Some(mut s) = child.stderr.take() { let _ = s.read_to_string(&mut err); }
    let line = txt
        .lines()
        .find(|l| !l.trim().is_empty())
        .or_else(|| err.lines().find(|l| !l.trim().is_empty()))
        .unwrap_or("")
        .trim()
        .to_string();
    if status.success() && !line.is_empty() {
        Ok(line)
    } else if line.is_empty() {
        Err(ProbeFailure::Other(format!("exit {status}")))
    } else {
        Err(ProbeFailure::Other(line))
    }
}

/// Status of one managed tool. Returns `(status, probe_timed_out)` — a timeout
/// means "too slow right now", not "broken" (see ProbeFailure).
pub fn tool_status(tool: &str) -> (ToolStatus, bool) {
    let path = tool_path(tool);
    let t0 = Instant::now(); // diagnostics: probe cost per tool (debug builds only)
    let args: &[&str] = match tool {
        T_YTDLP | T_DENO => &["--version"],
        _ => &["-version"],
    };
    let describe = |installed: bool, runnable: bool, version: String| ToolStatus {
        tool: tool.into(),
        installed,
        runnable,
        version,
        path: path.to_string_lossy().to_string(),
        source: "managed".into(),
        is_managed: true,
        can_update: installed && runnable,
    };
    if path.is_file() {
        match verify_executable(&path, args) {
            Ok(v) => {
                crate::diag::info(&format!("tool-status {tool}: ok in {:?} version={v}", t0.elapsed()));
                (describe(true, true, v), false)
            }
            Err(e) => {
                crate::diag::info(&format!("tool-status {tool}: FAIL in {:?} error={e}", t0.elapsed()));
                (describe(true, false, String::new()), matches!(e, ProbeFailure::Timeout))
            }
        }
    } else {
        crate::diag::info(&format!("tool-status {tool}: missing at {}", path.display()));
        (describe(false, false, String::new()), false)
    }
}

/* Tool status is probed by running each managed binary with --version (bounded
   to 15 s each, see verify_executable). The four probes run in parallel and the
   result is cached for the app's lifetime: repeated callers (boot, the Settings
   tab, refreshes after installs) get an instant answer instead of re-spawning
   the binaries. Install/update flows invalidate the cache. A probe that merely
   hit the time cap is NOT cached — the next yt_status retries, so a transient
   cold-start slowness never pins a false "not runnable" for the whole session. */
static TOOL_CACHE: Mutex<Option<Vec<ToolStatus>>> = Mutex::new(None);

pub fn all_tool_status() -> Vec<ToolStatus> {
    if let Some(v) = TOOL_CACHE.lock().unwrap().as_ref() {
        return v.clone();
    }
    let handles: Vec<_> = TOOLS.iter().map(|t| {
        let t = *t;
        std::thread::Builder::new().name(format!("tool-status-{t}")).spawn(move || tool_status(t))
    }).collect();
    let mut list: Vec<ToolStatus> = Vec::new();
    let mut settled = true;
    for jh in handles.into_iter().flatten() {
        if let Ok((st, timed_out)) = jh.join() {
            if timed_out { settled = false; }
            list.push(st);
        }
    }
    if settled {
        *TOOL_CACHE.lock().unwrap() = Some(list.clone());
    }
    list
}

/// Forget the cached tool status — call when an install/update starts or ends.
pub fn invalidate_tool_cache() {
    *TOOL_CACHE.lock().unwrap() = None;
}

/// Stream `url` → `to`, reporting `(percent|-1, downloaded, total)` to the
/// callback as bytes land.
fn download_file(url: &str, to: &Path, on_progress: &dyn Fn(f64, u64, u64)) -> Result<(), String> {
    let agent = ureq::builder()
        .user_agent("OpenDM/1.7 (tool fetch)")
        .timeout_connect(Duration::from_secs(20))
        .timeout(Duration::from_secs(1800))
        .build();
    let resp = agent.get(url).call().map_err(|e| format!("GET {url}: {e}"))?;
    let total = resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut f = std::fs::File::create(to).map_err(|e| format!("create {}: {e}", to.display()))?;
    use std::io::Write;
    let mut buf = vec![0u8; 256 * 1024];
    let mut got = 0u64;
    let mut last_pct = -1.0f64;
    let start = Instant::now();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                f.write_all(&buf[..n]).map_err(|e| format!("write: {e}"))?;
                got += n as u64;
                if total > 0 {
                    let pct = (got as f64 / total as f64 * 100.0).min(100.0);
                    if pct - last_pct >= 1.0 {
                        last_pct = pct;
                        on_progress(pct, got, total);
                    }
                } else if got / (256 * 1024) % 64 == 0 && start.elapsed().as_secs() >= 2 {
                    on_progress(-1.0, got, 0);
                }
            }
            Err(e) => return Err(format!("read: {e}")),
        }
    }
    if total > 0 && got != total {
        return Err(format!("download truncated: {got}/{total} bytes"));
    }
    on_progress(100.0, got, total.max(got));
    Ok(())
}

fn emit_tool_progress(tool: &str, operation: &str, stage: &str, percent: Option<f64>, error: Option<String>) {
    emit_tool_progress_bytes(tool, operation, stage, percent, error, None, None)
}

/// Variant with byte accounting → Settings tool cards can show MB counters.
fn emit_tool_progress_bytes(tool: &str, operation: &str, stage: &str, percent: Option<f64>, error: Option<String>, downloaded: Option<u64>, total: Option<u64>) {
    if let Some(em) = emitter() {
        em("tool-update", json!(ToolProgress {
            tool: tool.into(),
            operation: operation.into(),
            stage: stage.into(),
            percent,
            error,
            kind: if total.is_some() { "bytes".into() } else { "".into() },
            downloaded,
            total,
        }));
    }
}

/// Install/update one tool, synchronously. Installing "ffmpeg" fetches both
/// ffmpeg and ffprobe (they are separate assets of the same release).
pub fn install_tool(tool: &str, operation: &str) -> Result<(), String> {
    let progress = |stage: &str, pct: Option<f64>| emit_tool_progress(tool, operation, stage, pct, None);
    let progress_bytes = |stage: &str, pct: Option<f64>, got: u64, tot: u64| {
        emit_tool_progress_bytes(tool, operation, stage, pct, None, Some(got), if tot > 0 { Some(tot) } else { None });
    };
    let mut temps: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<(), String> {
        progress("downloading", Some(0.0));
        match tool {
            T_YTDLP => {
                let exe = tool_path(T_YTDLP);
                let temp = exe.with_file_name("yt-dlp.exe.download");
                temps.push(temp.clone());
                download_file(&ytdlp_url(), &temp, &|p, got, tot| {
                    if p >= 0.0 {
                        progress_bytes("downloading", Some(p), got, tot);
                    }
                })?;
                progress("installing", None);
                // PyInstaller exes are only known-good once they actually run
                let _ = verify_executable(&temp, &["--version"]).map_err(|e| format!("yt-dlp not runnable: {e}"))?;
                std::fs::rename(&temp, &exe).map_err(|e| format!("replace yt-dlp: {e}"))?;
                progress("complete", Some(100.0));
                Ok(())
            }
            T_DENO => {
                let deno = tool_path(T_DENO);
                let zip = deno.with_file_name("deno.exe.download.zip");
                temps.push(zip.clone());
                download_file(&deno_url(), &zip, &|p, got, tot| {
                    if p >= 0.0 {
                        progress_bytes("downloading", Some(p), got, tot);
                    }
                })?;
                progress("installing", None);
                let tmp = deno_from_zip(&zip)?;
                temps.push(tmp.clone());
                let _ = verify_executable(&tmp, &["--version"]).map_err(|e| format!("deno not runnable: {e}"))?;
                std::fs::rename(&tmp, &deno).map_err(|e| format!("replace deno: {e}"))?;
                progress("complete", Some(100.0));
                Ok(())
            }
            T_FFMPEG | T_FFPROBE => {
                let urls = ffmpeg_urls();
                let mut done = 0usize;
                for (name, url) in urls.iter() {
                    let exe = tools_dir().join(format!("{name}.exe"));
                    let temp = tools_dir().join(format!("{name}.exe.download"));
                    temps.push(temp.clone());
                    download_file(url, &temp, &|p, got, tot| {
                        if p >= 0.0 {
                            progress_bytes("downloading", Some(done as f64 * 50.0 + p / 2.0), got, tot);
                        }
                    })?;
                    verify_if_local_tool(&temp, name)?;
                    std::fs::rename(&temp, &exe).map_err(|e| format!("replace {name}: {e}"))?;
                    done += 1;
                }
                let _ = verify_executable(&tool_path(T_FFMPEG), &["-version"]).map_err(|e| format!("ffmpeg not runnable: {e}"))?;
                progress("complete", Some(100.0));
                Ok(())
            }
            _ => Err(format!("unknown tool {tool}")),
        }
    })();
    for t in &temps {
        let _ = std::fs::remove_file(t);
    }
    result
}

fn verify_if_local_tool(temp: &Path, name: &str) -> Result<(), String> {
    let args: [&str; 1] = if name == "ffmpeg" { ["-version"] } else { ["-version"] };
    let out = spawn_cmd(temp, &args).output();
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(format!("{name}: exit {}", o.status)),
        Err(_) => Ok(()), // cannot verify mid-install on some AVs; not fatal
    }
}

fn deno_from_zip(zip: &Path) -> Result<PathBuf, String> {
    let f = std::fs::File::open(zip).map_err(|e| format!("open zip: {e}"))?;
    let mut ar = zip::ZipArchive::new(f).map_err(|e| format!("read zip: {e}"))?;
    for i in 0..ar.len() {
        let mut e = ar.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        if e.name().eq_ignore_ascii_case("deno.exe") {
            let mut out = Vec::with_capacity(64 * 1024 * 1024);
            std::io::copy(&mut e, &mut out).map_err(|e| format!("extract: {e}"))?;
            let tmp = zip.with_file_name("deno.verified.exe");
            std::fs::write(&tmp, &out).map_err(|e| format!("write deno: {e}"))?;
            return Ok(tmp);
        }
    }
    Err("deno.exe not found in zip".into())
}

/// Install runs in a thread so the UI stays responsive; progress rides `tool-update`.
pub fn install_async(tool: &str, operation: &str) {
    invalidate_tool_cache(); // the status changes while installing
    let tool = tool.to_string();
    let operation = operation.to_string();
    std::thread::Builder::new()
        .name(format!("tool-{operation}-{tool}"))
        .spawn(move || {
            if let Err(e) = install_tool(&tool, &operation) {
                emit_tool_progress(&tool, &operation, "error", None, Some(e));
            }
            invalidate_tool_cache(); // re-probe on the next yt_status
        })
        .ok();
}

/* ============ parse-state slot (sticky until the UI acks) ============ */

/// The parse page's payload. Set on every "send URL to OpenDM" (extension or
/// paste), replaced by each new send, and only cleared when the UI confirms or
/// cancels. Emitted on every change AND polled via `parse_state` — events can
/// be missed while the webview boots (window was hidden), polling cannot.
static PARSE: OnceLock<Mutex<ParseSlot>> = OnceLock::new();

struct ParseSlot { seq: u64, payload: Option<Value> }

fn parse_slot() -> &'static Mutex<ParseSlot> {
    PARSE.get_or_init(|| Mutex::new(ParseSlot { seq: 0, payload: None }))
}

pub fn parse_state_get() -> (u64, Option<Value>) {
    let g = parse_slot().lock().unwrap();
    (g.seq, g.payload.clone())
}

/// Ack/replace entry: the UI confirmed (Download) or cancelled the parse page,
/// or a bug report wants the slot gone. A new send can also replace it.
pub fn parse_state_clear() {
    let mut g = parse_slot().lock().unwrap();
    g.seq += 1;
    g.payload = None;
}

fn parse_state_set(v: Value) -> u64 {
    let mut vv = v;
    let seq = {
        let mut g = parse_slot().lock().unwrap();
        g.seq += 1;
        vv["seq"] = json!(g.seq);
        g.payload = Some(vv.clone());
        g.seq
    };
    // every change is broadcast — the app pops the window on this name
    if let Some(em) = emitter() {
        em("parse-state", vv);
    }
    seq
}

/// Emit without changing the slot (used internally by `parse_state_set`).
#[allow(dead_code)]
fn emit_parse_raw(payload: &Value) {
    if let Some(em) = emitter() {
        em("parse-state", payload.clone());
    }
}

fn parse_base() -> Value {
    let s = cfg::settings();
    json!({
        "kind": "",
        "status": "",
        "url": "",
        "filename": "",
        "folder": s.download_dir.to_string_lossy(),
        "cookies": Value::Null,
        "referer": Value::Null,
        "probe": Value::Null,
    })
}

/* ============ send entry points (called from the WS sink) ============ */

/// Everything the engine receives lands on the parse page first: YouTube runs
/// `yt-dlp -J` (metadata + quality rows); classic URLs get an instant entry
/// (editable filename) and a background HEAD probe for size/type.
pub fn from_send(url: &str, filename: Option<String>, referer: Option<String>, cookies: Option<String>) {
    if youtube_id(url).is_some() {
        crate::diag::info(&format!("parse: youtube url → yt-dlp -J ({})", normalize_watch_url(url)));
        yt_parse(url, cookies);
    } else {
        crate::diag::info(&format!("parse: classic url → review page ({})", url));
        classic_parse(url, filename, referer, cookies);
    }
}

fn yt_parse(url: &str, cookies: Option<String>) {
    let url = normalize_watch_url(url);
    {
        let mut v = parse_base();
        v["kind"] = "ytdlp".into();
        v["status"] = "parsing".into();
        if let Some(c) = &cookies { v["cookies"] = Value::String(c.clone()); }
        parse_state_set(v)
    };
    let probe_url = url.clone();
    std::thread::Builder::new().name("yt-parse".into()).spawn(move || {
        let payload = match parse_info(&probe_url, cookies.as_deref()) {
            Ok(info) => {
                let mut v = parse_base();
                v["kind"] = "ytdlp".into();
                v["status"] = "ready".into();
                v["url"] = info.url.clone().into();
                v["filename"] = info.title.clone().into();
                v["title"] = info.title.into();
                v["videoId"] = info.id.clone().into();
                v["duration"] = info.duration_secs.into();
                v["uploader"] = info.uploader.clone().into();
                v["thumbnail"] = info.thumbnail.clone().into();
                v["rows"] = serde_json::to_value(info.rows).unwrap_or(json!([]));
                if let Some(c) = cookies { v["cookies"] = c.into(); }
                v
            }
            Err(e) => {
                let mut v = parse_base();
                v["kind"] = "ytdlp".into();
                v["status"] = "error".into();
                v["error"] = e.clone().into();
                crate::diag::error(&format!("parse: yt-dlp -J failed for {probe_url} → {e}"));
                v
            }
        };
        if payload.get("status").and_then(|x| x.as_str()) == Some("ready") {
            let n = payload.get("rows").and_then(|r| r.as_array()).map(|a| a.len()).unwrap_or(0);
            crate::diag::info(&format!("parse: ready — {} quality rows, id={}", n, payload.get("videoId").and_then(|x| x.as_str()).unwrap_or("?")));
        }
        parse_state_set(payload.clone());
    }).ok();
}

fn classic_parse(url: &str, filename: Option<String>, referer: Option<String>, cookies: Option<String>) {
    let seq = {
        let mut v = parse_base();
        v["kind"] = "classic".into();
        v["status"] = "ready".into();
        v["url"] = Value::String(url.to_string());
        let suggested = filename.filter(|s| !s.trim().is_empty()).map(|s| s.to_string())
            .unwrap_or_else(|| url::Url::parse(url).ok()
                .map(|u| job::filename_from_url(Some(&u), &u.to_string()))
                .unwrap_or_else(|| "download".into()));
        v["filename"] = Value::String(job::sanitize_filename(&suggested));
        if let Some(r) = &referer { v["referer"] = Value::String(r.clone()); }
        if let Some(c) = &cookies { v["cookies"] = Value::String(c.clone()); }
        parse_state_set(v)
    };
    // background probe: size + type for the parse page (display only)
    let probe_url = url.to_string();
    let probe_referer = referer.clone();
    let probe_cookies = cookies.clone();
    std::thread::Builder::new().name("classic-probe".into()).spawn(move || {
        let agent = ureq::builder()
            .user_agent(&cfg::settings().user_agent)
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirects(5)
            .build();
        let mut req = agent.head(&probe_url);
        if let Some(r) = &probe_referer { req = req.set("Referer", r); }
        if let Some(c) = &probe_cookies { req = req.set("Cookie", c); }
        let Ok(resp) = req.call() else { return };
        // a newer send may have replaced the slot — only patch our own entry
        let (cur_seq, some) = parse_state_get();
        if cur_seq != seq || some.is_none() { return; }
        let mut v = some.unwrap();
        v["status"] = "ready".into();
        let mut probe = serde_json::Map::new();
        if let Some(n) = resp.header("Content-Length").and_then(|x| x.parse::<u64>().ok()) {
            probe.insert("totalBytes".into(), n.into());
        }
        if let Some(t) = resp.header("Content-Type") {
            probe.insert("type".into(), t.split(';').next().unwrap_or(t).trim().to_string().into());
        }
        let disp = resp.header("Content-Disposition").unwrap_or("").to_string();
        if !disp.is_empty() {
            probe.insert("disposition".into(), disp.clone().into());
            // Content-Disposition filename beats the URL-derived name
            if let Some(at) = disp.find("filename=") {
                let raw = disp[at + 9..].trim().trim_matches('"').trim_matches(';').trim().to_string();
                if !raw.is_empty() {
                    v["filename"] = job::sanitize_filename(&raw).into();
                }
            }
        }
        v["probe"] = Value::Object(probe);
        parse_state_set(v.clone());
    }).ok();
}

type Emitter = Arc<dyn Fn(&str, Value) + Send + Sync>;
static EMITTER: OnceLock<Emitter> = OnceLock::new();

pub fn set_emitter(f: Emitter) {
    let _ = EMITTER.set(f);
}
fn emitter() -> Option<&'static Emitter> {
    EMITTER.get()
}
/// dlm streams subprocess lines (`dl-log`) through the same bus.
pub fn emitter_pub() -> Option<&'static Emitter> {
    emitter()
}

/* ============ cookies (header string → Netscape file) ============ */

/// Write "a=b; c=d" + page host as a Netscape cookie file yt-dlp accepts.
pub(crate) fn write_netscape_cookies(header: &str, page_url: &str, path: &Path) -> bool {
    let host = url::Url::parse(page_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "youtube.com".into());
    let mut body = String::from("# Netscape HTTP Cookie File\n");
    for part in header.split(';') {
        let part = part.trim();
        let Some((n, v)) = part.split_once('=') else { continue };
        let n = n.trim();
        if n.is_empty() {
            continue;
        }
        body.push_str(&format!(".{host}\tTRUE\t/\tTRUE\t2147483647\t{n}\t{v}\n"));
    }
    if !body.contains('\t') {
        return false;
    }
    std::fs::write(path, body).is_ok()
}

pub(crate) fn cookies_to_file(header: Option<&str>, url: &str, dir: &Path, tag: &str) -> Option<PathBuf> {
    let f = dir.join(format!("OpenDM-{tag}.cookies.txt"));
    let ok = header
        .filter(|c| !c.trim().is_empty())
        .and_then(|c| if write_netscape_cookies(c, url, &f) { Some(()) } else { None })
        .is_some();
    if ok { Some(f) } else { None }
}

/* ============ arg builders (repo: arguments + output) ============ */

/// Enforce OUR deno (`--no-js-runtimes` first, like the repo) so yt-dlp's
/// auto-detected runtime cannot override the managed one.
fn js_runtime_args() -> Vec<String> {
    let deno = tool_path(T_DENO);
    if deno.is_file() {
        vec!["--no-js-runtimes".into(), "--js-runtimes".into(), format!("deno:{}", deno.to_string_lossy())]
    } else {
        vec![]
    }
}

fn ffmpeg_location_args() -> Vec<String> {
    let ff = tool_path(T_FFMPEG);
    if ff.is_file() {
        vec!["--ffmpeg-location".into(), tools_dir().to_string_lossy().to_string()]
    } else {
        vec![]
    }
}

fn base_tool_args() -> Vec<String> {
    let mut a = js_runtime_args();
    a.extend(ffmpeg_location_args());
    a
}

/// Parse stage args (repo: support.rs run_ytdlp_json_tracked).
pub fn parse_args(cookies_file: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = ["-J", "--ignore-config", "--color", "never", "--no-warnings", "--socket-timeout", "15", "--retries", "3", "--extractor-retries", "2"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.extend(base_tool_args());
    if let Some(f) = cookies_file {
        args.push("--cookies".into());
        args.push(f.to_string_lossy().to_string());
    }
    args
}

pub const DL_PROGRESS_TPL: &str = r#"download:PROGRESS_JSON:{"percent":"%(progress._percent_str|0%)s","speed":"%(progress._speed_str|)s","eta":"%(progress._eta_str|)s","downloaded":"%(progress._downloaded_bytes_str|)s","total":"%(progress._total_bytes_str|)s","status":"downloading"}"#;
pub const PP_PROGRESS_TPL: &str = r#"postprocess:PROGRESS_JSON:{"status":"postprocessing"}"#;

/// Download args (repo: commands/download/arguments.rs::build_download_args).
/// `fmt` = -f selector; empty = yt-dlp default (bestvideo*+bestaudio/best).
/// `name` = job name → output template `<name>.%(ext)s` (rename support).
pub fn download_args(fmt: &str, name: &str, cookies_file: Option<&Path>, filepath_file: &Path, folder: &Path) -> Vec<String> {
    let mut args: Vec<String> = ["--newline", "--ignore-config", "--color", "never", "--progress-template", DL_PROGRESS_TPL, "--progress-template", PP_PROGRESS_TPL, "--progress-delta", "1"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.extend(base_tool_args());
    if let Some(f) = cookies_file {
        args.push("--cookies".into());
        args.push(f.to_string_lossy().to_string());
    }
    if !fmt.is_empty() {
        args.push("-f".into());
        args.push(fmt.into());
    }
    args.push("-P".into());
    args.push(folder.to_string_lossy().to_string());
    if !name.trim().is_empty() {
        // deterministic rename: sanitized job name + yt-dlp picked container.
        // '%' is stripped — it's the template escape char for yt-dlp output templates.
        args.push("--output".into());
        args.push(format!("{}.%(ext)s", name.replace('%', "")));
    }
    args.push("--windows-filenames".into());
    args.push("--no-overwrites".into());
    args.push("--concurrent-fragments".into());
    args.push(cfg::settings().max_segments.min(16).to_string());
    // final filesystem path once the merge moved it — this names the job row
    args.push("--print-to-file".into());
    args.push("after_move:filepath".into());
    args.push(filepath_file.to_string_lossy().to_string());
    args
}

/* ============ parse stage ============ */

#[derive(Debug, Clone, serde::Serialize)]
pub struct FormatRow {
    pub v: Option<String>, // video format id
    pub a: Option<String>, // companion audio format id
    pub label: String,
    pub height: u32,
    pub fps: u32,
    pub note: String, // "best" | "muxed" | "video" | "audio"
    /// approximate total transfer size in bytes (video+audio for merges); 0 = unknown
    pub size: u64,
    /// true when the size is an estimate (yt-dlp filesize_approx, not exact)
    pub approx: bool,
}

/// filesize || filesize_approx of one `-J` format → (bytes, approx).
fn fmt_bytes_of(f: &Value) -> (u64, bool) {
    if let Some(n) = f.get("filesize").and_then(|x| x.as_u64()) { return (n, false); }
    if let Some(n) = f.get("filesize_approx").and_then(|x| x.as_u64()) { return (n, true); }
    (0, false)
}

#[derive(Debug, Clone)]
pub struct YtInfo {
    pub url: String,
    pub title: String,
    pub id: String,
    pub duration_secs: u64,
    pub uploader: String,
    pub thumbnail: String,
    pub rows: Vec<FormatRow>,
}

/// "2.50MiB"/"805.9KiB"/"1.05GB"/"33.12MiB/s" → bytes (yt-dlp human units).
pub fn fmt_size(s: &str) -> u64 {
    let t = s.trim();
    let cut = t.find(|c: char| c.is_alphabetic()).unwrap_or(t.len());
    let v: f64 = t[..cut].trim().parse().unwrap_or(0.0);
    let unit = t[cut..].trim().to_ascii_lowercase();
    let unit = unit.split('/').next().unwrap_or("").trim(); // strip "/s" on speeds
    let mult = match unit {
        "kb" => 1000.0, "mb" => 1000.0 * 1000.0, "gb" => 1e9,
        "kib" => 1024.0, "mib" => 1024.0 * 1024.0, "gib" => 1024.0f64 * 1024.0 * 1024.0,
        "tib" => 1024.0f64 * 1024.0 * 1024.0 * 1024.0,
        "b" => 1.0,
        _ => 0.0, // unknown unit (N/A, ~) → zero speed, not 1.0
    };
    (v * mult) as u64
}

fn fnum(f: &Value, key: &str) -> u32 {
    f.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0) as u32
}

/// Reduce a `-J` payload into dialog rows (best first; one row per height).
pub fn reduce_info(info: &Value) -> YtInfo {
    let title = info.get("title").and_then(|t| t.as_str()).unwrap_or("YouTube video").to_string();
    let id = info.get("id").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let dur = info.get("duration").and_then(|t| t.as_f64()).unwrap_or(0.0) as u64;
    let uploader = info.get("uploader").or_else(|| info.get("channel")).and_then(|t| t.as_str()).unwrap_or("").to_string();
    let thumb = info.get("thumbnail").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let url = info.get("webpage_url").and_then(|t| t.as_str()).unwrap_or("").to_string();

    let mut rows = vec![FormatRow { v: None, a: None, label: "Best quality (recommended)".into(), height: 0, fps: 0, note: "best".into(), size: 0, approx: false }];

    let fmts = info.get("formats").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    let mut audio_best: Option<(u32, String, u64, bool)> = None; // (abr, id, bytes, approx)
    let mut muxed_by_h: std::collections::BTreeMap<u32, (u32, String, u64, bool)> = std::collections::BTreeMap::new();
    let mut vonly_by_h: std::collections::BTreeMap<u32, (u32, String, u64, bool)> = std::collections::BTreeMap::new();
    for f in &fmts {
        let vc = f.get("vcodec").and_then(|x| x.as_str()).unwrap_or("none");
        let ac = f.get("acodec").and_then(|x| x.as_str()).unwrap_or("none");
        let fid = f.get("format_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if fid.is_empty() || vc == "none" && ac == "none" {
            continue;
        }
        let (bytes, approx) = fmt_bytes_of(f);
        if vc == "none" {
            let abr = f.get("abr").and_then(|x| x.as_f64()).unwrap_or(0.0) as u32;
            if audio_best.as_ref().map(|(a, _, _, _)| abr > *a).unwrap_or(true) {
                audio_best = Some((abr, fid, bytes, approx));
            }
        } else {
            let h = fnum(f, "height");
            if h == 0 {
                continue;
            }
            let fps = fnum(f, "fps");
            if ac != "none" {
                // muxed: prefer higher fps at the same height
                let e = muxed_by_h.entry(h).or_insert((0, String::new(), 0, false));
                if fps >= e.0 {
                    *e = (fps, fid, bytes, approx);
                }
            } else {
                let e = vonly_by_h.entry(h).or_insert((0, String::new(), 0, false));
                if fps >= e.0 {
                    *e = (fps, fid, bytes, approx);
                }
            }
        }
    }
    // muxed (single file) high→low; a muxed row at a height makes the
    // video-only row at that height redundant (same picture, no merge)
    for (h, (_, fid, bytes, approx)) in muxed_by_h.iter().rev() {
        rows.push(FormatRow { v: Some(fid.clone()), a: None, label: format!("{h}p — single file (mp4)"), height: *h, fps: 0, note: "muxed".into(), size: *bytes, approx: *approx });
    }
    // video-only rows: size = video + best audio (this is what yt-dlp fetches)
    if let Some((_abr, ref afid, abytes, aapprox)) = audio_best {
        for (h, (_, fid, bytes, approx)) in vonly_by_h.iter().rev() {
            if muxed_by_h.contains_key(h) { continue; }
            rows.push(FormatRow {
                v: Some(fid.clone()),
                a: Some(afid.clone()),
                label: format!("{h}p — video only (merges best audio)"),
                height: *h,
                fps: 0,
                note: "video".into(),
                size: bytes + abytes,
                approx: *approx || aapprox,
            });
        }
    }
    if let Some((abr, fid, bytes, approx)) = audio_best {
        let tag = if abr > 0 { format!("{abr}kbps m4a") } else { "best audio".to_string() };
        rows.push(FormatRow { v: None, a: Some(fid), label: format!("Audio only — {tag}"), height: 0, fps: 0, note: "audio".into(), size: bytes, approx });
    }
    YtInfo { url, title, id, duration_secs: dur, uploader, thumbnail: thumb, rows }
}

fn parse_cookie_dir() -> PathBuf {
    cfg::app_dir().join("tmp")
}

fn err_tail(s: &str, n: usize) -> String {
    let line = s.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("yt-dlp failed");
    let line = line.trim();
    line.chars().take(n).collect()
}

/// Parse stage: run `yt-dlp -J` on a watch URL (spawn in a thread).
pub fn parse_info(url: &str, cookies: Option<&str>) -> Result<YtInfo, String> {
    let yt = tool_path(T_YTDLP);
    if !yt.is_file() {
        return Err("yt-dlp is not installed — open Settings → YouTube tools and download it".into());
    }
    let dir = parse_cookie_dir();
    let _ = std::fs::create_dir_all(&dir);
    let kept = cookies_to_file(cookies, url, &dir, "parse");
    let mut args = parse_args(kept.as_deref());
    args.push(normalize_watch_url(url));
    let out = spawn_cmd(&yt, &args).output().map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if let Some(f) = kept {
        let _ = std::fs::remove_file(f);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || stdout.trim().is_empty() {
        return Err(err_tail(&stderr, 300));
    }
    // plain-text lines can precede the JSON; take everything from the first '{'
    let at = stdout.find('{').ok_or("no JSON in yt-dlp output")?;
    let v: Value = serde_json::from_str(stdout[at..].trim()).map_err(|e| format!("bad json from yt-dlp: {e}"))?;
    let info = reduce_info(&v);
    if info.id.is_empty() {
        return Err("yt-dlp returned no video id (playlist? private? age-restricted?)".into());
    }
    if !info.url.is_empty() {
        return Ok(YtInfo { url: normalize_watch_url(&info.url), ..info });
    }
    Ok(info)
}

/* ============ progress parsing (dlm runner calls these) ============ */

/// Line-shape: `download:PROGRESS_JSON:{...}` / `postprocess:PROGRESS_JSON:{...}`.
/// Returns (postprocess?, json).
pub fn parse_progress(line: &str) -> Option<(bool, Value)> {
    let at = line.find("PROGRESS_JSON:")?;
    let v: Value = serde_json::from_str(line[at + "PROGRESS_JSON:".len()..].trim()).ok()?;
    Some((line.starts_with("postprocess"), v))
}

/// Apply one parsed progress event to the job: stores into the atomics AND
/// returns (done, total, speed_bps) for the caller's Ev::Progress. Bytes when
/// yt-dlp knows both; else percent mode over a virtual 100000.
pub fn apply_progress(jc: &JobCore, postprocess: bool, v: &Value) -> (u64, u64, f64) {
    if postprocess {
        *jc.stage.lock().unwrap() = "merging".into();
        return (jc.done(), jc.total(), 0.0);
    }
    if *jc.stage.lock().unwrap() == "merging" {
        return (jc.done(), jc.total(), 0.0); // post-processing already; ignore late lines
    }
    *jc.stage.lock().unwrap() = "downloading".into();
    let pct = v
        .get("percent")
        .and_then(|x| x.as_str())
        .and_then(|s| s.trim().trim_end_matches('%').trim().parse::<f64>().ok())
        .unwrap_or(0.0);
    let speed = v.get("speed").and_then(|x| x.as_str()).map(fmt_size).unwrap_or(0);
    let done_b = v.get("downloaded").and_then(|x| x.as_str()).map(fmt_size).unwrap_or(0);
    let tot_b = v.get("total").and_then(|x| x.as_str()).map(fmt_size).unwrap_or(0);
    let (done, total) = if done_b > 0 && tot_b > 0 && tot_b >= done_b {
        (done_b, tot_b)
    } else {
        ((pct * 1000.0) as u64, 100_000)
    };
    if total > 0 {
        jc.total.store(total, Ordering::Relaxed);
    }
    jc.done.store(done, Ordering::Relaxed);
    jc.speed_bits.store(speed, Ordering::Relaxed);
    (done, total, speed as f64)
}
