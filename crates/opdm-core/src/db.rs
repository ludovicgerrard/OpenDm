use crate::job::{self, JobCore, Seg};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

#[derive(Serialize, Deserialize)]
pub struct DbJob {
    pub id: String,
    pub url: String,
    pub referer: Option<String>,
    #[serde(default)]
    pub cookies: Option<String>,
    pub name: String,
    pub folder: String,
    pub state: u32,
    pub done: u64,
    pub total: u64,
    #[serde(default)]
    pub segs: Vec<DbSeg>,
    /// "" classic | "ytdlp"
    #[serde(default)]
    pub kind: String,
    /// ytdlp -f selection ("" = yt-dlp default)
    #[serde(default)]
    pub fmtsel: String,
}

#[derive(Serialize, Deserialize)]
pub struct DbSeg { pub start: u64, pub end: u64, pub pos: u64, pub done: bool }

pub fn persist(eng: &crate::dlm::Engine) {
    let v: Vec<DbJob> = eng.list().into_iter().map(|li| DbJob {
        id: li.id,
        url: li.url,
        referer: None,
        cookies: li.cookies,
        name: li.name,
        folder: li.folder.to_string_lossy().to_string(),
        state: li.row.state,
        done: li.row.done,
        total: li.row.total,
        segs: li.row.segs.iter().map(|(s, e, p, d)| DbSeg { start: *s, end: *e, pos: *p, done: *d }).collect(),
        kind: li.kind,
        fmtsel: li.fmtsel,
    }).collect();
    let _ = std::fs::write(crate::cfg::jobs_path(), serde_json::to_vec_pretty(&v).unwrap_or_default());
}

pub fn load_into(eng: &crate::dlm::Engine) {
    let data = match std::fs::read(crate::cfg::jobs_path()) { Ok(d) => d, Err(_) => return };
    let jobs_recent: Vec<DbJob> = serde_json::from_slice(&data).unwrap_or_default();
    for j in jobs_recent {
        let state = match j.state {
            job::ST_RUNNING => job::ST_PAUSED, // don't auto-start on launch
            0 => job::ST_QUEUED,
            s => s,
        };
        let jc: Arc<JobCore> = JobCore::new_for_restore(j.id, j.url, j.referer, j.cookies, PathBuf::from(&j.folder), j.name, j.kind.clone());
        for s in &j.segs {
            jc.segs.lock().unwrap().push(Seg { start: s.start, end: s.end, pos: s.pos, done: s.done });
        }
        jc.done.store(j.done, Ordering::Relaxed);
        jc.total.store(j.total, Ordering::Relaxed);
        jc.set_state(state);
        *jc.fmtsel.lock().unwrap() = j.fmtsel;
        eng.load_restore(jc);
    }
}
