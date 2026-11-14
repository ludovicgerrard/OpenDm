//! Windows Job Object wrapper: kills the WHOLE yt-dlp process tree.
//!
//! The official yt-dlp.exe is a PyInstaller onefile build: it spawns a second
//! yt-dlp.exe (the extracted runtime) that does the real work. Killing the
//! process we spawned (the bootloader) leaves that worker orphaned — the
//! download keeps running after pause/delete (the reported bug). A Job Object
//! kills all descendants at once, and KILL_ON_JOB_CLOSE also takes the tree
//! down if OpenDM itself exits or crashes.

#![cfg(windows)]

use std::os::windows::io::AsRawHandle;

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_ops: u64, write_ops: u64, other_ops: u64,
    read_bytes: u64, write_bytes: u64, other_bytes: u64,
}

#[repr(C)]
struct BasicLimit {
    per_process_user_time: i64,
    per_job_user_time: i64,
    limit_flags: u32,
    min_working_set: usize,
    max_working_set: usize,
    active_processes: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
struct ExtendedLimit {
    basic: BasicLimit,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}

extern "system" {
    fn CreateJobObjectW(attrs: *const core::ffi::c_void, name: *const u16) -> *mut core::ffi::c_void;
    fn SetInformationJobObject(job: *mut core::ffi::c_void, class: i32, info: *const core::ffi::c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: *mut core::ffi::c_void, hproc: *mut core::ffi::c_void) -> i32;
    fn TerminateJobObject(job: *mut core::ffi::c_void, code: u32) -> i32;
    fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
}

/// Owns the job handle. Drop closes it — with KILL_ON_JOB_CLOSE that kills any
/// process still in the tree (e.g. a PyInstaller worker that outlived its
/// bootloader after our own kill).
pub struct KillJob {
    handle: *mut core::ffi::c_void,
}

impl KillJob {
    pub fn new() -> Option<KillJob> {
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() { return None; }
            let ext = ExtendedLimit {
                basic: BasicLimit {
                    per_process_user_time: 0, per_job_user_time: 0,
                    limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    min_working_set: 0, max_working_set: 0,
                    active_processes: 0, affinity: 0,
                    priority_class: 0, scheduling_class: 0,
                },
                io: IoCounters::default(),
                process_memory_limit: 0, job_memory_limit: 0,
                peak_process_memory: 0, peak_job_memory: 0,
            };
            let ok = SetInformationJobObject(
                h, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &ext as *const ExtendedLimit as *const core::ffi::c_void,
                std::mem::size_of::<ExtendedLimit>() as u32,
            );
            if ok == 0 { CloseHandle(h); return None; }
            Some(KillJob { handle: h })
        }
    }

    /// Put the spawned child (and every descendant it creates) into the job.
    pub fn assign(&self, child: &std::process::Child) {
        unsafe {
            let ok = AssignProcessToJobObject(self.handle, child.as_raw_handle() as *mut core::ffi::c_void);
            if ok == 0 {
                crate::diag::info("winjob: AssignProcessToJobObject failed — tree-kill falls back to child.kill()");
            }
        }
    }

    /// Kill every process in the tree (bootloader + PyInstaller worker + ffmpeg).
    pub fn terminate(&self, code: u32) {
        unsafe { TerminateJobObject(self.handle, code); }
    }
}

impl Drop for KillJob {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle); }
    }
}
