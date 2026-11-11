use serde_json::{json, Value};

fn out(v: &Value) {
    use std::io::Write;
    let s = v.to_string();
    let mut o = std::io::stdout().lock();
    let b = s.as_bytes();
    let _ = o.write_all(&(b.len() as u32).to_ne_bytes());
    let _ = o.write_all(b);
    let _ = o.flush();
}

fn send_via_ws(port: u16, url: &str, referer: Option<&str>, filename: Option<&str>) -> Result<Value, String> {
    // Find JSON body string pos: use tcp
    use std::net::TcpStream;
    use std::io::{Read, Write};

    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).ok();
    stream.set_write_timeout(Some(std::time::Duration::from_secs(2))).ok();

    let key = base64::engine::general_purpose::STANDARD.encode(uuid_for_key());
    let mut req = format!(
        "GET /?cid=host&rnd=0 HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        port, key
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    // read until \r\n\r\n
    let mut hdr = Vec::new();
    let mut b = [0u8; 1];
    loop {
        if hdr.len() > 8192 { return Err("bad handshake".into()); }
        stream.read_exact(&mut b).map_err(|e| e.to_string())?;
        hdr.push(b[0]);
        if hdr.ends_with(b"\r\n\r\n") { break; }
    }
    let h = String::from_utf8_lossy(&hdr).to_string();
    if !h.contains("101") { return Err("handshake failed".into()); }

    // frames
    fn write_frame(w: &mut impl Write, payload: &[u8]) -> std::io::Result<()> {
        let fin = 0x80u8;
        let opcode = 0x1u8;
        w.write_all(&[fin | opcode])?;
        let n = payload.len();
        if n < 126 {
            w.write_all(&[0x80 | n as u8])?;
        } else if n < 65536 {
            w.write_all(&[0x80 | 126u8])?;
            w.write_all(&(n as u16).to_be_bytes())?;
        } else {
            w.write_all(&[0x80 | 127u8])?;
            w.write_all(&(n as u64).to_be_bytes())?;
        }
        let mask = [1u8, 2, 3, 4];
        w.write_all(&mask)?;
        for (i, byte) in payload.iter().enumerate() {
            w.write_all(&[*byte ^ mask[i % 4]])?;
        }
        Ok(())
    }

    // Build message
    let mut m = serde_json::Map::new();
    m.insert("op".into(), json!("add"));
    m.insert("url".into(), json!(url));
    if let Some(r) = referer { m.insert("referer".into(), json!(r)); }
    if let Some(f) = filename { m.insert("filename".into(), json!(f)); }
    let payload = Value::Object(m).to_string().into_bytes();
    let _ = write_frame(&mut stream, &payload);
    let _ = &mut req;

    // Read frames until we get text
    let _fuse = std::time::Instant::now();
    let mut resp_hdr = [0u8; 2];
    if stream.read_exact(&mut resp_hdr).is_err() {
        return Ok(json!({"ok": false, "error": "no reply from app"}));
    }
    let lh = (resp_hdr[1] & 0x7f) as usize;
    let mut payload = Vec::new();
    if lh <= 125 { payload.resize(lh, 0); stream.read_exact(&mut payload).map_err(|e| e.to_string())?; }
    else { return Err("large reply from app not supported".into()); }
    let v: Value = serde_json::from_slice(&payload).unwrap_or(json!({"ok": true}));
    Ok(v)
}

fn uuid_for_key() -> [u8; 4] {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
    t.to_le_bytes()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // --allow-ish: only port arg if present
    let port: u16 = {
        let mut p = 9100u16;
        for a in &args {
            if let Some(p2) = a.strip_prefix("--port=") {
                if let Ok(v) = p2.parse::<u16>() { p = v; }
            }
        }
        p
    };

    // Read native messaging framing: 4-byte LE length + payload.
    loop {
        let mut lenb = [0u8; 4];
        use std::io::Read;
        if std::io::stdin().read_exact(&mut lenb).is_err() { break; }
        let len = u32::from_le_bytes(lenb) as usize;
        if len > 8 * 1024 * 1024 { out(&json!({"error": "message too large"})); break; }
        let mut buf = vec![0u8; len];
        if std::io::stdin().read_exact(&mut buf).is_err() { break; }

        let msg: Value = match serde_json::from_slice(&buf) {
            Ok(v) => v,
            Err(_) => { out(&json!({"runtimeError": "invalid JSON from browser"})); continue; }
        };

        // Only 'add' op supported like IDM's bridge.
        let url = msg.get("url").and_then(|v| v.as_str()).map(|s| s.to_string());
        match url {
            Some(u) if !u.is_empty() => {
                let referer = msg.get("referer").and_then(|v| v.as_str()).map(|s| s.to_string());
                let fname = msg.get("filename").and_then(|v| v.as_str()).map(|s| s.to_string());
                let port2 = msg.get("port").and_then(|v| v.as_u64()).map(|v| v as u16);
                let res = send_via_ws(port2.unwrap_or(port), &u, referer.as_deref(), fname.as_deref());
                match res {
                    Ok(v) => { let mut r = v; r["via"] = json!("ws"); out(&r); }
                    Err(e) => out(&json!({"op": "ack", "ok": false, "error": format!("not sent to app: {e}")})),
                }
            }
            _ => out(&json!({"op": "ack", "ok": false, "error": "no url in message"})),
        }
    }
}
