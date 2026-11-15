use ureq::Agent;

/// (total bytes, total_known, mime, content-disposition)
pub type Probe = (u64, bool, Option<String>, Option<String>);

pub fn probe(agent: &Agent, url: &str, referer: Option<String>, cookies: Option<String>) -> Probe {
    let mut base = agent.head(url);
    base = base.set("Accept-Ranges", "bytes");
    if let Some(r) = &referer { base = base.set("Referer", r); }
    if let Some(c) = &cookies { base = base.set("Cookie", c); }
    match base.call() {
        Ok(resp) => {
            let len = resp.header("Content-Length").and_then(|s| s.parse::<u64>().ok());
            let mime = resp.header("Content-Type").map(|s| s.to_string());
            let disp = resp.header("Content-Disposition").map(|s| s.to_string());
            let ar = resp.header("Accept-Ranges").map(|s| s.eq_ignore_ascii_case("bytes")).unwrap_or(false);
            match len {
                Some(l) if l > 0 && ar => (l, true, mime, disp),
                _ => ranged_get(agent, url, referer, cookies),
            }
        }
        Err(_) => ranged_get(agent, url, referer, cookies),
    }
}

fn ranged_get(agent: &Agent, url: &str, referer: Option<String>, cookies: Option<String>) -> Probe {
    let mut base = agent.get(url).set("Range", "bytes=0-0");
    if let Some(r) = &referer { base = base.set("Referer", r); }
    if let Some(c) = &cookies { base = base.set("Cookie", c); }
    if let Ok(resp) = base.call() {
        let mime = resp.header("Content-Type").map(|s| s.to_string());
        let disp = resp.header("Content-Disposition").map(|s| s.to_string());
        if let Some(cr) = resp.header("Content-Range") {
            // "bytes 0-0/TOTAL" (TOTAL may be *)
            if let Some(total_s) = cr.rsplit('/').next() {
                if total_s == "*" {
                    return (0, false, mime, disp);
                }
                if let Ok(t) = total_s.parse::<u64>() { return (t, true, mime, disp); }
            }
        }
        let len = resp.header("Content-Length").and_then(|s| s.parse::<u64>().ok());
        (len.unwrap_or(0), len.is_some(), mime, disp)
    } else {
        (0, false, None, None)
    }
}

/// Extract filename from Content-Disposition, favored over default.
pub fn filename_of(disp: &Option<String>, _mime_ext: &str, default: &str) -> Option<String> {
    let d = disp.as_ref()?;
    // filename="..." or filename=...
    let low = d.to_ascii_lowercase();
    if let Some(i) = low.find("filename") {
        let tail = &d[i..];
        if let Some(eq) = tail.find('=') {
            let rest = tail[eq + 1..].trim_start();
            let (name, _) = split_once_quoted(rest);
            let name = name.trim_matches('"').trim();
            if !name.is_empty() {
                let cleaned = crate::job::sanitize_filename(name);
                if cleaned.to_ascii_lowercase() != default.to_ascii_lowercase() && !cleaned.is_empty() {
                    return Some(cleaned);
                }
            }
        }
    }
    None
}

fn split_once_quoted(s: &str) -> (String, String) {
    let s = s.trim_start();
    if s.starts_with('"') {
        if let Some(end) = s[1..].find('"') {
            return (s[1..1 + end].to_string(), s[1 + end + 1..].to_string());
        }
    }
    match s.split_once(&[';', ' ', '\t']) {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (s.to_string(), String::new()),
    }
}
