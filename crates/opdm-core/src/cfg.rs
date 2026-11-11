use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "d_port")]
    pub port: u16,
    #[serde(default = "d_segments")]
    pub max_segments: usize,
    #[serde(default = "d_dir")]
    pub download_dir: PathBuf,
    #[serde(default = "d_ua")]
    pub user_agent: String,
    #[serde(default = "d_true")]
    pub integrate_takeover: bool,
    /// yt-dlp release channel: stable | nightly | master
    #[serde(default = "d_channel")]
    pub ytdlp_channel: String,
}

fn d_port() -> u16 { 9100 }
fn d_segments() -> usize { 8 }
fn d_ua() -> String { "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36".into() }
fn d_true() -> bool { true }
fn d_channel() -> String { "stable".into() }
/// Default download folder: the OS user-Downloads directory
/// (SHGetKnownFolderPath on Windows, so OneDrive-redirected folders are respected).
fn d_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Downloads")))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Downloads")))
        .unwrap_or_else(|| app_dir().join("Downloads"))
}

impl Default for Settings {
    fn default() -> Self {
        Settings { port: d_port(), max_segments: d_segments(), download_dir: d_dir(), user_agent: d_ua(), integrate_takeover: true, ytdlp_channel: d_channel() }
    }
}

pub fn app_dir() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from(".")).parent().unwrap().to_path_buf()
}

pub fn settings_path() -> PathBuf { app_dir().join("OpenDM.json") }
pub fn jobs_path() -> PathBuf { app_dir().join("jobs.json") }

pub fn load() -> Settings {
    let old_default = app_dir().join("Downloads");
    let mut s = std::fs::read(settings_path()).ok()
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .unwrap_or_default();
    // migrate installations that still point at the old in-app default
    if s.download_dir == old_default {
        let d = d_dir();
        if d != old_default {
            s.download_dir = d;
            save(&s);
        }
    }
    s
}

pub fn save(s: &Settings) {
    let _ = std::fs::write(settings_path(), serde_json::to_vec_pretty(s).unwrap_or_default());
}

static SETTINGS: OnceLock<Mutex<Settings>> = OnceLock::new();

pub fn init() { SETTINGS.set(Mutex::new(load())).ok(); }

pub fn settings() -> Settings {
    // falls back to defaults when init() has not run yet (tests / lib consumers)
    match SETTINGS.get() {
        Some(m) => m.lock().unwrap().clone(),
        None => Settings::default(),
    }
}

pub fn update(f: impl FnOnce(&mut Settings)) {
    if let Some(m) = SETTINGS.get() {
        let mut g = m.lock().unwrap();
        f(&mut g);
        save(&g);
    }
}

pub fn name_ext_from_mime(mime: Option<&str>) -> &'static str {
    let m = match mime { Some(m) => m, None => return "" };
    match m.split(';').next().unwrap_or("").trim() {
        "application/pdf" => ".pdf",
        "application/zip" | "application/x-zip-compressed" | "application/x-zip" => ".zip",
        "application/x-7z-compressed" => ".7z",
        "application/x-rar-compressed" | "application/x-rar" | "application/vnd.rar" => ".rar",
        "application/gzip" | "application/x-gzip" => ".gz",
        "application/x-msdownload" | "application/x-dosexec" => ".exe",
        "application/x-msi" => ".msi",
        "application/json" => ".json",
        "application/xml" | "text/xml" => ".xml",
        "application/msword" => ".doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => ".docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => ".xlsx",
        "application/vnd.android.package-archive" => ".apk",
        "application/x-iso9660-image" | "application/x-iso" => ".iso",
        "application/x-bittorrent" | "application/torrent" => ".torrent",
        "application/epub+zip" => ".epub",
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        "image/bmp" => ".bmp",
        "video/mp4" => ".mp4",
        "video/webm" => ".webm",
        "video/quicktime" => ".mov",
        "video/x-msvideo" | "video/avi" => ".avi",
        "video/x-matroska" => ".mkv",
        "video/mpeg" => ".mpg",
        "audio/mpeg" | "audio/mp3" => ".mp3",
        "audio/mp4" | "audio/m4a" => ".m4a",
        "audio/x-wav" | "audio/wav" => ".wav",
        "audio/ogg" => ".ogg",
        "audio/flac" => ".flac",
        "audio/opus" => ".opus",
        "text/html" => ".html",
        "text/plain" => ".txt",
        "text/css" => ".css",
        _ => "",
    }
}
