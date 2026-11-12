//! Download engine: coordinator + segment workers (HTTP Range).
use crate::cfg;
use crate::http;
use crate::job::{self, JobCore, Row, Seg};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc::Sender, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use ureq::Agent;

pub enum Ev {
    Progress { id: String, done: u64, total: u64, speed: f64 },
    State { id: String, state: u32, name: String, error: Option<String> },
}

pub struct Engine {
    pub cfg: Arc<Mutex<cfg::Settings>>,
    jobs: Mutex<Vec<Arc<JobCore>>>,
    pub tx: Sender<Ev>,
    agent: Agent,
}

static ENGINE: OnceLock<Engine> = OnceLock::new();

pub fn engine() -> &'static Engine { ENGINE.get().unwrap() }

#[derive(Clone)]
pub struct ListItem {
    pub id: String,
    pub url: String,
    pub name: String,
    pub folder: PathBuf,
    pub row: Row,
    pub error: Option<String>,
    pub kind: String,
    pub stage: String,
    pub fmtsel: String,
    pub cookies: Option<String>,
}

impl Engine {
    pub fn init(cfg: Arc<Mutex<cfg::Settings>>, tx: Sender<Ev>) {
        let ua = cfg.lock().unwrap().user_agent.clone();
        let agent = ureq::builder()
            .user_agent(&ua)
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(900))
            .build();
        let e = Engine { cfg, jobs: Mutex::new(Vec::new()), tx, agent };
        let _ = ENGINE.set(e);
    }

    pub fn agent(&self) -> Agent { self.agent.clone() }

    pub fn list(&self) -> Vec<ListItem> {
        self.jobs.lock().unwrap().iter().map(|jc| {
            let speed = f64::from_bits(jc.speed_bits());
            ListItem {
                id: jc.meta.id.clone(),
                url: jc.meta.url.clone(),
                name: jc.name(),
                folder: jc.meta.folder.clone(),
                row: jc.snapshot(speed),
                error: jc.error(),
                kind: jc.kind.lock().unwrap().clone(),
                stage: jc.stage.lock().unwrap().clone(),
                fmtsel: jc.fmtsel.lock().unwrap().clone(),
                cookies: jc.meta.cookies.clone(),
            }
        }).collect()
    }

    pub fn find(&self, id: &str) -> Option<Arc<JobCore>> {
        self.jobs.lock().unwrap().iter().find(|j| j.meta.id == id).cloned()
    }

    pub fn count(&self) -> usize { self.jobs.lock().unwrap().len() }
    pub fn item_at(&self, i: usize) -> Option<Arc<JobCore>> { self.jobs.lock().unwrap().get(i).cloned() }
    pub fn index_of(&self, id: &str) -> Option<usize> { self.jobs.lock().unwrap().iter().position(|j| j.meta.id == id) }

    pub fn emit_state(&self, jc: &JobCore) {
        self.tx.send(Ev::State { id: jc.meta.id.clone(), state: jc.state(), name: jc.name(), error: jc.error() }).ok();
    }

    pub fn persist(&self) { crate::db::persist(self); }

    /* ---------------- operations ---------------- */

    pub fn queue(&self, url: &str, referer: Option<String>, filename: Option<String>, folder: Option<PathBuf>, cookies: Option<String>) -> Option<String> {
        let parsed = url::Url::parse(url).ok()?;
        let c = cfg::settings();
        let folder = folder.unwrap_or_else(|| c.download_dir.clone());
        let name = job::sanitize_filename(&filename.unwrap_or_else(|| job::filename_from_url(Some(&parsed), url)));
        let jc = JobCore::new(url.to_string(), referer, cookies, folder, name);
        self.jobs.lock().unwrap().push(jc.clone());
        self.persist();
        self.emit_state(&jc);
        self.start(jc.clone());
        Some(jc.meta.id.clone())
    }

    /// yt-dlp job (YouTube pipeline). The dialog supplies title + -f selection.
    pub fn queue_ytdlp(&self, url: &str, mut title: String, fmtsel: &str, cookies: Option<String>, folder: Option<PathBuf>) -> String {
        let c = cfg::settings();
        let folder = folder.unwrap_or_else(|| c.download_dir.clone());
        if title.trim().is_empty() { title = "YouTube video".into(); }
        // Strip playlist context (list=/start_radio=…) from single-video urls.
        // The payload now carries the url AS SENT (the New page card identity),
        // and a Mix/Radio context here made yt-dlp expand the whole endless
        // radio playlist and die with "OSError: [Errno 22]" (§ yt_parse).
        let url = crate::ytdlp::normalize_watch_url(url);
        let jc = JobCore::new(url, None, cookies, folder, job::sanitize_filename(&title));
        *jc.kind.lock().unwrap() = "ytdlp".into();
        *jc.fmtsel.lock().unwrap() = fmtsel.to_string();
        *jc.stage.lock().unwrap() = "downloading".into();
        self.jobs.lock().unwrap().push(jc.clone());
        self.persist();
        self.emit_state(&jc);
        self.start(jc.clone());
        jc.meta.id.clone()
    }

    pub fn start(&self, jc: Arc<JobCore>) {
        if !matches!(jc.state(), job::ST_QUEUED | job::ST_PAUSED) { return; }
        let is_ytdlp = jc.kind.lock().unwrap().as_str() == "ytdlp";
        jc.pause.store(false, Ordering::SeqCst);
        jc.cancel.store(false, Ordering::SeqCst);
        jc.set_state(job::ST_RUNNING);
        self.emit_state(&jc);
        self.persist();
        if is_ytdlp {
            let jc2 = jc.clone();
            let _ = std::thread::Builder::new().name(format!("ytdlp-{}", jc.meta.id)).spawn(move || ytdlp_coordinator(jc2));
        } else {
            let agent = self.agent.clone();
            let jc2 = jc.clone();
            let _ = std::thread::Builder::new().name(format!("coord-{}", jc.meta.id)).spawn(move || coordinator(agent, jc2));
        }
    }

    pub fn pause(&self, jc: Arc<JobCore>) {
        if jc.state() == job::ST_RUNNING { jc.pause.store(true, Ordering::SeqCst); }
    }

    pub fn resume(&self, jc: Arc<JobCore>) { self.start(jc); }

    pub fn stop(&self, jc: Arc<JobCore>) {
        if jc.state() == job::ST_RUNNING { jc.pause.store(true, Ordering::SeqCst); }
    }

    pub fn remove(&self, jc: Arc<JobCore>, del_files: bool) {
        if jc.state() == job::ST_RUNNING {
            jc.cancel.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(400));
        }
        self.jobs.lock().unwrap().retain(|j| j.meta.id != jc.meta.id);
        if del_files {
            std::fs::remove_dir_all(jc.parts_dir()).ok();
            // classic job: the file is folder/name. ytdlp job: tracked outputs
            // (+ .part/.ytdl fragments of the same stem) live in the folder.
            let is_ytdlp = jc.kind.lock().unwrap().as_str() == "ytdlp";
            if is_ytdlp {
                let outs = jc.outs.lock().unwrap().clone();
                if !outs.is_empty() {
                    let mut stems: Vec<String> = Vec::new();
                    for p in outs {
                        let pb = PathBuf::from(&p);
                        let _ = std::fs::remove_file(&pb);
                        if let (Some(d), Some(n)) = (pb.parent(), p.rsplit_once('.')) {
                            stems.push(p.clone());
                            // same stem fragments + temp suffixes
                            let stem = n.0;
                            if let Ok(rd) = std::fs::read_dir(d) {
                                for e in rd.flatten() {
                                    let nm = e.file_name().to_string_lossy().to_string();
                                    if nm == p || nm == format!("{stem}.part") || nm == format!("{stem}.ytdl") {
                                        let _ = std::fs::remove_file(e.path());
                                    }
                                }
                            }
                        }
                    }
                    let _ = stems;
                }
            } else {
                std::fs::remove_file(jc.meta.folder.join(jc.name())).ok();
            }
        }
        self.persist();
    }

    /// Called during startup restore (db.rs) after Engine::init.
    pub fn load_restore(&self, jc: Arc<JobCore>) {
        self.jobs.lock().unwrap().push(jc);
    }

    /// yt-dlp subprocess log for one job (task log shown in the details dock).
    pub fn yt_log(&self, id: &str) -> Option<String> {
        let jc = self.find(id)?;
        let mut s = std::fs::read_to_string(jc.parts_dir().join("log.txt")).ok()?;
        if s.chars().count() > 60_000 {
            // cap for the UI: keep the tail (latest lines matter most)
            let cut = s.char_indices().count().checked_sub(60_000);
            let _ = cut;
            let bytes: String = s.chars().skip(s.chars().count().saturating_sub(60_000)).collect();
            s = bytes;
        }
        Some(s)
    }
}

/* ---------------- coordinator + workers ---------------- */

/// Checked every direct-download finish where the URL is a YouTube player
/// stream: the container magic must look like real media. SABR URLs answered
/// with a plain GET return a protobuf whose first byte is 0x2c (`,`), not media.
fn validate_final(path: &std::path::Path, url: &str) -> Result<(), String> {
    let is_player = url.contains("/videoplayback") || url.contains(".googlevideo.com");
    if !is_player { return Ok(()); }
    let mut buf = [0u8; 256];
    let n = std::fs::File::open(path).and_then(|mut f| std::io::Read::read(&mut f, &mut buf)).unwrap_or(0);
    let media = n >= 8 && (
        buf[4..8] == *b"ftyp"                      // mp4/m4a/m4v
        || buf[0..4] == [0x1A, 0x45, 0xDF, 0xA3]   // webm/mkv EBML
        || buf[0..3] == *b"ID3"                    // mp3
        || buf[0..4] == *b"fLaC"                   // flac
        || buf[0..4] == *b"OggS"                   // ogg
        || (buf[0] == 0xFF && (buf[1] & 0xE0) == 0xE0) // bare MPEG audio
        // MPEG-TS (YouTube HLS merge output): sync byte 0x47 at packet stride 188
        || (buf[0] == 0x47 && n >= 188 && buf[188] == 0x47)
    );
    if media { return Ok(()); }
    Err(format!(
        "finalize check failed: Google returned {} bytes of control data instead of media (the URL is served through YouTube's server-ABR protocol and refuses plain requests). Open the watch page and click the OpenDM button while the video plays instead.",
        n
    ))
}

/// Test-only access to the finalize guard semantics.
#[doc(hidden)]
pub mod __test {
    use super::*;
    pub fn validate(path: &std::path::Path, url: &str) -> Result<(), String> { validate_final(path, url) }
}

fn coordinator(agent: Agent, jc: Arc<JobCore>) {
    let dir = jc.parts_dir();
    let _ = std::fs::create_dir_all(&dir);

    // HLS streams: dedicated pipeline (parallel segments, AES-128, merge).
    // Match the bare URL (no query/fragment) so playlists with tokens still qualify.
    let low = jc.url().to_ascii_lowercase();
    let bare = low.split(|c| c == '?' || c == '#').next().unwrap_or(&low).to_string();
    if bare.ends_with(".m3u8") || bare.ends_with(".m3u") || bare.contains("/api/manifest/hls_playlist/") {
        crate::hls::coordinator(agent, jc, &dir);
        return;
    }

    let planned = !jc.segs.lock().unwrap().is_empty();
    if !planned {
        let (total, known, mime, disp) = http::probe(&agent, &jc.url(), jc.meta.referer.clone(), jc.meta.cookies.clone());
        if let Some(d) = &disp {
            let default_name = jc.name();
            if let Some(name) = http::filename_of(&Some(d.clone()), cfg::name_ext_from_mime(mime.as_deref()), &default_name) {
                jc.set_name(name);
            }
        }
        if known && total > 0 {
            let seg_n = seg_count(total);
            let piece = total / seg_n as u64;
            let mut segs: Vec<Seg> = Vec::new();
            let mut s = 0u64;
            for i in 0..seg_n {
                let e = if i == seg_n - 1 { total.saturating_sub(1) } else { s + piece - 1 };
                segs.push(Seg { start: s, end: e, pos: s, done: false });
                s = e + 1;
            }
            *jc.segs.lock().unwrap() = segs;
            jc.total.store(total, Ordering::Relaxed);
        } else {
            *jc.segs.lock().unwrap() = vec![Seg { start: 0, end: u64::MAX, pos: 0, done: false }];
            if known { jc.total.store(total, Ordering::Relaxed); }
        }
        write_meta(&dir, &jc);
    }

    // Spawn workers
    let segs = jc.segs.lock().unwrap().clone();
    let mut handles = Vec::new();
    for (idx, seg) in segs.iter().enumerate() {
        if seg.done || jc.cancel.load(Ordering::SeqCst) { continue; }
        let agent = agent.clone();
        let jc = jc.clone();
        if let Ok(h) = std::thread::Builder::new()
            .name(format!("w{}-{idx}", jc.meta.id))
            .spawn(move || seg_worker(agent, jc, idx))
        {
            handles.push(h);
        }
    }

    // Progress ticker (reports to UI)
    {
        let jc = jc.clone();
        let tx = engine().tx.clone();
        let _ = std::thread::Builder::new().name("ticker".into()).spawn(move || ticker(jc, tx));
    }

    for h in handles { let _ = h.join(); }

    let segs_snap = jc.segs.lock().unwrap().clone();
    let mut all_done = !segs_snap.is_empty();
    for s in &segs_snap { if !s.done { all_done = false; } }

    if jc.cancel.load(Ordering::SeqCst) {
        jc.set_state(job::ST_QUEUED); // stopped: keep parts, allow resume later
        engine().emit_state(&jc);
        engine().persist();
    } else if all_done {
        if merge_parts(&jc) {
            // IDM-parity output validation (fun_005cdee0 probe semantics): never pass a
            // tiny protobuf error body (e.g. sabr.malformed_config) as a finished media file.
            let final_path = jc.meta.folder.join(jc.name());
            match validate_final(&final_path, &jc.url()) {
                Ok(()) => {
                    std::fs::remove_dir_all(&dir).ok();
                    jc.set_state(job::ST_DONE);
                    if let Ok(md) = std::fs::metadata(&final_path) {
                        jc.total.store(md.len(), Ordering::Relaxed);
                    }
                }
                Err(msg) => {
                    let _ = std::fs::remove_file(&final_path);
                    std::fs::remove_dir_all(&dir).ok();
                    jc.set_err(msg);
                    jc.set_state(job::ST_ERROR);
                }
            }
        } else {
            jc.set_err("Failed to write final file".into());
            jc.set_state(job::ST_ERROR);
        }
        engine().emit_state(&jc);
        engine().persist();
    } else if jc.pause.load(Ordering::SeqCst) {
        jc.set_state(job::ST_PAUSED);
        jc.pause.store(false, Ordering::SeqCst);
        write_meta(&dir, &jc);
        engine().emit_state(&jc);
        engine().persist();
    } else {
        jc.set_state(job::ST_ERROR);
        engine().emit_state(&jc);
        engine().persist();
    }
}

fn seg_count(total: u64) -> usize {
    let s = cfg::settings().max_segments.min(16);
    if total < 512 * 1024 { 1 }
    else if total < 2 * 1024 * 1024 { 2 }
    else { s.max(1) }
}

fn write_meta(dir: &std::path::Path, jc: &JobCore) {
    let segs = jc.segs.lock().unwrap().clone();
    let m = serde_json::json!({
        "id": jc.meta.id, "url": jc.meta.url,
        "name": jc.name(), "total": jc.total(), "done": jc.done(),
        "segs": segs.iter().map(|s| serde_json::json!({"start": s.start, "end": s.end, "pos": s.pos, "done": s.done})).collect::<Vec<_>>(),
    });
    std::fs::write(dir.join("meta.json"), serde_json::to_vec(&m).unwrap_or_default()).ok();
}

pub(crate) fn ticker(jc: Arc<JobCore>, tx: Sender<Ev>) {
    let mut last_bytes = jc.done();
    let mut prev_speed = 0.0f64;
    let mut t0 = Instant::now();
    while jc.state() == job::ST_RUNNING && !jc.cancel.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(300));
        let cur = jc.done();
        let dt = t0.elapsed().as_secs_f64();
        if dt > 0.15 {
            let inst = (cur - last_bytes) as f64 / dt;
            prev_speed = if prev_speed <= 0.0 { inst } else { prev_speed * 0.75 + inst * 0.25 };
            last_bytes = cur;
            t0 = Instant::now();
            jc.speed_bits.store(prev_speed.to_bits(), Ordering::Relaxed);
            tx.send(Ev::Progress { id: jc.meta.id.clone(), done: jc.done(), total: jc.total(), speed: prev_speed }).ok();
        }
    }
}

fn seg_worker(agent: Agent, jc: Arc<JobCore>, idx: usize) {
    let part = jc.part_path(idx);
    let mut backoff = 1u64;
    loop {
        if jc.cancel.load(Ordering::SeqCst) || jc.pause.load(Ordering::SeqCst) { return; }
        let (start, end, mut pos) = {
            let g = jc.segs.lock().unwrap();
            let s = &g[idx];
            (s.start, s.end, s.pos)
        };
        if end <= pos || (end != u64::MAX && pos > end) {
            jc.segs.lock().unwrap()[idx].done = true;
            let _ = start;
            return;
        }

        let url = jc.url();
        let req = if start == 0 && end == u64::MAX {
            agent.get(&url)
        } else {
            agent.get(&url).set("Range", &format!("bytes={pos}-{}", if end == u64::MAX { "".to_string() } else { end.to_string() }))
        };
        let req = match &jc.meta.referer {
            Some(r) => req.set("Referer", r),
            None => req,
        };
        let req = match &jc.meta.cookies {
            Some(c) => req.set("Cookie", c),
            None => req,
        };

        match req.call() {
            Ok(resp) => {
                let status = resp.status();
                if status == 416 {
                    jc.segs.lock().unwrap()[idx].done = true;
                    return;
                }
                if (200..300).contains(&status) {
                    let full = status == 200; // server ignored Range
                    let end_eff = if full { u64::MAX } else { end };
                    let mut reader = resp.into_reader();
                    let mut f = match OpenOptions::new().create(true).append(true).open(&part) {
                        Ok(f) => f,
                        Err(e) => { jc.set_err(format!("file: {e}")); jc.cancel.store(true, Ordering::SeqCst); return; }
                    };
                    let mut buf = vec![0u8; 128 * 1024];
                    loop {
                        if jc.cancel.load(Ordering::SeqCst) || jc.pause.load(Ordering::SeqCst) { break; }
                        match reader.read(&mut buf) {
                            Ok(0) => { if full { jc.segs.lock().unwrap()[idx].done = true; } break; }
                            Ok(n) => {
                                let write_n = if end_eff == u64::MAX { n } else { ((end_eff - pos + 1) as usize).min(n) };
                                if write_n == 0 {
                                    jc.segs.lock().unwrap()[idx].done = true;
                                    break;
                                }
                                if f.write_all(&buf[..write_n]).is_err() {
                                    jc.set_err("disk write error".into());
                                    jc.cancel.store(true, Ordering::SeqCst);
                                    break;
                                }
                                jc.done.fetch_add(write_n as u64, Ordering::Relaxed);
                                pos += write_n as u64;
                                jc.segs.lock().unwrap()[idx].pos = pos;
                                if end_eff != u64::MAX && pos > end_eff {
                                    jc.segs.lock().unwrap()[idx].done = true;
                                    break;
                                }
                            }
                            Err(_) => break, // connection dropped, outer loop retries
                        }
                    }
                    let seg_now = { let g = jc.segs.lock().unwrap(); g[idx].clone() };
                    if seg_now.done { return; }
                    if jc.cancel.load(Ordering::SeqCst) || jc.pause.load(Ordering::SeqCst) { return; }
                    backoff = 1;
                    continue;
                } else {
                    jc.set_err(format!("HTTP {status} for byte range"));
                    jc.cancel.store(true, Ordering::SeqCst);
                    return;
                }
            }
            Err(e) => {
                if jc.cancel.load(Ordering::SeqCst) || jc.pause.load(Ordering::SeqCst) { return; }
                if backoff > 16 {
                    jc.set_err(format!("connection failed: {e}"));
                    jc.cancel.store(true, Ordering::SeqCst);
                    return;
                }
                std::thread::sleep(Duration::from_secs(backoff));
                backoff *= 2;
            }
        }
    }
}

fn merge_parts(jc: &Arc<JobCore>) -> bool {
    let fin_path = crate::job::unique_in(&jc.meta.folder, &jc.name());
    let _ = std::fs::create_dir_all(&jc.meta.folder);
    let mut out = match File::create(&fin_path) { Ok(f) => f, Err(_) => return false };
    let segs = jc.segs.lock().unwrap().clone();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut ok = true;
    for (i, _s) in segs.iter().enumerate() {
        match File::open(jc.part_path(i)) {
            Ok(mut f) => loop {
                match f.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => { if out.write_all(&buf[..n]).is_err() { ok = false; break; } }
                    Err(_) => { ok = false; break; }
                }
                if !ok { break; }
            },
            Err(_) => { ok = false; }
        }
        if !ok { break; }
    }
    drop(out);
    if ok {
        jc.set_name(fin_path.file_name().unwrap_or_default().to_string_lossy().to_string());
    } else {
        std::fs::remove_file(&fin_path).ok();
    }
    ok
}

/* ---------------- yt-dlp coordinator (YouTube pipeline) ---------------- */

/// Quoted strings on a yt-dlp stdout line (Destination / Merger paths).
fn quoted_paths(line: &str) -> Vec<String> {
    line.split('"').skip(1).step_by(2).map(|s| s.to_string()).collect()
}

/// Try once to parse PROGRESS_JSON out of one yt-dlp output line and paint the job.
fn yt_line(jc: &Arc<JobCore>, line: &str, log: &Arc<Mutex<Option<std::fs::File>>>) {
    if line.is_empty() { return; }
    if let Ok(mut g) = log.lock() {
        if let Some(f) = g.as_mut() {
            use std::io::Write;
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
    }
    if let Some(em) = crate::ytdlp::emitter_pub() {
        use serde_json::json;
        em("dl-log", json!({ "id": jc.meta.id, "line": line }));
    }
    if let Ok(mut outs) = jc.outs.lock() {
        for p in quoted_paths(line) {
            if (line.contains("[download] Destination:") || line.contains("[Merger] Merging") || line.contains("[ExtractAudio]"))
                && !p.ends_with(".part") && !p.ends_with(".ytdl") && !outs.contains(&p) {
                outs.push(p);
            }
        }
    }
    if let Some((post, v)) = crate::ytdlp::parse_progress(line) {
        let (done, total, speed) = crate::ytdlp::apply_progress(jc, post, &v);
        engine().tx.send(Ev::Progress { id: jc.meta.id.clone(), done, total, speed }).ok();
    }
}

/// The yt-dlp pipeline runner. Resume re-spawns yt-dlp, which continues from
/// its own `.part` files; pause/cancel kill the child process.
fn ytdlp_coordinator(jc: Arc<JobCore>) {
    let eng = engine();
    let ytdlp = crate::ytdlp::tool_path(crate::ytdlp::T_YTDLP);
    if !ytdlp.is_file() {
        jc.set_err("yt-dlp is not installed — open Settings too → YouTube tools".into());
        jc.set_state(job::ST_ERROR);
        eng.emit_state(&jc);
        eng.persist();
        return;
    }
    let dir = jc.parts_dir();
    let _ = std::fs::create_dir_all(&dir);
    let keep_cookies = crate::ytdlp::cookies_to_file(jc.meta.cookies.as_deref(), &jc.meta.url, &dir, "dl");
    let fp_file = dir.join("filepath.txt");
    let _ = std::fs::remove_file(&fp_file);
    let fmt = jc.fmtsel.lock().unwrap().clone();
    let name = jc.name();
    // an explicit merge (`-f X+Y`) needs ffmpeg; without it yt-dlp fails
    // instantly — give a human reason up front instead of a raw usage error
    let merges = fmt.contains('+');
    if merges && !crate::ytdlp::tool_path(crate::ytdlp::T_FFMPEG).is_file() {
        crate::diag::error(&format!("ytdlp job {}: merge requested but ffmpeg is missing", jc.meta.id));
        jc.set_err("FFmpeg is required to merge YouTube video+audio — open Settings → YouTube tools and install it, or pick a “single file” quality.".into());
        jc.set_state(job::ST_ERROR);
        eng.emit_state(&jc);
        eng.persist();
        return;
    }
    let args = crate::ytdlp::download_args(&fmt, &name, keep_cookies.as_deref(), &fp_file, &jc.meta.folder);
    // subprocess log (repo parity: task log file streamed to the UI live)
    let logfile = dir.join("log.txt");
    let log = Arc::new(Mutex::new(std::fs::File::create(&logfile).ok()));

    let mut cmd = std::process::Command::new(&ytdlp);
    cmd.args(&args)
        // THE STREAM TARGET — shows up last, after -f/-P/--output
        .arg(&jc.meta.url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::diag::info(&format!("ytdlp job {}: spawn yt-dlp with {}", jc.meta.id, args.join(" ")));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            jc.set_err(format!("spawn yt-dlp: {e}"));
            jc.set_state(job::ST_ERROR);
            eng.emit_state(&jc);
            eng.persist();
            return;
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let errbuf = Arc::new(Mutex::new(String::new()));

    let jc_o = jc.clone();
    let log_o = log.clone();
    let out_h = std::thread::Builder::new().name("ytdlp-stdout".into()).spawn(move || {
        let Some(r) = stdout else { return };
        for line in std::io::BufReader::new(r).lines().map_while(|l| l.ok()) {
            yt_line(&jc_o, &line, &log_o);
        }
    }).ok();

    let jc_e = jc.clone();
    let eb = errbuf.clone();
    let log_e = log.clone();
    let err_h = std::thread::Builder::new().name("ytdlp-stderr".into()).spawn(move || {
        let Some(r) = stderr else { return };
        for line in std::io::BufReader::new(r).lines().map_while(|l| l.ok()) {
            let mut g = eb.lock().unwrap();
            if g.len() < 4000 { g.push_str(&line); g.push('\n'); }
            if line.contains("[download]") || line.starts_with("ERROR") || line.contains("ERROR:") {
                drop(g);
                yt_line(&jc_e, &line, &log_e); // fragment progress comes on stderr sometimes
            }
        }
    }).ok();

    // watch loop: reacts to pause/cancel by killing the child
    let mut killed = false;
    let mut status: Option<std::process::ExitStatus> = None;
    loop {
        std::thread::sleep(Duration::from_millis(200));
        if (jc.pause.load(Ordering::SeqCst) || jc.cancel.load(Ordering::SeqCst)) && !killed {
            let _ = child.kill();
            killed = true;
        }
        match child.try_wait() {
            Ok(Some(st)) => { status = Some(st); break; }
            Ok(None) => continue,
            Err(_) => {
                jc.set_err("failed to wait for yt-dlp".into());
                break;
            }
        }
    }
    if let Some(h) = out_h { let _ = h.join(); }
    if let Some(h) = err_h { let _ = h.join(); }
    if let Some(f) = keep_cookies {
        let _ = std::fs::remove_file(f);
    }

    let success = status.map(|s| s.success()).unwrap_or(false);
    let code = status.as_ref().and_then(|s| s.code()).unwrap_or_default();
    if !success {
        let owned = errbuf.lock().unwrap().clone();
    let all: Vec<&str> = owned.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = all.iter().rev().take(40).rev()
            .map(|s| s.to_string()).collect::<Vec<_>>().join("\n");
        crate::diag::error(&format!("ytdlp job {}: exit={} stderr tail:\n{}", jc.meta.id, code, tail));
    } else {
        crate::diag::info(&format!("ytdlp job {}: yt-dlp exited OK (code {})", jc.meta.id, code));
    }

    if jc.cancel.load(Ordering::SeqCst) {
        jc.set_state(job::ST_QUEUED);
        *jc.stage.lock().unwrap() = String::new();
        eng.emit_state(&jc);
        eng.persist();
        return;
    }

    if jc.pause.load(Ordering::SeqCst) {
        // paused mid-download: yt-dlp's .part file remains; resume continues
        jc.pause.store(false, Ordering::SeqCst);
        jc.set_state(job::ST_PAUSED);
        *jc.stage.lock().unwrap() = String::new();
        eng.emit_state(&jc);
        eng.persist();
        return;
    }

    if success {
        if let Ok(txt) = std::fs::read_to_string(&fp_file) {
            let path = PathBuf::from(txt.trim());
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    jc.set_name(name.to_string());
                }
                if let Ok(md) = std::fs::metadata(&path) {
                    jc.total.store(md.len(), Ordering::Relaxed);
                    jc.done.store(md.len(), Ordering::Relaxed);
                }
            }
        }
        if jc.done() == 0 && jc.total() == 0 {
            // no print-to-file value (e.g. already complete with --no-overwrites)?
            // fall back to the biggest finished output we tracked
            let best = jc.outs.lock().unwrap().iter()
                .max_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
                .cloned();
            if let Some(p) = best {
                let path = PathBuf::from(&p);
                if path.is_file() {
                    if let Some(n) = path.file_name().and_then(|x| x.to_str()) { jc.set_name(n.to_string()); }
                    if let Ok(md) = std::fs::metadata(&path) {
                        jc.total.store(md.len(), Ordering::Relaxed);
                        jc.done.store(md.len(), Ordering::Relaxed);
                    }
                }
            }
        }
        jc.speed_bits.store(0, Ordering::Relaxed);
        jc.set_state(job::ST_DONE);
        *jc.stage.lock().unwrap() = String::new();
        eng.emit_state(&jc);
        eng.persist();
        return;
    }

    let msg = errbuf.lock().unwrap().clone();
    jc.set_err(if msg.is_empty() { "yt-dlp exited with an error".into() } else { msg.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("yt-dlp error").to_string() });
    jc.set_state(job::ST_ERROR);
    *jc.stage.lock().unwrap() = String::new();
    eng.emit_state(&jc);
    eng.persist();
}
