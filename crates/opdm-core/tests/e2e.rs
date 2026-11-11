//! End-to-end tests: mini HTTP server (with Range) + engine + WS server.
//! NOTE: single test fn because Engine/cfg use process-wide OnceLock state.

use opdm_core::cfg;
use opdm_core::dlm::{self, Ev};
use opdm_core::wssrv::{self, WsSink};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/* ---------------- mini HTTP server with Range support ---------------- */

fn start_http(body: Arc<Vec<u8>>) -> (u16, Arc<AtomicU64>) {
    let hits = Arc::new(AtomicU64::new(0));
    let hits2 = hits.clone();
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let mut s = match s { Ok(s) => s, Err(_) => continue };
            let hits = hits2.clone();
            let body = body.clone();
            let size = body.len();
            std::thread::spawn(move || {
                // read request head
                let mut req = Vec::new();
                let mut ch = [0u8; 1];
                loop {
                    if s.read_exact(&mut ch).is_err() { return; }
                    req.push(ch[0]);
                    if req.ends_with(b"\r\n\r\n") || req.len() > 64 * 1024 { break; }
                }
                let head = String::from_utf8_lossy(&req).to_ascii_lowercase();
                let is_head = head.starts_with("head ");
                hits.fetch_add(1, Ordering::SeqCst);

                if is_head {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n"
                    );
                    let _ = s.write_all(resp.as_bytes());
                    return;
                }

                // Range header?
                let range = head.lines().find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    if k.trim() == "range" {
                        Some(v.trim().trim_start_matches("bytes=").to_string())
                    } else {
                        None
                    }
                });

                match range.and_then(|r| {
                    let (a, bnd) = r.split_once('-')?;
                    let start: u64 = a.trim().parse().ok()?;
                    Some((start, bnd.trim().parse::<u64>().ok()))
                }) {
                    Some((start, end)) => {
                        let e = end.map(|x| x.min(size as u64 - 1)).unwrap_or(size as u64 - 1);
                        if start > e { let _ = s.write_all(b"HTTP/1.1 416 X\r\nContent-Length: 0\r\n\r\n"); return; }
                        let slice = &body[start as usize..=(e as usize)];
                        let resp = format!(
                            "HTTP/1.1 206 Partial\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{e}/{size}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            slice.len()
                        );
                        let _ = s.write_all(resp.as_bytes());
                        let _ = s.write_all(slice);
                    }
                    None => {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n"
                        );
                        let _ = s.write_all(resp.as_bytes());
                        let _ = s.write_all(&body);
                    }
                }
            });
        }
    });
    (port, hits)
}

/* ---------------- mini HLS server (master + AES-128 media playlist) ---------------- */

fn start_hls_server() -> (u16, Arc<Vec<u8>>) {
    use aes::Aes128;
    use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};

    // plaintext payloads of the 3 segments (distinct lengths/content)
    let p: ArrayVec = {
        let mut v: Vec<Vec<u8>> = Vec::new();
        v.push((0..70_000usize).map(|i| ((i % 7) + 1) as u8).collect());
        v.push((0..23_000usize).map(|i| ((i % 250) ^ 0x33) as u8).collect());
        v.push((0..5_000usize).map(|i| (i % 251) as u8).collect());
        v
    };

    let key = [0x2bu8; 16];
    let iv_hex = "000102030405060708090a0b0c0d0e0f";
    let mut iv = [0u8; 16];
    for (i, pair) in iv_hex.as_bytes().chunks(2).enumerate() {
        iv[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
    }

    let mut ct: Vec<Vec<u8>> = Vec::new();
    for seg in &p {
        ct.push(cbc::Encryptor::<Aes128>::new_from_slices(&key, &iv).unwrap().encrypt_padded_vec_mut::<Pkcs7>(seg));
    }
    // merged .ts must equal the concatenation of decrypted segments
    let expected = Arc::new(p.iter().flatten().copied().collect::<Vec<u8>>());

    let master =
        "#EXTM3U\n#EXT-X-VERSION:3\n\
         #EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720\nmedia_720.m3u8\n\
         #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080\n/media/media_1080.m3u8\n";
    let media =
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:77\n\
         #EXT-X-KEY:METHOD=AES-128,URI=\"/key\",IV=0x000102030405060708090a0b0c0d0e0f\n\
         #EXTINF:4.0,\n/media/seg0.ts\n#EXTINF:4.0,\n/media/seg1.ts\n#EXTINF:4.0,\n/media/seg2.ts\n#EXT-X-ENDLIST\n";

    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let ct = Arc::new(ct);
    std::thread::spawn(move || {
        for s in l.incoming() {
            let mut s = match s { Ok(s) => s, Err(_) => continue };
            let ct = ct.clone();
            std::thread::spawn(move || {
                let mut req = Vec::new();
                let mut ch = [0u8; 1];
                loop {
                    if s.read_exact(&mut ch).is_err() { return; }
                    req.push(ch[0]);
                    if req.ends_with(b"\r\n\r\n") || req.len() > 16 * 1024 { break; }
                }
                let head = String::from_utf8_lossy(&req).to_string();
                let path = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("").to_string();
                let path = path.split(['?', '#']).next().unwrap_or("").to_string();

                let (ctype, body): (&str, Vec<u8>) = match path.as_str() {
                    "/get/master.m3u8" => ("application/vnd.apple.mpegurl", master.as_bytes().to_vec()),
                    "/media_720.m3u8" => ("application/vnd.apple.mpegurl", master.as_bytes().to_vec()),
                    "/media/media_1080.m3u8" => ("application/vnd.apple.mpegurl", media.as_bytes().to_vec()),
                    "/key" => ("application/octet-stream", key.to_vec()),
                    "/media/seg0.ts" => ("application/octet-stream", ct[0].clone()),
                    "/media/seg1.ts" => ("application/octet-stream", ct[1].clone()),
                    "/media/seg2.ts" => ("application/octet-stream", ct[2].clone()),
                    _ => ("text/plain", b"not found".to_vec()),
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes());
                let _ = s.write_all(&body);
            });
        }
    });
    (port, expected)
}

type ArrayVec = Vec<Vec<u8>>;

/* ---------------- WS sink ---------------- */

struct Sink;
impl WsSink for Sink {
    fn cmd(&self, c: wssrv::WsCmd) -> Value {
        match c {
            wssrv::WsCmd::Ping => json!({"ok": true, "app": "OpenDM"}),
            wssrv::WsCmd::Show => json!({"ok": true}),
            wssrv::WsCmd::Add { url, .. } => {
                let e = dlm::engine();
                let id = e.queue(&url, None, None, None, None).unwrap_or_default();
                json!({"ok": true, "id": id})
            }
        }
    }
}

/* ---------------- helpers ---------------- */

fn wait_done(eng: &dlm::Engine, id: &str, secs: u64) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        if eng.find(id).map(|j| j.state() == opdm_core::job::ST_DONE).unwrap_or(false) {
            std::thread::sleep(Duration::from_millis(80)); // let merge settle
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn mask_write(c: &mut TcpStream, payload: &[u8]) {
    c.write_all(&[0x81]).unwrap();
    let n = payload.len();
    assert!(n < 126);
    c.write_all(&[0x80u8 | n as u8]).unwrap();
    let mask = [1u8, 2, 3, 4];
    c.write_all(&mask).unwrap();
    let mut masked = payload.to_vec();
    for (i, byte) in masked.iter_mut().enumerate() { *byte ^= mask[i % 4]; }
    c.write_all(&masked).unwrap();
    c.flush().unwrap();
}

fn read_text(c: &mut TcpStream, timeout: Duration) -> String {
    c.set_read_timeout(Some(timeout)).unwrap();
    let mut h = [0u8; 2];
    c.read_exact(&mut h).unwrap();
    let len = (h[1] & 0x7f) as usize;
    let mut p = vec![0u8; len];
    c.read_exact(&mut p).unwrap();
    String::from_utf8_lossy(&p).to_string()
}

/* ---------------- the test ---------------- */

#[test]
fn engine_and_ws_end_to_end() {
    let tmp = std::env::temp_dir().join(format!("opdm-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();

    // install settings (cfg global used by queue())
    cfg::init();
    cfg::update(|s| {
        s.download_dir = tmp.clone();
        s.max_segments = 8;
        s.port = 19527;
        s.user_agent = "opdm-e2e".into();
    });

    // engine (OnceLock; init once)
    let (tx, _rx) = mpsc::channel::<Ev>();
    dlm::Engine::init(Arc::new(Mutex::new(cfg::settings())), tx);

    /* ---- part 1: direct queue, multi-segment download + merge ---- */
    const TOTAL: usize = 2 * 1024 * 1024 + 12345;
    let body: Arc<Vec<u8>> = Arc::new((0..TOTAL).map(|i| (i % 251) as u8).collect());
    let (hport, hits) = start_http(body.clone());

    let eng = dlm::engine();
    let id = eng.queue(&format!("http://127.0.0.1:{hport}/file.bin"), None, None, None, None).expect("queue");
    assert!(wait_done(eng, &id, 30), "engine download must complete");

    let got = std::fs::read(tmp.join("file.bin")).expect("merged file exists");
    assert_eq!(got.len(), body.len(), "merged length matches source");
    assert_eq!(&got[..], &body[..], "merged bytes match source");
    // 1 HEAD + 8 range workers = 9 connections minimum
    let segs = cfg::settings().max_segments.min(16) as u64;
    assert!(hits.load(Ordering::SeqCst) >= segs, "expected multi-segment connections, got {}", hits.load(Ordering::SeqCst));

    /* ---- part 2: HLS master → best variant → AES-128 decrypt → .ts merge ---- */
    let (hls_port, hls_expected) = start_hls_server();
    let hls_url = format!("http://127.0.0.1:{hls_port}/get/master.m3u8");
    let id3 = eng.queue(&hls_url, None, None, None, None).expect("queue hls");
    assert!(wait_done(eng, &id3, 30), "HLS download must complete: state={} err={:?} done={} total={} name={}",
        eng.find(&id3).map(|j| j.state()).unwrap_or(0),
        eng.find(&id3).and_then(|j| j.error()),
        eng.find(&id3).map(|j| j.done()).unwrap_or(0),
        eng.find(&id3).map(|j| j.total()).unwrap_or(0),
        eng.find(&id3).map(|j| j.name()).unwrap_or_default());
    assert!(wait_done(eng, &id3, 30), "HLS download must complete");

    let got_ts = std::fs::read(tmp.join("master.ts")).expect("merged HLS file exists");
    assert_eq!(got_ts.len(), hls_expected.len(), "ts length: got {} want {}", got_ts.len(), hls_expected.len());
    if let Some(d) = got_ts.iter().zip(hls_expected.iter()).position(|(a, b)| a != b) {
        let hex = |v: &Arc<Vec<u8>>, at: usize| v[at..(at + 24).min(v.len())].iter().map(|b| format!("{b:02x}")).collect::<String>();
        panic!("HLS bytes differ at {} — got {} want {}", d, hex(&got_ts.clone().into(), d), hex(&hls_expected, d));
    }

    /* ---- part 3: WS handshake + ping + add ---- */
    wssrv::spawn(19527, Arc::new(Sink)).unwrap();
    std::thread::sleep(Duration::from_millis(150));

    let mut c = TcpStream::connect("127.0.0.1:19527").unwrap();
    c.write_all(
        b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
          Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
          Sec-WebSocket-Protocol: plugin.v3.opendm.local\r\n\r\n",
    ).unwrap();
    let mut buf = Vec::new();
    let mut ch = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        c.read_exact(&mut ch).unwrap();
        buf.push(ch[0]);
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    assert!(head.contains("101"), "expected 101 upgrade, got: {head}");
    assert!(head.to_ascii_lowercase().contains("sec-websocket-protocol: plugin.v3.opendm.local"), "subprotocol echoed");

    mask_write(&mut c, br#"{"op":"ping"}"#);
    let r = read_text(&mut c, Duration::from_secs(3));
    let v: Value = serde_json::from_str(&r).unwrap();
    assert_eq!(v["ok"], json!(true), "ping ok: {v}");
    assert_eq!(v["app"], json!("OpenDM"), "app hello");

    mask_write(&mut c, format!(r#"{{"op":"add","url":"http://127.0.0.1:{hport}/wsfile.bin"}}"#).as_bytes());
    let r2 = read_text(&mut c, Duration::from_secs(3));
    let v2: Value = serde_json::from_str(&r2).unwrap();
    assert_eq!(v2["ok"], json!(true), "add accepted: {v2}");
    let id2 = v2["id"].as_str().unwrap().to_string();
    assert!(wait_done(eng, &id2, 30), "ws-added download must complete");
    let got2 = std::fs::read(tmp.join("wsfile.bin")).expect("ws file exists");
    assert_eq!(&got2[..], &body[..], "ws-added download bytes match");
}
