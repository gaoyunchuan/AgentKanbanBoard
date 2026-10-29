use super::*;
use crate::repository::Repository;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kanban-browser-state-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn pages() -> PageManifest {
    PageManifest {
        version: 1,
        pages: vec![BrowserPage {
            url: "https://example.com/持久页面".into(),
            title: "保留页面".into(),
        }],
        active_index: Some(0),
    }
}

#[test]
fn browser_state_follows_actual_open_database_and_survives_reopen_and_move() {
    let scratch = Scratch::new();
    let database = scratch.0.join("overridden.db");
    let expected = scratch.0.join("browser-state/overridden.db");
    let repository = Repository::open_path(&database).unwrap();
    assert_eq!(repository.browser_state_root().unwrap(), expected);
    let paths = for_owner(&expected, "chat:one").unwrap();
    fs::write(
        paths.profile.join("Preferences"),
        "retained chrome settings",
    )
    .unwrap();
    fs::write(paths.downloads.join("report.txt"), "retained download").unwrap();
    let lease = ProfileLease::acquire(&paths).unwrap();
    lease.write_manifest(&pages()).unwrap();
    drop(lease);
    drop(repository);
    let reopened = Repository::open_path(&database).unwrap();
    let paths = for_owner(&reopened.browser_state_root().unwrap(), "chat:one").unwrap();
    assert_eq!(
        fs::read_to_string(paths.profile.join("Preferences")).unwrap(),
        "retained chrome settings"
    );
    assert_eq!(
        fs::read_to_string(paths.downloads.join("report.txt")).unwrap(),
        "retained download"
    );
    assert_eq!(
        ProfileLease::acquire(&paths)
            .unwrap()
            .read_manifest()
            .unwrap(),
        Some(pages())
    );
    drop(reopened);
    let moved = scratch.0.join("moved");
    fs::create_dir(&moved).unwrap();
    fs::rename(&database, moved.join("overridden.db")).unwrap();
    fs::rename(scratch.0.join("browser-state"), moved.join("browser-state")).unwrap();
    let reopened = Repository::open_path(&moved.join("overridden.db")).unwrap();
    let paths = for_owner(&reopened.browser_state_root().unwrap(), "chat:one").unwrap();
    assert_eq!(
        ProfileLease::acquire(&paths)
            .unwrap()
            .read_manifest()
            .unwrap(),
        Some(pages())
    );
}

#[test]
fn databases_and_owners_are_isolated_by_stable_literal_paths() {
    let scratch = Scratch::new();
    let first = state_root(&scratch.0.join("first.db")).unwrap();
    let second = state_root(&scratch.0.join("second.db")).unwrap();
    let one = for_owner(&first, "chat:one").unwrap();
    let two = for_owner(&first, "chat:two").unwrap();
    let other_db = for_owner(&second, "chat:one").unwrap();
    assert_eq!(
        one.root,
        scratch.0.join("browser-state/first.db/636861743a6f6e65")
    );
    assert_ne!(one.root, two.root);
    assert_ne!(one.root, other_db.root);
    assert!(one.profile.is_dir());
    assert!(one.downloads.is_dir());
}

#[test]
fn rejects_memory_database_and_unsafe_or_oversized_owners() {
    assert!(Repository::open_in_memory()
        .unwrap()
        .browser_state_root()
        .is_err());
    assert!(state_root(Path::new(":memory:")).is_err());
    let scratch = Scratch::new();
    for owner in [
        "",
        ".",
        "..",
        "../escape",
        "a/b",
        "a\\b",
        "a\0b",
        &"a".repeat(97),
    ] {
        assert!(for_owner(&scratch.0, owner).is_err(), "owner={owner:?}");
    }
    assert!(for_owner(&scratch.0, &"a".repeat(96)).is_ok());
}

#[cfg(unix)]
#[test]
fn private_directories_do_not_change_database_parent_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new();
    fs::set_permissions(&scratch.0, fs::Permissions::from_mode(0o755)).unwrap();
    let root = state_root(&scratch.0.join("app.db")).unwrap();
    let paths = for_owner(&root, "chat").unwrap();
    for directory in [
        &root,
        root.parent().unwrap(),
        &paths.root,
        &paths.profile,
        &paths.downloads,
    ] {
        assert_eq!(
            fs::metadata(directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert_eq!(
        fs::metadata(&scratch.0).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[test]
fn lease_excludes_second_user_and_releases_without_deleting_state() {
    let scratch = Scratch::new();
    let paths = for_owner(&state_root(&scratch.0.join("app.db")).unwrap(), "chat").unwrap();
    let lease = ProfileLease::acquire(&paths).unwrap();
    fs::write(paths.profile.join("Cookies"), "chrome-owned fixture").unwrap();
    assert!(ProfileLease::acquire(&paths).is_err());
    drop(lease);
    assert!(ProfileLease::acquire(&paths).is_ok());
    assert_eq!(
        fs::read_to_string(paths.profile.join("Cookies")).unwrap(),
        "chrome-owned fixture"
    );
}

#[test]
fn manifest_round_trips_atomically_and_rejects_unbounded_or_invalid_state() {
    let scratch = Scratch::new();
    let paths = for_owner(&scratch.0, "chat").unwrap();
    let lease = ProfileLease::acquire(&paths).unwrap();
    assert_eq!(lease.read_manifest().unwrap(), None);
    lease.write_manifest(&pages()).unwrap();
    assert_eq!(lease.read_manifest().unwrap(), Some(pages()));
    let original = fs::read(&paths.manifest).unwrap();
    let mut invalid = pages();
    invalid.pages.resize(17, invalid.pages[0].clone());
    assert!(lease.write_manifest(&invalid).is_err());
    invalid = pages();
    invalid.active_index = Some(1);
    assert!(lease.write_manifest(&invalid).is_err());
    invalid = pages();
    invalid.version = 2;
    assert!(lease.write_manifest(&invalid).is_err());
    invalid = pages();
    invalid.pages[0].title = "a".repeat(256 * 1024);
    assert!(lease.write_manifest(&invalid).is_err());
    assert_eq!(fs::read(&paths.manifest).unwrap(), original);
    lease.write_manifest(&PageManifest::default()).unwrap();
    assert_eq!(
        lease.read_manifest().unwrap(),
        Some(PageManifest::default())
    );
    assert!(!fs::read_to_string(&paths.manifest)
        .unwrap()
        .contains("cookie"));
    assert!(!fs::read_dir(&paths.root).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
}

#[test]
fn damaged_or_oversized_manifest_remains_available_for_explicit_recovery() {
    let scratch = Scratch::new();
    let paths = for_owner(&scratch.0, "chat").unwrap();
    let lease = ProfileLease::acquire(&paths).unwrap();
    for damaged in [
        b"{damaged".to_vec(),
        vec![b'x'; 256 * 1024 + 1],
        br#"{"version":1,"pages":[],"active_index":null,"cookies":"secret"}"#.to_vec(),
    ] {
        fs::write(&paths.manifest, &damaged).unwrap();
        assert!(lease.read_manifest().is_err());
        assert!(lease.write_manifest(&pages()).is_err());
        assert_eq!(fs::read(&paths.manifest).unwrap(), damaged);
    }
}

#[test]
fn interrupted_temporary_manifest_does_not_block_restart_or_accumulate_files() {
    let scratch = Scratch::new();
    let paths = for_owner(&scratch.0, "chat").unwrap();
    fs::write(
        paths.root.join(".pages.json.tmp"),
        b"{partial previous process",
    )
    .unwrap();
    let lease = ProfileLease::acquire(&paths).unwrap();
    lease.write_manifest(&pages()).unwrap();
    assert_eq!(lease.read_manifest().unwrap(), Some(pages()));
    assert!(!paths.root.join(".pages.json.tmp").exists());
}
