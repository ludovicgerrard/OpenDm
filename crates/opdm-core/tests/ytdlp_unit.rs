//! Unit tests for the yt-dlp pipeline helpers (no network, no spawned tools).

use opdm_core::ytdlp;
use serde_json::json;

/* ---------------- URL identity ---------------- */

#[test]
fn youtube_id_accepts_watch_youtu_shorts_embed() {
    assert_eq!(ytdlp::youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), Some("dQw4w9WgXcQ".into()));
    assert_eq!(ytdlp::youtube_id("https://youtu.be/jNQXAC9IVRw?t=3"), Some("jNQXAC9IVRw".into()));
    assert_eq!(ytdlp::youtube_id("https://www.youtube.com/shorts/jNQXAC9IVRw"), Some("jNQXAC9IVRw".into()));
    assert_eq!(ytdlp::youtube_id("https://www.youtube.com/embed/jNQXAC9IVRw"), Some("jNQXAC9IVRw".into()));
    assert_eq!(ytdlp::youtube_id("https://youtube-nocookie.com/embed/jNQXAC9IVRw"), Some("jNQXAC9IVRw".into()));
    assert_eq!(ytdlp::youtube_id("https://m.youtube.com/watch?v=jNQXAC9IVRw&pp=x"), Some("jNQXAC9IVRw".into()));
}

#[test]
fn youtube_id_rejects_others_and_bad_ids() {
    assert_eq!(ytdlp::youtube_id("https://google.com/search?q=x"), None);
    assert_eq!(ytdlp::youtube_id("https://www.googlevideo.com/videoplayback?x=1"), None);
    assert_eq!(ytdlp::youtube_id("https://www.youtube.com/playlist?list=PL1234567890a"), None);
    assert_eq!(ytdlp::youtube_id("https://www.youtube.com/watch?v=toolongid12345"), None);
    assert_eq!(ytdlp::youtube_id("https://www.youtube.com/watch?v=abc"), None);
    assert_eq!(ytdlp::youtube_id("not a url"), None);
}

/* ---------------- URL normalization (repo src/utils/url.ts parity) ---------------- */

#[test]
fn normalize_strips_playlist_context_params_on_single_videos() {
    assert_eq!(
        ytdlp::normalize_watch_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLX&index=4"),
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    // start_radio / playnext too
    let out = ytdlp::normalize_watch_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&start_radio=1&playnext=1&x=y");
    assert!(out.contains("v=dQw4w9WgXcQ"));
    assert!(out.contains("x=y"));
    assert!(!out.contains("list=") && !out.contains("index=") && !out.contains("start_radio") && !out.contains("playnext"));
    // playlist URLs must NOT be touched
    let pl = "https://www.youtube.com/playlist?list=PL1234567890a";
    assert_eq!(ytdlp::normalize_watch_url(pl), pl.to_string());
    // youtu.be single video
    let out = ytdlp::normalize_watch_url("https://youtu.be/jNQXAC9IVRw?list=PLZ&t=30");
    assert!(out.contains("youtu.be/jNQXAC9IVRw") && out.contains("t=30") && !out.contains("list="));
}

/* ---------------- download args (repo arguments.rs/output.rs parity) ---------------- */

#[test]
fn download_args_include_progress_templates_deno_and_print_to_file() {
    let dir = std::env::temp_dir();
    let fp = dir.join("OpenDM-test-filepath.txt");
    let folder = dir.join("OpenDM-test-dl");
    let args = ytdlp::download_args("137+140", "videofile", None, &fp, &folder);
    let find = |a: &str| args.iter().position(|x| x == a).map(|i| args[i + 1].clone());

    assert_eq!(find("--progress-template").as_deref(), Some(ytdlp::DL_PROGRESS_TPL));
    assert_eq!(find("-f").as_deref(), Some("137+140"));
    // rename support: job name becomes the output template
    assert_eq!(find("--output").as_deref(), Some("videofile.%(ext)s"));
    assert_eq!(find("-P"), Some(folder.to_string_lossy().to_string()));
    assert_eq!(find("--print-to-file").as_deref(), Some("after_move:filepath"));
    assert_eq!(args.last().map(|s| s.as_str()), Some(fp.to_string_lossy().as_ref()));
    assert!(args.iter().any(|x| x == "--windows-filenames"));
    assert!(args.iter().any(|x| x == "--no-overwrites"));
    assert!(args.iter().any(|x| x == "--newline"));
    // deno is enforced when the managed binary exists (it does not in tests)
    let deno = ytdlp::tool_path(ytdlp::T_DENO);
    let has_deno_pair = args.windows(2).any(|w| w[0] == "--no-js-runtimes" && w[1].starts_with("--js-runtimes"));
    assert_eq!(has_deno_pair, deno.is_file());
}

#[test]
fn parse_args_match_repo_defaults() {
    let args = ytdlp::parse_args(None);
    for want in ["-J", "--ignore-config", "--color", "never", "--no-warnings", "--socket-timeout", "15", "--retries", "3", "--extractor-retries", "2"] {
        assert!(args.iter().any(|x| x == want), "missing {want} in {args:?}");
    }
}

/* ---------------- progress parsing ---------------- */

#[test]
fn parse_progress_reads_both_template_lines() {
    let dl = r#"download:PROGRESS_JSON:{"percent":"42.3%","speed":"33.12MiB/s","eta":"02:11","downloaded":"10.41MiB","total":"24.57MiB","status":"downloading"}"#;
    let (post, v) = ytdlp::parse_progress(dl).unwrap();
    assert!(!post);
    assert_eq!(v["status"], "downloading");

    let pp = r#"postprocess:PROGRESS_JSON:{"status":"postprocessing"}"#;
    let (post, _) = ytdlp::parse_progress(pp).unwrap();
    assert!(post);

    assert!(ytdlp::parse_progress("[download] Destination: x.mp4").is_none());
    assert!(ytdlp::parse_progress("download:PROGRESS_JSON:not-json").is_none());
}

#[test]
fn apply_progress_maps_bytes_or_percent() {
    let jc = opdm_core::job::JobCore::new("https://youtu.be/jNQXAC9IVRw".into(), None, None, std::env::temp_dir(), "t.mp4".to_string());
    let v = json!({"percent":"50.0%","speed":"1.50MiB/s","eta":"00:10","downloaded":"12.00MiB","total":"24.00MiB"});
    let (done, total, speed) = ytdlp::apply_progress(&jc, false, &v);
    assert_eq!(done, 12 * 1024 * 1024);
    assert_eq!(total, 24 * 1024 * 1024);
    assert_eq!(speed as u64, 1_572_864); // 1.50 MiB/s

    // percent-only (no byte fields) → percent mode over a virtual 100000
    let v = json!({"percent":"33%","speed":"","eta":"","downloaded":"","total":""});
    let (done, total, _) = ytdlp::apply_progress(&jc, false, &v);
    assert_eq!(done, 33_000);
    assert_eq!(total, 100_000);
    *jc.stage.lock().unwrap() = "downloading".into();

    // postprocess → merging stage, keeps counters
    let (_, v) = ytdlp::parse_progress(r#"postprocess:PROGRESS_JSON:{"status":"postprocessing"}"#).unwrap();
    let (d2, t2, sp) = ytdlp::apply_progress(&jc, true, &v);
    assert_eq!(*jc.stage.lock().unwrap(), "merging");
    assert_eq!((d2, t2), (done, total));
    assert_eq!(sp, 0.0);
}

/* ---------------- size parsing ---------------- */

#[test]
fn fmt_size_parses_ytdlp_human_units() {
    assert_eq!(ytdlp::fmt_size("1.00KiB"), 1024);
    assert_eq!(ytdlp::fmt_size("2.50MiB"), 2_621_440);
    assert_eq!(ytdlp::fmt_size("2.00GiB"), 2_147_483_648);
    assert_eq!(ytdlp::fmt_size("1.50GB"), 1_500_000_000);
    assert_eq!(ytdlp::fmt_size("512.00B"), 512);
    // garbage → 0 (yt-dlp prints "~" and "N/A" when unknown)
    assert_eq!(ytdlp::fmt_size("~50"), 0);
    assert_eq!(ytdlp::fmt_size("N/A"), 0);
}

/* ---------------- reduce_info: -J payload → dialog rows ---------------- */

#[test]
fn reduce_info_builds_rows_best_first() {
    let info = json!({
        "id": "jNQXAC9IVRw",
        "title": "Me at the zoo",
        "duration": 19.0,
        "uploader": "@jawed",
        "thumbnail": "https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg",
        "webpage_url": "https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLX",
        "formats": [
            {"format_id":"140","vcodec":"none","acodec":"mp4a.40.2","abr":130},
            {"format_id":"251","vcodec":"none","acodec":"opus","abr":160},
            {"format_id":"137","vcodec":"avc1","acodec":"none","height":1080,"fps":30,"ext":"mp4"},
            {"format_id":"248","vcodec":"vp9","acodec":"none","height":1080,"fps":30,"ext":"webm"},
            {"format_id":"136","vcodec":"avc1","acodec":"none","height":720,"fps":30,"ext":"mp4"},
            {"format_id":"22","vcodec":"avc1","acodec":"mp4a.40.2","height":720,"fps":30,"ext":"mp4"},
            {"format_id":"18","vcodec":"avc1","acodec":"mp4a.40.2","height":360,"fps":25,"ext":"mp4"},
            {"format_id":"sb2","vcodec":"none","acodec":"none","format_note":"storyboard"}
        ]
    });
    let r = ytdlp::reduce_info(&info);
    assert_eq!(r.title, "Me at the zoo");
    assert_eq!(r.id, "jNQXAC9IVRw");
    assert_eq!(r.duration_secs, 19);
    assert_eq!(r.url, "https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLX");
    assert!(r.thumbnail.contains("maxresdefault"));

    // row 0 is always "Best"
    assert_eq!(r.rows[0].note, "best");
    // muxed rows high→low then video-only high→low then audio
    let notes: Vec<(String, String)> = r.rows.iter().map(|x| (x.note.clone(), x.label.clone())).collect();
    let muxed_h: Vec<u32> = r.rows.iter().filter(|x| x.note == "muxed").map(|x| x.height).collect();
    assert_eq!(muxed_h, vec![720, 360]);
    // 1080p muxed absent; 1080p video-only rows exist with best fps only (30fps single row)
    assert_eq!(r.rows.iter().filter(|x| x.note == "video").count(), 1);
    let a = r.rows.iter().find(|x| x.note == "audio").unwrap();
    assert_eq!(a.a.as_deref(), Some("251")); // opus 160 beat m4a 130
    // storyboard excluded
    assert!(r.rows.iter().all(|x| x.v.as_deref() != Some("sb2")));
    // order: best, muxed(720, 360), video(1080), audio
    assert_eq!(
        notes.iter().map(|x| x.0.clone()).collect::<Vec<String>>(),
        vec!["best", "muxed", "muxed", "video", "audio"]
    );
}

/* ---------------- tool urls (per-channel) ---------------- */

#[test]
fn ytdlp_url_follows_channel_setting() {
    // default (uninitialized cfg) = stable channel; asset is platform-specific
    let asset = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp_linux" };
    assert!(ytdlp::ytdlp_url().contains("github.com/yt-dlp/yt-dlp/releases/latest/download/"), "{}", ytdlp::ytdlp_url());
    assert!(ytdlp::ytdlp_url().ends_with(asset), "{}", ytdlp::ytdlp_url());
    // deno + the two ffmpeg-static binaries have fixed per-platform URLs
    assert_eq!(
        ytdlp::deno_url(),
        if cfg!(windows) {
            "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip".to_string()
        } else {
            "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip".to_string()
        }
    );
    let urls = ytdlp::ffmpeg_urls();
    assert!(urls.iter().all(|(_, u)| u.contains("eugeneware/ffmpeg-static/releases/latest/download/")));
    assert_eq!(urls.len(), 2);
}
