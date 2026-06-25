use codex_kanban::config::AppConfig;
use codex_kanban::domain::{BoardStatus, FilterQuery};
use codex_kanban::project_matcher::ProjectRule;
use codex_kanban::repository::Repository;
use codex_kanban::thread_sync::{CodexAppServerClient, SyncedThread, ThreadSync};

struct MockCodexClient {
    threads: Vec<SyncedThread>,
}

impl CodexAppServerClient for MockCodexClient {
    fn call(&self, method: &str) -> Result<Vec<SyncedThread>, String> {
        assert_eq!(method, "thread/list");
        Ok(self.threads.clone())
    }
}

#[test]
fn sync_worker_persists_mocked_codex_threads() {
    let repository = Repository::open_in_memory().unwrap();
    let sync = ThreadSync::new(Box::new(MockCodexClient {
        threads: vec![SyncedThread {
            id: "thread-1".to_string(),
            title: "Mocked thread".to_string(),
            preview: "preview".to_string(),
            cwd: "/workspace/project".to_string(),
            source_kind: "codex".to_string(),
            codex_status: "running".to_string(),
            raw_status: "running".to_string(),
            branch: "main".to_string(),
            origin_url: None,
            archived: false,
            created_at: "2026-06-24T09:00:00Z".to_string(),
            updated_at: "2026-06-24T09:05:00Z".to_string(),
        }],
    }));
    let projects = [ProjectRule {
        id: "project".to_string(),
        name: "Project".to_string(),
        path: "/workspace/project".to_string(),
        origin_url: None,
        aliases: vec![],
        active: true,
    }];

    let report = sync
        .sync_recent_into(
            &repository,
            &projects,
            &AppConfig::default(),
            "2026-06-24T09:05:00Z",
        )
        .unwrap();
    let threads = repository
        .list_threads(FilterQuery {
            include_archived: true,
            ..FilterQuery::default()
        })
        .unwrap();

    assert_eq!(report.upserted, 1);
    assert_eq!(threads[0].project_id.as_deref(), Some("project"));
    assert_eq!(threads[0].board_status, BoardStatus::Running);
}
