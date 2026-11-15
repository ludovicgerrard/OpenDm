//! HLS (HTTP Live Streaming) download engine support.
//! - Master playlist → variants (extension picks one; "best" default here)
//! - Media playlist → ordered segments + optional fMP4 init + AES-128 key
//! - Parallel segment download with retries; AES-128-CBC decryption
//! - Crash-resume: segN.part files under the job part dir + meta.json
//! - Merge: init + segments concatenated → .ts (or .mp4 when init present)
use crate::job::{self, JobCore};
use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use ureq::Agent;

type Aes128CbcDec = cbc::Decryptor<Aes128>;

#[derive(Debug, Clone)]
pub struct Variant { pub label: String, pub url: String, pub bandwidth: u64 }

#[derive(Debug, Clone)]
pub struct KeySpec { pub uri: String, pub iv: Option<[u8; 16]> }

/* ---------------- playlist parsing ---------------- */

pub fn is_master(text: &str) -> bool { text.contains("#EXT-X-STREAM-INF") }

/// Parse a MASTER playlist into variants, best bandwidth first.
pub fn parse_master(text: &str, base: &url::Url) -> (Vec<Variant>, Option<Variant>) {
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r').trim()).collect();
    let mut out: Vec<Variant> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if !lines[i].starts_with("#EXT-X-STREAM-INF") { i += 1; continue; }
        let attrs = lines[i].split_once(':').map(|(_, r)| r).unwrap_or("");
        let bw = find_field(attrs, "BANDWIDTH").and_then(|v| v.parse::<u64>().ok());
        let label = match attr_height(attrs) {
            Some(h) => format!("{h}p"),
            None => match bw {
                Some(b) if b > 0 => format!("{} kbps", b / 1000),
                _ => format!("variant {}", out.len() + 1),
            },
        };
        // first non-comment line after the tag is the variant URI
        let mut j = i + 1;
        while j < lines.len() && (lines[j].is_empty() || lines[j].starts_with('#')) { j += 1; }
        if j >= lines.len() { break; }
        if let Ok(abs) = base.join(lines[j]) {
            out.push(Variant { label, url: abs.to_string(), bandwidth: bw.unwrap_or(0) });
        }
        i = j + 1;
    }
    if out.is_empty() { return (Vec::new(), None); }
    out.sort_by(|a, b| b.bandwidth.cmp(&a.bandwidth));
    let best = out.first().cloned();
    (out, best)
}

fn attr_height(attrs: &str) -> Option<u64> {
    let raw = find_field(attrs, "RESOLUTION")?;
    let h = raw.split('x').nth(1)?.trim().parse::<u64>().ok()?;
    Some(h)
}

fn find_field<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let mut rest = attrs;
    loop {
        let eq = rest.find('=')?;
        let k = rest[..eq].trim().trim_start_matches(|c| c == ',' || c == ':');
        let rem = &rest[eq + 1..];
        if rem.starts_with('"') {
            let close = rem[1..].find('"').map(|e| e + 1).unwrap_or(rem.len());
            if k.eq_ignore_ascii_case(name) { return Some(rem[1..close].trim()); }
            // skip the closing quote, then the attribute separator
            let after = &rem[close..];
            rest = after.strip_prefix('"').and_then(|x| x.strip_prefix(',')).unwrap_or(after);
        } else {
            let (tok, tail) = rem.split_once(',').unwrap_or((rem, ""));
            if k.eq_ignore_ascii_case(name) { return Some(tok.trim()); }
            rest = tail;
        }
    }
}

fn parse_key(attrs: &str, base: &url::Url) -> Option<KeySpec> {
    let method = find_field(attrs, "METHOD")?;
    if method.eq_ignore_ascii_case("NONE") { return None; }
    if !method.eq_ignore_ascii_case("AES-128") { return None; }
    let uri = find_field(attrs, "URI")?;
    let abs = base.join(uri).ok()?;
    let iv = find_field(attrs, "IV").map(hex_bytes);
    Some(KeySpec { uri: abs.to_string(), iv })
}

fn hex_bytes(s: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    let s = s.trim();
    let s = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    let clean: Vec<char> = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    for (i, c) in clean.iter().take(32).enumerate() {
        let v = c.to_digit(16).unwrap_or(0) as u8;
        out[i / 2] = match i % 2 { 0 => out[i / 2] | (v << 4), _ => out[i / 2] | v };
    }
    out
}

fn seq_iv(seq: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..].copy_from_slice(&seq.to_be_bytes());
    iv
}

/// Parse a MEDIA playlist: ordered segment URIs + init map + AES-128 key.
pub fn parse_media(text: &str, base: &url::Url) -> (Option<String>, Vec<String>, Option<KeySpec>, u64) {
    let mut init = None;
    let mut segs = Vec::new();
    let mut key = None;
    let mut media_seq = 0u64;
    for line in text.split('\n') {
        let l = line.trim_end_matches('\r').trim();
        if l.is_empty() { continue; }
        if let Some(rest) = l.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            media_seq = rest.trim().parse().unwrap_or(0);
        } else if let Some(rest) = l.strip_prefix("#EXT-X-MAP:") {
            if let Some(u) = find_field(rest, "URI") {
                if let Ok(a) = base.join(u) { init = Some(a.to_string()); }
            }
        } else if let Some(rest) = l.strip_prefix("#EXT-X-KEY:") {
            if key.is_none() { key = parse_key(rest, base); }
        } else if !l.starts_with('#') {
            if let Ok(a) = base.join(l) { segs.push(a.to_string()); }
        }
    }
    (init, segs, key, media_seq)
}

/* ---------------- fetching + crypto ---------------- */

pub fn get_text(agent: &Agent, url: &str, referer: &Option<String>, cookies: &Option<String>) -> Result<String, String> {
    let mut req = agent.get(url);
    if let Some(r) = referer { req = req.set("Referer", r); }
    if let Some(c) = cookies { req = req.set("Cookie", c); }
    req.call().map_err(|e| e.to_string())?.into_string().map_err(|e| e.to_string())
}

pub fn get_bytes(agent: &Agent, url: &str, referer: &Option<String>, cookies: &Option<String>) -> Result<Vec<u8>, String> {
    let mut req = agent.get(url);
    if let Some(r) = referer { req = req.set("Referer", r); }
    if let Some(c) = cookies { req = req.set("Cookie", c); }
    let resp = req.call().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.into_reader().take(32 * 1024 * 1024).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

pub fn decrypt_seg(key: &[u8; 16], iv: &[u8; 16], ct: &[u8]) -> Result<Vec<u8>, String> {
    let dec = Aes128CbcDec::new_from_slices(key, iv).map_err(|e| e.to_string())?;
    dec.decrypt_padded_vec_mut::<Pkcs7>(ct).map_err(|_| "bad ciphertext padding".to_string())
}

/* ---------------- plan persistence (crash resume) ---------------- */

#[derive(serde::Serialize, serde::Deserialize)]
struct Meta {
    kind: String,
    #[serde(default)]
    init: Option<String>,
    #[serde(default)]
    key: Option<SavedKey>,
    ext: String,
    #[serde(default)]
    segs: Vec<String>,
    #[serde(default)]
    media_seq: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct SavedKey { uri: String, iv: Option<String> }

fn write_plan(dir: &Path, init: &Option<String>, segs: &[String], key: &Option<KeySpec>, ext: &'static str, media_seq: u64) {
    let m = Meta {
        kind: "hls".into(),
        init: init.clone(),
        key: key.clone().map(|k| SavedKey { uri: k.uri, iv: k.iv.map(|v| hex_str(&v)) }),
        ext: ext.to_string(),
        segs: segs.to_vec(),
        media_seq,
    };
    let _ = std::fs::write(dir.join("meta.json"), serde_json::to_vec(&m).unwrap_or_default());
}

fn hex_str(v: &[u8; 16]) -> String { v.iter().map(|b| format!("{b:02x}")).collect() }

fn read_plan(dir: &Path) -> Option<(Option<String>, Vec<String>, Option<KeySpec>, u64, &'static str)> {
    let raw = std::fs::read(dir.join("meta.json")).ok()?;
    let m: Meta = serde_json::from_slice(&raw).ok()?;
    if m.kind != "hls" { return None; }
    let key = m.key.map(|k| KeySpec { uri: k.uri, iv: k.iv.map(|h| hex_bytes(&h)) });
    let ext: &'static str = if m.ext == "mp4" { "mp4" } else { "ts" };
    // coordinator order: (init, segs, key, media_seq, ext)
    Some((m.init, m.segs, key, m.media_seq, ext))
}

fn seg_path(dir: &Path, i: usize) -> PathBuf { dir.join(format!("seg{i}.part")) }
fn seg_done(dir: &Path, i: usize) -> bool { seg_path(dir, i).exists() }

/* ---------------- coordinator ---------------- */

pub fn coordinator(agent: Agent, jc: Arc<JobCore>, dir: &Path) {
    let dir = dir.to_path_buf();
    let base = url::Url::parse(&jc.url()).ok();

    // 1) plan: restore existing meta.json or parse the playlist fresh
    let (init, segs, key, media_seq, ext) = match read_plan(&dir) {
        Some(t) => t,
        None => {
            let Some(base) = base else { return fail(jc, "invalid playlist url") };
            let text = match get_text(&agent, &jc.url(), &jc.meta.referer, &jc.meta.cookies) {
                Ok(t) => t,
                Err(e) => return fail(jc, &format!("fetch playlist: {e}")),
            };
            let media_url = if is_master(&text) {
                let (_all, best) = parse_master(&text, &base);
                match best {
                    Some(v) => v.url,
                    None => return fail(jc, "master playlist has no variants"),
                }
            } else {
                jc.url()
            };
            match get_text(&agent, &media_url, &jc.meta.referer, &jc.meta.cookies) {
                Ok(t) => {
                    let mb = url::Url::parse(&media_url).unwrap_or_else(|_| base.clone());
                    let (init, segs, key, seq) = parse_media(&t, &mb);
                    let ext = if init.is_some() { "mp4" } else { "ts" };
                    (init, segs, key, seq, ext)
                }
                Err(e) => return fail(jc, &format!("fetch variant: {e}")),
            }
        }
    };

    let n = segs.len();
    if n == 0 { return fail(jc, "no segments in playlist"); }
    write_plan(&dir, &init, &segs, &key, ext, media_seq);

    // 2) fetch AES key once (16 bytes)
    let key_bytes: Option<Arc<Vec<u8>>> = match &key {
        Some(k) => match get_bytes(&agent, &k.uri, &jc.meta.referer, &jc.meta.cookies) {
            Ok(b) if b.len() == 16 => Some(Arc::new(b)),
            Ok(_) => return fail(jc, "unexpected HLS key length"),
            Err(e) => return fail(jc, &format!("fetch key: {e}")),
        },
        None => None,
    };

    // 3) init segment for fMP4 structures
    if let Some(u) = &init {
        if !dir.join("init.part").exists() {
            match get_bytes(&agent, u, &jc.meta.referer, &jc.meta.cookies) {
                Ok(b) => { let _ = std::fs::write(dir.join("init.part"), &b); }
                Err(e) => return fail(jc, &format!("fetch init segment: {e}")),
            }
        }
    }

    // progress ticker in its own thread (like the range pipeline)
    {
        let txc = crate::dlm::engine().tx.clone();
        let jct = jc.clone();
        let _ = std::thread::Builder::new().name("hls-tick".into()).spawn(move || crate::dlm::ticker(jct, txc));
    }

    // 4) workers
    let done0: usize = (0..n).filter(|i| seg_done(&dir, *i)).count();
    let finished = Arc::new(AtomicUsize::new(done0));
    let next = Arc::new(AtomicUsize::new(0));
    let segs_count = n;

    let worker_n = {
        let s = crate::cfg::settings().max_segments;
        s.clamp(1, 8).min(n)
    };
    let mut handles = Vec::new();
    for _w in 0..worker_n {
        let agent = agent.clone();
        let jc = jc.clone();
        let dir = dir.clone();
        let segs_list = segs.clone();
        let fixed_iv = key.as_ref().and_then(|k| k.iv);
        let key = key_bytes.clone();
        let next = next.clone();
        let finished = finished.clone();
        let base_seq = media_seq;
        if let Ok(h) = std::thread::Builder::new().name("hls-worker".into()).spawn(move || loop {
            if jc.cancel.load(Ordering::SeqCst) || jc.pause.load(Ordering::SeqCst) { return; }
            let i = next.fetch_add(1, Ordering::SeqCst);
            if i >= segs_count { return; }
            if seg_done(&dir, i) { continue; }

            let mut backoff = 1u64;
            let mut raw: Option<Vec<u8>> = None;
            for _att in 0..3 {
                if jc.cancel.load(Ordering::SeqCst) || jc.pause.load(Ordering::SeqCst) { return; }
                match get_bytes(&agent, &segs_list[i], &jc.meta.referer, &jc.meta.cookies) {
                    Ok(r) => { raw = Some(r); break; }
                    Err(e) => {
                        if backoff > 8 {
                            jc.set_err(format!("segment {i} failed: {e}"));
                            jc.cancel.store(true, Ordering::SeqCst);
                            return;
                        }
                        std::thread::sleep(Duration::from_secs(backoff));
                        backoff *= 2;
                    }
                }
            }
            let Some(raw) = raw else { continue };

            // decrypt when AES-128 (key validated as exactly 16 bytes earlier)
            let iv = fixed_iv.unwrap_or_else(|| seq_iv(base_seq + i as u64));
            let karr: Option<[u8; 16]> = key.as_ref().map(|k| k.as_slice().try_into().unwrap());
            let out_bytes = match &karr {
                Some(k) => match decrypt_seg(k, &iv, &raw) {
                    Ok(d) => d,
                    Err(e) => {
                        jc.set_err(format!("decrypt segment {i}: {e}"));
                        jc.cancel.store(true, Ordering::SeqCst);
                        return;
                    }
                },
                None => raw,
            };

            let mut ok = false;
            if let Ok(mut f) = std::fs::File::create(seg_path(&dir, i)) {
                ok = f.write_all(&out_bytes).is_ok();
            }
            if ok {
                jc.done.fetch_add(out_bytes.len() as u64, Ordering::Relaxed);
                let fin = finished.fetch_add(1, Ordering::SeqCst) + 1;
                let done_bytes = jc.done.load(Ordering::Relaxed);
                let est = done_bytes.saturating_mul(segs_count as u64) / fin as u64;
                jc.total.store(est, Ordering::Relaxed);
            } else {
                jc.set_err("disk write error".into());
                jc.cancel.store(true, Ordering::SeqCst);
                return;
            }
        }) {
            handles.push(h);
        }
    }
    for h in handles { let _ = h.join(); }

    // 5) completion
    let err = jc.error();
    let paused = jc.pause.swap(false, Ordering::SeqCst);
    let stopped = jc.cancel.swap(false, Ordering::SeqCst);
    if paused && err.is_none() && !stopped {
        jc.set_state(job::ST_PAUSED);
        crate::dlm::engine().emit_state(&jc);
        crate::dlm::engine().persist();
        return;
    }
    if err.is_some() {
        jc.set_state(job::ST_ERROR);
        crate::dlm::engine().emit_state(&jc);
        crate::dlm::engine().persist();
        return;
    }
    if stopped {
        jc.set_state(job::ST_QUEUED); // stopped, keep parts, resumable
        crate::dlm::engine().emit_state(&jc);
        crate::dlm::engine().persist();
        return;
    }
    if (0..n).all(|i| seg_done(&dir, i)) {
        if merge_hls(&jc, &dir, ext, n) {
            let _ = std::fs::remove_dir_all(&dir);
            jc.set_state(job::ST_DONE);
        } else {
            jc.set_err("failed to merge segments".to_string());
            jc.set_state(job::ST_ERROR);
        }
    } else {
        jc.set_state(job::ST_ERROR);
    }
    crate::dlm::engine().emit_state(&jc);
    crate::dlm::engine().persist();
}

fn fail(jc: Arc<JobCore>, msg: &str) {
    jc.set_err(msg.to_string());
    jc.set_state(job::ST_ERROR);
    crate::dlm::engine().emit_state(&jc);
    crate::dlm::engine().persist();
}

fn merge_hls(jc: &Arc<JobCore>, dir: &Path, ext: &'static str, n: usize) -> bool {
    let name = jc.name();
    // Strip only after a *known* extension: page-title names like "Kaiju No. 8"
    // must keep their text (the old rsplit('.') rule would truncate them to "Kaiju No").
    const KNOWN_EXT: [&str; 14] = ["m3u8", "m3u", "mpd", "mp4", "ts", "m4v", "webm", "mkv", "mov", "avi", "wmv", "flv", "m4a", "mp3"];
    let stem = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && e.len() <= 5 && KNOWN_EXT.contains(&e.to_ascii_lowercase().as_str()) => s.to_string(),
        _ => name.clone(),
    };
    if stem.is_empty() { return false; }
    let _ = std::fs::create_dir_all(&jc.meta.folder);
    let fin = crate::job::unique_in(&jc.meta.folder, &format!("{stem}.{ext}"));
    let mut out = match std::fs::File::create(&fin) { Ok(f) => f, Err(_) => return false };

    // init (fMP4) before the segments
    if let Ok(mut f) = std::fs::File::open(dir.join("init.part")) {
        let _ = std::io::copy(&mut f, &mut out);
    }
    let mut buf = vec![0u8; 1024 * 1024];
    let mut ok = true;
    for i in 0..n {
        if !ok { break; }
        match std::fs::File::open(seg_path(dir, i)) {
            Ok(mut f) => loop {
                match f.read(&mut buf) {
                    Ok(0) => break,
                    Ok(rd) => { if out.write_all(&buf[..rd]).is_err() { ok = false; break; } }
                    Err(_) => { ok = false; break; }
                }
            },
            Err(_) => { ok = false; }
        }
    }
    drop(out);
    if ok {
        jc.set_name(fin.file_name().unwrap_or_default().to_string_lossy().to_string());
        true
    } else {
        let _ = std::fs::remove_file(&fin);
        false
    }
}
