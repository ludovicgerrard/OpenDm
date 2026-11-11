//! Minimal RFC 6455 WebSocket server + tiny HTTP capture of the handshake.
//! Implements what the browser extension needs:
//!   GET /?... HTTP/1.1
//!   Upgrade: websocket
//!   Sec-WebSocket-Key: <key>
//!   Sec-WebSocket-Protocol: plugin.v3.opendm.local
use base64::Engine as _;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

pub const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
pub const SUBPROTOCOL: &str = "plugin.v3.opendm.local";

#[derive(Debug, Clone)]
pub enum WsCmd {
    Ping,
    Show,
    /// URL + context from the extension. YouTube watch URLs are noticed by
    /// the sink caller (main.rs) and routed into the yt-dlp pipeline; all
    /// other URLs queue a classic ranged/HLS download.
    Add { url: String, referer: Option<String>, filename: Option<String>, folder: Option<String>, cookies: Option<String> },
}

/// Implemented by the app (needs engine + window handle).
pub trait WsSink: Send + Sync {
    fn cmd(&self, c: WsCmd) -> Value;
}

pub fn spawn(port: u16, sink: Arc<dyn WsSink>) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    std::thread::Builder::new().name("ws-accept".into()).spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    let sink = sink.clone();
                    let _ = std::thread::Builder::new().name("ws-conn".into()).spawn(move || {
                        let _ = serve_conn(s, sink);
                    });
                }
                Err(_) => continue,
            }
        }
    }).expect("spawn ws accept");
    Ok(())
}

fn serve_conn(mut stream: TcpStream, sink: Arc<dyn WsSink>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(300)))?;
    stream.set_nodelay(true).ok();

    // ---- HTTP upgrade request ----
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 || line.trim().is_empty() { break; }
        if head.len() > 16 * 1024 { return Ok(()); }
        head.push_str(&line);
    }
    let first = head.lines().next().unwrap_or("");
    if !first.starts_with("GET ") { return Ok(()); }
    let lower = head.to_ascii_lowercase();
    if !lower.contains("upgrade: websocket") { return Ok(()); }
    let key = header(&head, "sec-websocket-key").ok_or(std::io::Error::new(std::io::ErrorKind::InvalidData, "no ws key"))?;
    let proto_req = header(&head, "sec-websocket-protocol");

    // ---- 101 response ----
    let mut h = Sha1::new();
    h.update(format!("{key}{WS_GUID}"));
    let accept = base64::engine::general_purpose::STANDARD.encode(h.finalize());
    let mut resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n"
    );
    if let Some(p) = proto_req {
        // echo the first requested subprotocol we know, else the first offered
        let offered: Vec<&str> = p.split(',').map(|s| s.trim()).collect();
        let pick = offered.iter().find(|s| **s == SUBPROTOCOL).or_else(|| offered.first()).copied();
        if let Some(pp) = pick { resp.push_str(&format!("Sec-WebSocket-Protocol: {pp}\r\n")); }
    }
    resp.push_str("\r\n");
    stream.write_all(resp.as_bytes())?;

    // ---- WebSocket frames ----
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let (op, payload, fin) = match read_frame(&mut reader) {
            Ok(f) => f,
            Err(_) => return Ok(()),
        };
        match op {
            0x8 => { write_frame(&mut stream, 0x8, b"")?; return Ok(()); } // close
            0x9 => { write_frame(&mut stream, 0xA, &payload)?; } // ping -> pong
            0xA => {} // pong ignore
            0x1 | 0x2 | 0x0 => {
                buf.extend_from_slice(&payload);
                if fin && !buf.is_empty() {
                    let msg = String::from_utf8_lossy(&buf).to_string();
                    buf.clear();
                    let reply = handle_text(&msg, sink.as_ref());
                    write_frame(&mut stream, 0x1, reply.as_bytes())?;
                }
            }
            _ => {} // ignore others
        }
    }
}

fn handle_text(msg: &str, sink: &dyn WsSink) -> String {
    let v: Value = match serde_json::from_str(msg) {
        Ok(v) => v,
        Err(_) => return json!({"ok": false, "error": "bad json"}).to_string(),
    };
    let op = v.get("op").and_then(|x| x.as_str()).unwrap_or("");
    match op {
        "ping" => sink.cmd(WsCmd::Ping).to_string(),
        "add" => {
            let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if url.is_empty() { return json!({"ok": false, "error": "no url"}).to_string(); }
            sink.cmd(WsCmd::Add {
                url,
                referer: v.get("referer").and_then(|x| x.as_str()).map(|s| s.to_string()),
                filename: v.get("filename").and_then(|x| x.as_str()).map(|s| s.to_string()),
                folder: None,
                cookies: v.get("cookies").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()),
            }).to_string()
        }
        "show" => sink.cmd(WsCmd::Show).to_string(),
        "takeover" => sink.cmd(WsCmd::Add {
            url: v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            referer: v.get("referer").and_then(|x| x.as_str()).map(|s| s.to_string()),
            filename: v.get("filename").and_then(|x| x.as_str()).map(|s| s.to_string()),
            folder: None,
            cookies: v.get("cookies").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()),
        }).to_string(),
        _ => json!({"ok": false, "error": "unknown op"}).to_string(),
    }
}

fn header(head: &str, name: &str) -> Option<String> {
    head.lines()
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim().to_string())
}

/* ---------------- frame codec ---------------- */

fn read_frame(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>, bool)> {
    let mut hdr = [0u8; 2];
    r.read_exact(&mut hdr)?;
    let fin = hdr[0] & 0x80 != 0;
    let op = hdr[0] & 0x0f;
    let masked = hdr[1] & 0x80 != 0;
    let mut len = (hdr[1] & 0x7f) as u64;
    if len == 126 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b)?;
        len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
        let mut b = [0u8; 8];
        r.read_exact(&mut b)?;
        len = u64::from_be_bytes(b);
    }
    if len > 32 * 1024 * 1024 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large")); }
    let mask = if masked { let mut m = [0u8; 4]; r.read_exact(&mut m)?; Some(m) } else { None };
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    if let Some(m) = mask {
        for (i, b) in payload.iter_mut().enumerate() { *b ^= m[i % 4]; }
    }
    Ok((op, payload, fin))
}

pub fn write_frame(w: &mut impl Write, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&[0x80 | opcode])?;
    let n = payload.len();
    if n < 126 {
        w.write_all(&[n as u8])?;
    } else if n < 65536 {
        w.write_all(&[126u8])?;
        w.write_all(&(n as u16).to_be_bytes())?;
    } else {
        w.write_all(&[127u8])?;
        w.write_all(&(n as u64).to_be_bytes())?;
    }
    w.write_all(payload) // server frames are unmasked
}
