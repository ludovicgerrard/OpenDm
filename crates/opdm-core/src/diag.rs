/* Simple engine text log (user-visible debug trail): timestamped lines under
   the app dir (logs/engine.log), rotated at ~2 MB (→ engine.log.1). Init'd by
   the app on startup; every subsystem writes through line(). Best-effort:
   failures to write are silently ignored so logging never blocks a download. */

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

struct Log {
    path: PathBuf,
}

static LOG: OnceLock<Mutex<Log>> = OnceLock::new();

/// UTC stamp "YYYY-MM-DD HH:MM:SS" without chrono (civil_from_days).
fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}")
}

pub fn init(app_dir: &Path) {
    // Production builds have no debug surface: the diagnostic trail
    // (logs/engine.log) is written by debug builds only.
    if !cfg!(debug_assertions) { return; }
    let dir = app_dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("engine.log");
    // rotate: move the current log aside once it gets over ~2 MB
    if let Ok(md) = std::fs::metadata(&path) {
        if md.len() > 2 * 1024 * 1024 {
            let _ = std::fs::rename(&path, dir.join("engine.log.1"));
        }
    }
    let _ = LOG.set(Mutex::new(Log { path }));
    line("INFO", &format!("engine started, v{}", env!("CARGO_PKG_VERSION")));
}

pub fn line(level: &str, msg: &str) {
    // no-op in production (see init) — never write a debug trail in release builds
    if !cfg!(debug_assertions) { return; }
    let entry = format!("{} [{level}] {msg}", stamp());
    match LOG.get() {
        Some(g) => {
            if let Ok(log) = g.lock() {
                // rollover check on every write (cheap stat)
                if let Ok(md) = std::fs::metadata(&log.path) {
                    if md.len() > 2 * 1024 * 1024 {
                        let _ = std::fs::rename(&log.path, log.path.with_extension("log.1"));
                    }
                }
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log.path) {
                    let _ = writeln!(f, "{entry}");
                }
            }
        }
        None => eprintln!("{entry}"), // not initialized (tests) — still visible
    }
}

pub fn info(msg: &str) { line("INFO", msg); }
pub fn error(msg: &str) { line("ERROR", msg); }
