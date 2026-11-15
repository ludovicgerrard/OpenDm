use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const ST_QUEUED: u32 = 1;
pub const ST_RUNNING: u32 = 2;
pub const ST_PAUSED: u32 = 3;
pub const ST_DONE: u32 = 4;
pub const ST_ERROR: u32 = 5;

#[derive(Debug, Clone, Copy)]
pub struct Seg { pub start: u64, pub end: u64, pub pos: u64, pub done: bool }

/// Immutable identity fields of a download.
#[derive(Debug, Clone, Serialize)]
pub struct UrlJob {
    pub id: String,
    pub url: String,
    pub referer: Option<String>,
    pub cookies: Option<String>,
    pub folder: PathBuf,
}

/// Mutable, thread-shared runtime state.
pub struct JobCore {
    pub meta: UrlJob,
    name: Mutex<String>,
    resolved: Mutex<Option<String>>,
    pub state: AtomicU32,
    pub pause: AtomicBool,
    pub cancel: AtomicBool,
    pub done: AtomicU64,
    pub total: AtomicU64,
    pub speed_bits: AtomicU64,
    pub segs: Mutex<Vec<Seg>>,
    /// "" classic ranged | "hls" | "ytdlp" (yt-dlp pipeline).
    pub kind: Mutex<String>,
    /// ytdlp only: "-f" selector chosen in the parse dialog ("" = yt-dlp default).
    pub fmtsel: Mutex<String>,
    /// ytdlp display stage: "" | "downloading" | "merging".
    pub stage: Mutex<String>,
    /// Output paths seen on ytdlp stdout (for residual cleanup on remove).
    pub outs: Mutex<Vec<String>>,
    err: Mutex<Option<String>>,
}

impl JobCore {
    pub fn new(url: String, referer: Option<String>, cookies: Option<String>, folder: PathBuf, filename: String) -> Arc<JobCore> {
        let meta = UrlJob { id: uuid(), url, referer, cookies, folder };
        Arc::new(JobCore::core(meta, filename))
    }

    /// Reconstruct a job from persisted state (db.rs restore).
    pub fn new_for_restore(id: String, url: String, referer: Option<String>, cookies: Option<String>, folder: PathBuf, filename: String, kind: String) -> Arc<JobCore> {
        let meta = UrlJob { id, url, referer, cookies, folder };
        let jc = JobCore::core(meta, filename);
        *jc.kind.lock().unwrap() = kind;
        Arc::new(jc)
    }

    fn core(meta: UrlJob, filename: String) -> JobCore {
        JobCore {
            meta,
            name: Mutex::new(filename),
            resolved: Mutex::new(None),
            state: AtomicU32::new(ST_QUEUED),
            pause: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            done: AtomicU64::new(0),
            total: AtomicU64::new(0),
            speed_bits: AtomicU64::new(0),
            segs: Mutex::new(Vec::new()),
            kind: Mutex::new(String::new()),
            fmtsel: Mutex::new(String::new()),
            stage: Mutex::new(String::new()),
            outs: Mutex::new(Vec::new()),
            err: Mutex::new(None),
        }
    }

    // --- accessors ---
    pub fn id(&self) -> &str { &self.meta.id }
    pub fn name(&self) -> String { self.name.lock().unwrap().clone() }
    pub fn set_name(&self, n: String) { *self.name.lock().unwrap() = n; }
    /// Effective download URL: the resolver's override if set, else the original URL.
    pub fn url(&self) -> String { self.resolved.lock().unwrap().clone().unwrap_or_else(|| self.meta.url.clone()) }
    pub fn set_url(&self, u: String) { *self.resolved.lock().unwrap() = Some(u); }
    pub fn state(&self) -> u32 { self.state.load(Ordering::SeqCst) }
    pub fn set_state(&self, s: u32) { self.state.store(s, Ordering::SeqCst); }
    pub fn done(&self) -> u64 { self.done.load(Ordering::Relaxed) }
    pub fn total(&self) -> u64 { self.total.load(Ordering::Relaxed) }
    pub fn speed_bits(&self) -> u64 { self.speed_bits.load(Ordering::Relaxed) }
    pub fn error(&self) -> Option<String> { self.err.lock().unwrap().clone() }
    pub fn set_err(&self, e: String) { *self.err.lock().unwrap() = Some(e); }
    pub fn parts_dir(&self) -> PathBuf { self.meta.folder.join("OpenDM-Parts").join(&self.meta.id) }
    pub fn part_path(&self, i: usize) -> PathBuf { self.parts_dir().join(format!("part{}", i)) }

    pub fn snapshot(&self, speed: f64) -> Row {
        Row { speed, state: self.state(), done: self.done(), total: self.total(), segs: self.segs.lock().unwrap().iter().map(|s| (s.start, s.end, s.pos, s.done)).collect() }
    }
}

#[derive(Clone)]
pub struct Row { pub state: u32, pub done: u64, pub total: u64, pub speed: f64, pub segs: Vec<(u64, u64, u64, bool)> }

pub fn uuid() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let h = (n as u64).wrapping_mul(2654435761);
    let m = (n >> 32) as u64;
    format!("{:04X}{:04X}{:04X}{:08X}", (h & 0xffff) as u16, (m & 0xffff) as u16, (h >> 16) as u16, m)
}

pub fn filename_from_url(u: Option<&url::Url>, raw: &str) -> String {
    let src = u.map(|u| u.path()).unwrap_or(raw);
    if let Some(seg) = src.rsplit('/').find(|s| !s.is_empty()) {
        let t = seg.split('?').next().unwrap_or(seg);
        if !t.is_empty() { return sanitize_filename(t); }
    }
    "download".to_string()
}

pub fn sanitize_filename(t: &str) -> String {
    let bad = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let t: String = t.chars().map(|c| if bad.contains(&c) { '_' } else { c }).collect();
    let t = t.trim().trim_end_matches(|c| c == '_' || c == '.').trim();
    if t.is_empty() { "download".into() } else { t.to_string() }
}

pub fn unique_in(folder: &PathBuf, name: &str) -> PathBuf {
    let mut p = folder.join(name);
    let mut i = 1u32;
    while p.exists() {
        let n2 = name.rsplit_once('.').map(|(s, e)| format!("{s}({i}).{e}")).unwrap_or_else(|| format!("{name}({i})"));
        p = folder.join(n2);
        i += 1;
    }
    p
}
