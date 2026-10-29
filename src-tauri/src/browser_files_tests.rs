use super::*;
use crate::browser_state::for_owner;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let id = NEXT_TEST.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("kanban-upload-{}-{nanos}-{id}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn paths(&self) -> BrowserStatePaths {
        for_owner(&self.0, "upload-test").unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn staged_file(paths: &BrowserStatePaths, container: &str) -> PathBuf {
    let relative = container.strip_prefix("/data/downloads/.uploads/").unwrap();
    assert_eq!(Path::new(relative).components().count(), 1);
    paths.downloads.join(".uploads").join(relative)
}

#[test]
fn stages_exact_bytes_with_chinese_spaces_and_private_permissions() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let source = scratch.0.join("报告 副本 ' [1].txt");
    let bytes: Vec<u8> = (0..150_123).map(|index| (index % 251) as u8).collect();
    fs::write(&source, &bytes).unwrap();
    let container = stage_upload(&paths, &source).unwrap();
    assert!(container.ends_with("报告 副本 ' [1].txt"));
    let actual = staged_file(&paths, &container);
    assert_eq!(fs::read(&actual).unwrap(), bytes);
    assert_eq!(fs::read(&source).unwrap(), bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&actual).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(actual.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[test]
fn repeated_original_names_never_overwrite_a_previous_upload() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let source = scratch.0.join("same.txt");
    fs::write(&source, "first").unwrap();
    let first = stage_upload(&paths, &source).unwrap();
    fs::write(&source, "second").unwrap();
    let second = stage_upload(&paths, &source).unwrap();
    assert_ne!(first, second);
    assert_eq!(
        fs::read_to_string(staged_file(&paths, &first)).unwrap(),
        "first"
    );
    assert_eq!(
        fs::read_to_string(staged_file(&paths, &second)).unwrap(),
        "second"
    );
}

#[test]
fn rejects_directories_and_oversized_files_without_touching_existing_state() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let existing = paths.downloads.join("existing.txt");
    fs::write(&existing, "keep").unwrap();
    let huge = scratch.0.join("huge.bin");
    fs::File::create(&huge)
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    assert!(stage_upload(&paths, &huge).is_err());
    assert!(stage_upload(&paths, &scratch.0).is_err());
    assert_eq!(fs::read_to_string(existing).unwrap(), "keep");
    assert!(!paths.downloads.join(".uploads").exists());
}

#[cfg(unix)]
#[test]
fn never_follows_an_upload_destination_symlink() {
    use std::os::unix::fs::symlink;
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let outside = scratch.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep.txt"), "keep").unwrap();
    symlink(&outside, paths.downloads.join(".uploads")).unwrap();
    let source = scratch.0.join("source.txt");
    fs::write(&source, "upload").unwrap();
    assert!(stage_upload(&paths, &source).is_err());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(outside.join("keep.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn oversized_clipboard_input_is_rejected_before_launching_native_commands() {
    assert!(copy_to_clipboard(&"字".repeat(350_000)).is_err());
}

#[test]
fn read_failure_removes_only_the_new_partial_upload() {
    struct FailsAfterChunk(bool);
    impl std::io::Read for FailsAfterChunk {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                return Err(std::io::Error::other("injected disk read failure"));
            }
            self.0 = true;
            buffer[..4096].fill(7);
            Ok(4096)
        }
    }
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let directory = paths.downloads.join(".uploads");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("existing.bin"), b"retained").unwrap();
    assert!(
        write_staged_upload(&paths, "read-error.bin", 4096, &mut FailsAfterChunk(false)).is_err()
    );
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    assert_eq!(
        fs::read(directory.join("existing.bin")).unwrap(),
        b"retained"
    );
}

#[test]
fn detects_growth_while_reading_and_cleans_the_partial_upload() {
    use std::io::Read;
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let mut reader = std::io::repeat(7).take(64 * 1024 * 1024 + 1);
    assert!(write_staged_upload(&paths, "growing.bin", 64 * 1024 * 1024, &mut reader).is_err());
    assert_eq!(
        fs::read_dir(paths.downloads.join(".uploads"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn picker_boundary_preserves_spaces_and_chinese_and_rejects_relative_paths() {
    assert_eq!(
        parse_picker_path("/tmp/ 报告 文件 .txt\n".as_bytes()).unwrap(),
        Some(PathBuf::from("/tmp/ 报告 文件 .txt"))
    );
    assert_eq!(parse_picker_path(b"\n").unwrap(), None);
    assert!(parse_picker_path(b"relative.txt\n").is_err());
    assert!(parse_picker_path(&[255]).is_err());
}

#[test]
fn clipboard_command_failure_never_exposes_the_body() {
    let secret = "clipboard-test-content-not-for-errors";
    let error = copy_with_command("/usr/bin/false", &[], secret).unwrap_err();
    assert!(!error.contains(secret));
}

#[test]
fn pending_upload_streams_chunks_and_keeps_completed_bytes_after_drop() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let mut pending = PendingUpload::begin(&paths, "拖入 报告.png", 65_539).unwrap();
    pending.append(&vec![42; 65_536]).unwrap();
    pending.append(&[1, 2, 3]).unwrap();
    let result = pending.finish().unwrap();
    assert!(result.ends_with("拖入 报告.png"));
    let actual = fs::read(staged_file(&paths, &result)).unwrap();
    assert_eq!(actual.len(), 65_539);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(staged_file(&paths, &result))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert!(actual[..65_536].iter().all(|value| *value == 42));
    assert_eq!(&actual[65_536..], &[1, 2, 3]);
    assert_eq!(
        fs::read_dir(paths.downloads.join(".uploads"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn pending_upload_cancel_cleans_only_its_own_partial_file() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let mut first = PendingUpload::begin(&paths, "same.txt", 3).unwrap();
    first.append(b"one").unwrap();
    let retained = first.finish().unwrap();
    let mut cancelled = PendingUpload::begin(&paths, "same.txt", 3).unwrap();
    cancelled.append(b"tw").unwrap();
    drop(cancelled);
    assert_eq!(fs::read(staged_file(&paths, &retained)).unwrap(), b"one");
    assert_eq!(
        fs::read_dir(paths.downloads.join(".uploads"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn pending_upload_rejects_chunk_or_total_overflow_and_incomplete_finish() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let mut large_chunk = PendingUpload::begin(&paths, "large.bin", 65_537).unwrap();
    assert!(large_chunk.append(&vec![0; 65_537]).is_err());
    assert!(large_chunk.append(b"").is_err());
    let mut overflow = PendingUpload::begin(&paths, "overflow.bin", 2).unwrap();
    assert!(overflow.append(b"abc").is_err());
    let mut incomplete = PendingUpload::begin(&paths, "incomplete.bin", 3).unwrap();
    incomplete.append(b"ab").unwrap();
    assert!(incomplete.finish().is_err());
    assert_eq!(
        fs::read_dir(paths.downloads.join(".uploads"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn pending_upload_allows_empty_files_and_rejects_unsafe_names_and_declarations() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    for name in [
        "",
        ".",
        "..",
        "../secret",
        "/tmp/file",
        "a/b",
        "a\\b",
        "nul\0file",
    ] {
        assert!(PendingUpload::begin(&paths, name, 0).is_err(), "{name:?}");
    }
    assert!(PendingUpload::begin(&paths, "huge.bin", 64 * 1024 * 1024 + 1).is_err());
    let result = PendingUpload::begin(&paths, "空文件.txt", 0)
        .unwrap()
        .finish()
        .unwrap();
    assert_eq!(fs::metadata(staged_file(&paths, &result)).unwrap().len(), 0);
}

#[test]
fn pending_upload_restart_cleans_only_abandoned_unlocked_parts() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let active = PendingUpload::begin(&paths, "active.bin", 10).unwrap();
    let directory = paths.downloads.join(".uploads");
    let stale = directory.join(".kanban-upload-abc-012.part");
    fs::write(&stale, b"stale bytes").unwrap();
    let unrelated = directory.join(".kanban-upload-not-owned.part");
    fs::write(&unrelated, b"keep").unwrap();
    let next = PendingUpload::begin(&paths, "next.bin", 0).unwrap();
    assert!(!stale.exists());
    assert!(unrelated.exists());
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 3);
    drop(active);
    let completed = next.finish().unwrap();
    assert!(staged_file(&paths, &completed).exists());
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
}

#[test]
fn pending_upload_publication_never_overwrites_an_existing_destination() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let mut pending = PendingUpload::begin(&paths, "collision.txt", 3).unwrap();
    pending.append(b"new").unwrap();
    let destination = pending.destination.clone();
    fs::write(&destination, b"keep existing").unwrap();
    assert!(pending.finish().is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"keep existing");
    assert_eq!(
        fs::read_dir(paths.downloads.join(".uploads"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn upload_quota_counts_existing_bytes_and_pending_declarations() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let directory = paths.downloads.join(".uploads");
    fs::create_dir(&directory).unwrap();
    let retained = directory.join("kanban-upload-abc-01-retained.bin");
    fs::File::create(&retained)
        .unwrap()
        .set_len(256 * 1024 * 1024 - 2)
        .unwrap();
    assert!(PendingUpload::begin(&paths, "next.bin", 3).is_err());
    let source = scratch.0.join("source.bin");
    fs::write(&source, b"abc").unwrap();
    assert!(stage_upload(&paths, &source).is_err());
    let pending = PendingUpload::begin(&paths, "reserved.bin", 2).unwrap();
    assert!(PendingUpload::begin(&paths, "over-reservation.bin", 1).is_err());
    assert!(stage_upload(&paths, &source).is_err());
    drop(pending);
    assert_eq!(fs::metadata(retained).unwrap().len(), 256 * 1024 * 1024 - 2);
    assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
}

#[test]
fn upload_quota_rejects_more_than_128_staged_entries_without_deleting_them() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let directory = paths.downloads.join(".uploads");
    fs::create_dir(&directory).unwrap();
    for index in 0..128 {
        fs::write(
            directory.join(format!("kanban-upload-abc-{index:x}-retained.bin")),
            b"",
        )
        .unwrap();
    }
    assert!(PendingUpload::begin(&paths, "extra.bin", 0).is_err());
    let source = scratch.0.join("source.bin");
    fs::write(&source, b"x").unwrap();
    assert!(stage_upload(&paths, &source).is_err());
    assert_eq!(fs::read_dir(directory).unwrap().count(), 128);
}

#[test]
fn clearing_staged_uploads_preserves_downloads_profiles_and_unrelated_files() {
    let scratch = Scratch::new();
    let paths = scratch.paths();
    fs::write(paths.profile.join("Cookies"), b"profile").unwrap();
    fs::write(paths.downloads.join("report.pdf"), b"download").unwrap();
    let source = scratch.0.join("selected.bin");
    fs::write(&source, b"upload").unwrap();
    let completed = stage_upload(&paths, &source).unwrap();
    assert!(Path::new(&completed)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("kanban-upload-"));
    let directory = paths.downloads.join(".uploads");
    let stale = directory.join(".kanban-upload-abc-12.part");
    fs::write(&stale, b"stale").unwrap();
    fs::write(directory.join("ordinary.txt"), b"keep").unwrap();
    fs::write(directory.join("kanban-upload-not-our-file.txt"), b"keep").unwrap();
    clear_staged_uploads(&paths).unwrap();
    assert!(!staged_file(&paths, &completed).exists());
    assert!(!stale.exists());
    assert_eq!(fs::read_dir(directory).unwrap().count(), 2);
    assert_eq!(fs::read(paths.profile.join("Cookies")).unwrap(), b"profile");
    assert_eq!(
        fs::read(paths.downloads.join("report.pdf")).unwrap(),
        b"download"
    );
}

#[cfg(unix)]
#[test]
fn clearing_staged_uploads_ignores_symlinks_and_active_parts() {
    use std::os::unix::fs::symlink;
    let scratch = Scratch::new();
    let paths = scratch.paths();
    let active = PendingUpload::begin(&paths, "active.bin", 1).unwrap();
    let outside = scratch.0.join("outside.bin");
    fs::write(&outside, b"outside").unwrap();
    let symlink_path = paths
        .downloads
        .join(".uploads/kanban-upload-abc-12-link.bin");
    symlink(&outside, &symlink_path).unwrap();
    clear_staged_uploads(&paths).unwrap();
    assert!(fs::symlink_metadata(&symlink_path)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    assert_eq!(
        fs::read_dir(paths.downloads.join(".uploads"))
            .unwrap()
            .count(),
        2
    );
    drop(active);
}
