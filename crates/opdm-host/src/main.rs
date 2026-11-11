// OpenDMMsgHost.exe — native messaging bridge (Chromium), fallback channel
// like IDM's IDMMsgHost.exe. Reads length-prefixed JSON on stdin, forwards
// it to the OpenDM app over WebSocket (127.0.0.1:9100), writes the reply back.
use base64::Engine as _;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::io::{Read, Write};
use std::net::{TcpStream, Shutdown};
use std::time::{SystemTime, UNIX_EPOCH};

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

fn out(v: &Value) {
    let s = v.to_string();
    let mut o = std::io::stdout().lock();
    let b = s.as_bytes();
    let _ = o.write_all(&(b.len() as u32).to_le_bytes());
    let _ = o.write_all(b);
    let _ = o.flush();
}

fn rand_bytes() -> [u8; 4] {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    n.to_le_bytes()
}

fn ws_connect(port: u16) -> Result<TcpStream, String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.set_nodelay(true).ok();
    let key = base64::engine::general_purpose::STANDARD.encode(rand_bytes());
    let req = format!(
        "GET /?cid=nmhost HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: plugin.v3.opendm.local\r\n\r\n"
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut hdr = Vec::new();
    let mut b = [0u8; 1];
    loop {
        s.read_exact(&mut b).map_err(|e| e.to_string())?;
        hdr.push(b[0]);
        if hdr.len() > 8192 { return Err("handshake overflow".into()); }
        if hdr.ends_with(b"\r\n\r\n") { break; }
    }
    let head = String::from_utf8_lossy(&hdr).to_string();
    if !head.contains("101") { return Err("not a websocket 101".into()); }
    let _ = Sha1::new(); // keep dep (accept verification optional)
    Ok(s)
}

fn ws_write(s: &mut TcpStream, payload: &[u8]) -> std::io::Result<()> {
    s.write_all(&[0x81])?; // FIN + text
    let n = payload.len();
    if n < 126 { s.write_all(&[0x80u8 | n as u8])?; }
    else if n < 65536 { s.write_all(&[0x80u8 | 126])?; s.write_all(&(n as u16).to_be_bytes())?; }
    else { s.write_all(&[0x80u8 | 127])?; s.write_all(&(n as u64).to_be_bytes())?; }
    let mask = rand_bytes();
    s.write_all(&mask)?;
    let mut masked = payload.to_vec();
    for (i, b) in masked.iter_mut().enumerate() { *b ^= mask[i % 4]; }
    s.write_all(&masked)?;
    s.flush()
}

fn ws_read_one(s: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut h = [0u8; 2];
    s.read_exact(&mut h)?;
    let op = h[0] & 0x0f;
    let mut len = (h[1] & 0x7f) as u64;
    if len == 126 { let mut b = [0u8; 2]; s.read_exact(&mut b)?; len = u16::from_be_bytes(b) as u64; }
    else if len == 127 { let mut b = [0u8; 8]; s.read_exact(&mut b)?; len = u64::from_be_bytes(b); }
    let mask = if h[1] & 0x80 != 0 { let mut m = [0u8; 4]; s.read_exact(&mut m)?; Some(m) } else { None };
    let mut p = vec![0u8; len as usize];
    if len > 0 { s.read_exact(&mut p)?; }
    if let Some(m) = mask {
        for (i, b) in p.iter_mut().enumerate() { *b ^= m[i % 4]; }
    }
    if op == 0x8 { return Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "closed")); }
    Ok(p)
}

fn forward(port: u16, msg: &Value) -> Value {
    let mut s = match ws_connect(port) {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": format!("app offline ({e})")}),
    };
    if let Err(e) = ws_write(&mut s, msg.to_string().as_bytes()) {
        let _ = s.shutdown(Shutdown::Both);
        return json!({"ok": false, "error": format!("send failed ({e})")});
    }
    match ws_read_one(&mut s) {
        Ok(reply) => {
            let _ = s.shutdown(Shutdown::Both);
            serde_json::from_slice(&reply).unwrap_or_else(|_| json!({"ok": true}))
        }
        Err(e) => json!({"ok": false, "error": format!("no reply ({e})")}),
    }
}

fn main() {
    let mut port = 9100u16;
    for a in std::env::args().skip(1) {
        if let Some(v) = a.strip_prefix("--port=") {
            if let Ok(p) = v.parse::<u16>() { port = p; }
        }
    }

    let mut stdin = std::io::stdin().lock();
    loop {
        let mut lenb = [0u8; 4];
        if stdin.read_exact(&mut lenb).is_err() { return; } // browser closed the pipe
        let len = u32::from_le_bytes(lenb) as usize;
        if len == 0 { continue; }
        if len > 4 * 1024 * 1024 { out(&json!({"ok": false, "error": "message too large"})); continue; }
        let mut buf = vec![0u8; len];
        if stdin.read_exact(&mut buf).is_err() { return; }

        let msg: Value = match serde_json::from_slice(&buf) {
            Ok(v) => v,
            Err(_) => { out(&json!({"ok": false, "error": "invalid json from browser"})); continue; }
        };
        let op = msg.get("op").and_then(|v| v.as_str()).unwrap_or("").to_string();

        let reply = match op.as_str() {
            "add" | "takeover" => {
                let url = msg.get("url").and_then(|v| v.as_str()).unwrap_or("");
                if url.is_empty() {
                    json!({"ok": false, "error": "no url"})
                } else if url::parse_ok(url) {
                    forward(port, &msg)
                } else {
                    json!({"ok": false, "error": "invalid url"})
                }
            }
            "ping" => forward(port, &json!({"op": "ping"})),
            "show" => forward(port, &json!({"op": "show"})),
            _ => json!({"ok": false, "error": "unsupported op"}),
        };
        out(&reply);
    }
}

// tiny url scheme check without pulling `url` crate into the host
mod url {
    pub fn parse_ok(s: &str) -> bool {
        let l = s.to_ascii_lowercase();
        l.starts_with("http://") || l.starts_with("https://") || l.starts_with("ftp://")
    }
}
