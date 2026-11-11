//! Unit tests for the direct-download finalize guard (`dlm::validate_final`).
//! IDM-parity: finished googlevideo/videoplayback files must look like real
//! media (or be a valid MPEG-TS merge) — never the 31-byte SABR error protobuf.

use opdm_core::dlm::__test;

fn tmp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("opdm_vf_{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

const PLAYBACK_URL: &str = "https://rr1---sn-h50gpup0nuxaxjvh-hg0k.googlevideo.com/videoplayback?expire=1";
const MANIFEST_URL: &str = "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1/x.m3u8";
const NON_YT_URL: &str = "https://example.com/videos/movie.mp4";

#[test]
fn sabr_error_protobuf_is_rejected() {
    // The exact 31-byte body observed in the wild: "sabr.malformed_config".
    let body: &[u8] = &[
        0x2c, 0x1d, 0x0a, 0x15, b's', b'a', b'b', b'r', b'.', b'm', b'a', b'l', b'f', b'o', b'r', b'm',
        b'e', b'd', b'_', b'c', b'o', b'n', b'f', b'i', b'g', 0x10, 0x02, 0x1a, 0x02, 0x20, 0x04,
    ];
    let p = tmp_file("sabr.bin", body);
    assert!(__test::validate(&p, PLAYBACK_URL).is_err());
}

#[test]
fn short_protobuf_is_rejected() {
    // Shorter than a TS-packet stride (188) — cannot be media, cannot pass.
    let p = tmp_file("tiny.bin", &[0x2c, 0x1d, 0x0a, 0x15]);
    assert!(__test::validate(&p, PLAYBACK_URL).is_err());
}

#[test]
fn mpeg_ts_merge_is_accepted() {
    // Two 188-byte TS packets, sync byte twice (end of packet 1 too).
    let mut ts = vec![0u8; 188 * 2];
    ts[0] = 0x47;
    ts[188] = 0x47;
    ts[1] = 0x49; // not part of any other magic pattern
    let p = tmp_file("merge.ts", &ts);
    assert!(__test::validate(&p, MANIFEST_URL).is_ok());
    assert!(__test::validate(&p, PLAYBACK_URL).is_ok());
}

#[test]
fn truncated_ts_is_rejected() {
    // Sync byte present but no second packet stride — suspicious; must fail.
    let mut ts = vec![0u8; 100];
    ts[0] = 0x47;
    let p = tmp_file("half.ts", &ts);
    assert!(__test::validate(&p, PLAYBACK_URL).is_err());
}

#[test]
fn mp4_is_accepted() {
    let mut f = vec![0u8; 64];
    f[4..8].copy_from_slice(b"ftyp");
    let p = tmp_file("fusion.mp4", &f);
    assert!(__test::validate(&p, PLAYBACK_URL).is_ok());
}

#[test]
fn non_googlevideo_urls_are_not_guarded() {
    let p = tmp_file("anything.bin", &[0x2c, 0x1d, 0x0a, 0x15, 0x7f, 0x47, 0x10]);
    assert!(__test::validate(&p, NON_YT_URL).is_ok());
}
