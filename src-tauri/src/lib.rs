pub mod config;
pub mod deeplink;
pub mod domain;
pub mod repository;
pub mod time;

#[path = "../services/BoardStatusMapper.rs"]
pub mod board_status_mapper;
#[path = "../services/ProjectMatcher.rs"]
pub mod project_matcher;
#[path = "../services/ThreadSync.rs"]
pub mod thread_sync;

#[cfg(test)]
mod tests {
    use super::board_status_mapper::{BoardStatusMapper, StatusInput};
    use super::config::AppConfig;
    use super::deeplink::{project_deeplink, thread_deeplink};
    use super::domain::{
        BoardStatus, CodexThreadUpsert, FilterQuery, ProjectInput, TaskType, ThreadCommentInput,
    };
    use super::project_matcher::{ProjectMatcher, ProjectRule, ThreadProjectHint};
    use super::repository::Repository;
    use super::thread_sync::{
        refresh_interval_seconds, CodexAppServerClient, ReadOnlyCodexClient, SyncVisibility,
        ThreadSync,
    };

    fn project(id: &str, path: &str) -> ProjectRule {
        ProjectRule {
            id: id.to_string(),
            name: id.to_string(),
            path: path.to_string(),
            origin_url: None,
            aliases: vec![],
            active: true,
        }
    }

    struct StaticThreadClient {
        threads: Vec<super::thread_sync::SyncedThread>,
    }

    impl CodexAppServerClient for StaticThreadClient {
        fn call(&self, method: &str) -> Result<Vec<super::thread_sync::SyncedThread>, String> {
            assert_eq!(method, "thread/list");
            Ok(self.threads.clone())
        }
    }

    fn synced_thread(
        id: &str,
        codex_status: &str,
        updated_at: &str,
    ) -> super::thread_sync::SyncedThread {
        super::thread_sync::SyncedThread {
            id: id.to_string(),
            title: id.to_string(),
            preview: String::new(),
            cwd: "/repo".to_string(),
            source_kind: "codex".to_string(),
            codex_status: codex_status.to_string(),
            raw_status: codex_status.to_string(),
            branch: "main".to_string(),
            origin_url: None,
            archived: codex_status == "archived",
            created_at: "2026-06-24T00:00:00Z".to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    fn fixed_clock(value: &'static str) -> Box<dyn Fn() -> String> {
        Box::new(move || value.to_string())
    }

    #[test]
    fn project_matcher_uses_deepest_path_before_origin_and_alias() {
        let root = project("root", "/repo");
        let child = ProjectRule {
            aliases: vec!["api".to_string()],
            origin_url: Some("git@example.com:team/api.git".to_string()),
            ..project("child", "/repo/services/api")
        };
        let other = ProjectRule {
            aliases: vec!["api".to_string()],
            origin_url: Some("git@example.com:team/api.git".to_string()),
            ..project("other", "/other")
        };

        let candidates = [root, other, child];
        let matched = ProjectMatcher::match_thread(
            &ThreadProjectHint {
                cwd: Some("/repo/services/api/src".to_string()),
                origin_url: Some("git@example.com:team/api.git".to_string()),
            },
            &candidates,
        );

        assert_eq!(matched.map(|project| project.id.as_str()), Some("child"));
    }

    #[test]
    fn project_matcher_falls_back_to_origin_alias_then_unknown() {
        let origin_project = ProjectRule {
            origin_url: Some("git@example.com:team/web.git".to_string()),
            ..project("origin", "/unrelated")
        };
        let alias_project = ProjectRule {
            aliases: vec!["worker".to_string()],
            ..project("alias", "/another")
        };

        let origin_candidates = [origin_project.clone(), alias_project.clone()];
        let origin_match = ProjectMatcher::match_thread(
            &ThreadProjectHint {
                cwd: Some("/tmp/nope".to_string()),
                origin_url: Some("git@example.com:team/web.git".to_string()),
            },
            &origin_candidates,
        );
        let alias_candidates = [origin_project, alias_project];
        let alias_match = ProjectMatcher::match_thread(
            &ThreadProjectHint {
                cwd: Some("/tmp/worker".to_string()),
                origin_url: None,
            },
            &alias_candidates,
        );

        assert_eq!(
            origin_match.map(|project| project.id.as_str()),
            Some("origin")
        );
        assert_eq!(
            alias_match.map(|project| project.id.as_str()),
            Some("alias")
        );
    }

    #[test]
    fn project_matcher_covers_exact_child_inactive_and_unknown_cases() {
        let exact = project("exact", "/repo");
        let child = project("child", "/repo/app");
        let inactive = ProjectRule {
            active: false,
            ..project("inactive", "/repo/app/deeper")
        };
        let candidates = [exact, child, inactive];

        let exact_match = ProjectMatcher::match_thread(
            &ThreadProjectHint {
                cwd: Some("/repo".to_string()),
                origin_url: None,
            },
            &candidates,
        );
        let child_match = ProjectMatcher::match_thread(
            &ThreadProjectHint {
                cwd: Some("/repo/app/src".to_string()),
                origin_url: None,
            },
            &candidates,
        );
        let unknown_match = ProjectMatcher::match_thread(
            &ThreadProjectHint {
                cwd: Some("/elsewhere".to_string()),
                origin_url: None,
            },
            &candidates,
        );

        assert_eq!(
            exact_match.map(|project| project.id.as_str()),
            Some("exact")
        );
        assert_eq!(
            child_match.map(|project| project.id.as_str()),
            Some("child")
        );
        assert!(unknown_match.is_none());
    }

    #[test]
    fn board_status_mapper_protects_manual_decisions_and_maps_finished_threads_to_review_pending() {
        let config = AppConfig::default();
        let now = "2026-06-24T12:05:00Z";

        let active = BoardStatusMapper::map_runtime(StatusInput {
            codex_status: "waiting_approval",
            previous_status: BoardStatus::Reviewed,
            has_running_history: true,
            is_archived: false,
            manual_status_override: true,
            last_seen_completed_at: Some("2026-06-24T12:04:30Z"),
            now,
            config: &config,
        });
        let finished = BoardStatusMapper::map_runtime(StatusInput {
            codex_status: "idle",
            previous_status: BoardStatus::Running,
            has_running_history: true,
            is_archived: false,
            manual_status_override: false,
            last_seen_completed_at: Some("2026-06-24T12:04:00Z"),
            now,
            config: &config,
        });
        let settled = BoardStatusMapper::map_runtime(StatusInput {
            codex_status: "idle",
            previous_status: BoardStatus::Running,
            has_running_history: true,
            is_archived: false,
            manual_status_override: false,
            last_seen_completed_at: Some("2026-06-24T12:02:00Z"),
            now,
            config: &config,
        });

        assert_eq!(active, BoardStatus::Running);
        assert_eq!(finished, BoardStatus::ReviewPending);
        assert_eq!(settled, BoardStatus::ReviewPending);
    }

    #[test]
    fn board_status_mapper_covers_status_engine_matrix() {
        let config = AppConfig::default();
        let now = "2026-06-24T12:05:00Z";
        let cases = [
            (
                "idle",
                BoardStatus::Untriaged,
                false,
                false,
                false,
                None,
                BoardStatus::ReviewPending,
            ),
            (
                "running",
                BoardStatus::Untriaged,
                false,
                false,
                false,
                None,
                BoardStatus::Running,
            ),
            (
                "waiting_approval",
                BoardStatus::Reviewed,
                true,
                false,
                true,
                None,
                BoardStatus::Running,
            ),
            (
                "completed",
                BoardStatus::Running,
                true,
                false,
                false,
                Some("2026-06-24T12:02:00Z"),
                BoardStatus::ReviewPending,
            ),
            (
                "idle",
                BoardStatus::Reviewed,
                true,
                false,
                true,
                Some("2026-06-24T12:02:00Z"),
                BoardStatus::Reviewed,
            ),
            (
                "running",
                BoardStatus::Archived,
                true,
                true,
                true,
                None,
                BoardStatus::Archived,
            ),
        ];

        for (
            codex_status,
            previous_status,
            has_running_history,
            is_archived,
            manual_status_override,
            last_seen_completed_at,
            expected,
        ) in cases
        {
            let actual = BoardStatusMapper::map_runtime(StatusInput {
                codex_status,
                previous_status,
                has_running_history,
                is_archived,
                manual_status_override,
                last_seen_completed_at,
                now,
                config: &config,
            });
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn repository_seeds_presets_and_preserves_user_fields_on_upsert() {
        let repo = Repository::open_in_memory().unwrap();
        repo.seed_builtin_presets().unwrap();
        let presets = repo.list_filter_presets().unwrap();
        assert_eq!(presets.len(), 4);

        repo.upsert_project(ProjectInput {
            id: "p1".to_string(),
            name: "P1".to_string(),
            path: "/repo".to_string(),
            origin_url: None,
            aliases: vec![],
            active: true,
        })
        .unwrap();
        repo.upsert_thread(CodexThreadUpsert {
            id: "t1".to_string(),
            project_id: Some("p1".to_string()),
            title: "Thread".to_string(),
            preview: "Preview".to_string(),
            cwd: "/repo".to_string(),
            branch: "main".to_string(),
            source_kind: "codex".to_string(),
            codex_status: "idle".to_string(),
            codex_sub_status: "".to_string(),
            created_at: "2026-06-24T11:00:00Z".to_string(),
            updated_at: "2026-06-24T11:00:00Z".to_string(),
            raw_json: serde_json::json!({ "id": "t1" }),
        })
        .unwrap();
        repo.update_thread_fields("t1", Some(TaskType::Feature), "Sync", "S26", "note")
            .unwrap();
        repo.upsert_thread(CodexThreadUpsert {
            title: "Thread renamed".to_string(),
            updated_at: "2026-06-24T12:00:00Z".to_string(),
            ..CodexThreadUpsert::minimal("t1")
        })
        .unwrap();

        let stored = repo.list_threads(FilterQuery::default()).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].title, "Thread renamed");
        assert_eq!(stored[0].task_type, Some(TaskType::Feature));
        assert_eq!(stored[0].module, "Sync");
    }

    #[test]
    fn repository_filters_and_archive_actions_hide_archived_by_default() {
        let repo = Repository::open_in_memory().unwrap();
        repo.upsert_thread(CodexThreadUpsert {
            id: "t1".to_string(),
            title: "Needs review".to_string(),
            codex_status: "idle".to_string(),
            ..CodexThreadUpsert::minimal("t1")
        })
        .unwrap();
        repo.mark_reviewed("t1").unwrap();
        repo.archive_thread("t1").unwrap();

        assert!(repo
            .list_threads(FilterQuery::default())
            .unwrap()
            .is_empty());

        let archived = repo
            .list_threads(FilterQuery {
                include_archived: true,
                board_status: Some(BoardStatus::Archived),
                ..FilterQuery::default()
            })
            .unwrap();
        assert_eq!(archived.len(), 1);

        repo.unarchive_thread("t1").unwrap();
        let active = repo.list_threads(FilterQuery::default()).unwrap();
        assert_eq!(active[0].board_status, BoardStatus::ReviewPending);
    }

    #[test]
    fn repository_adds_and_updates_multiple_thread_comments() {
        let repo =
            Repository::open_in_memory_with_clock(fixed_clock("2026-06-26T10:00:00Z")).unwrap();
        repo.upsert_thread(CodexThreadUpsert::minimal("t-comments"))
            .unwrap();

        let first = repo
            .add_thread_comment(ThreadCommentInput {
                thread_id: "t-comments".to_string(),
                author: "我".to_string(),
                body: "先记录同步间隔需要调整。".to_string(),
            })
            .unwrap();
        let second = repo
            .add_thread_comment(ThreadCommentInput {
                thread_id: "t-comments".to_string(),
                author: "我".to_string(),
                body: "补充离线态提示。".to_string(),
            })
            .unwrap();

        let comments = repo.list_thread_comments("t-comments").unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].id, second.id);
        assert_eq!(comments[1].id, first.id);

        let updated = repo
            .update_thread_comment(second.id, "补充离线态提示，避免误触。")
            .unwrap();
        assert_eq!(updated.body, "补充离线态提示，避免误触。");
        assert!(updated.edited_at.is_some());

        let stored = repo.get_thread("t-comments").unwrap().unwrap();
        assert_eq!(stored.comments.len(), 2);
        assert_eq!(stored.comments[0].body, "补充离线态提示，避免误触。");
    }

    #[test]
    fn repository_combines_filters_and_keeps_reviewed_retention_queryable() {
        let repo =
            Repository::open_in_memory_with_clock(fixed_clock("2026-06-24T12:05:00Z")).unwrap();
        repo.upsert_thread(CodexThreadUpsert {
            id: "t1".to_string(),
            project_id: Some("p1".to_string()),
            title: "Feature".to_string(),
            codex_status: "idle".to_string(),
            updated_at: "2026-06-24T12:00:00Z".to_string(),
            ..CodexThreadUpsert::minimal("t1")
        })
        .unwrap();
        repo.update_thread_fields("t1", Some(TaskType::Feature), "Sync", "S26", "")
            .unwrap();
        repo.mark_reviewed("t1").unwrap();

        let matched = repo
            .list_threads(FilterQuery {
                project_id: Some("p1".to_string()),
                board_status: Some(BoardStatus::Reviewed),
                codex_status: Some("idle".to_string()),
                task_type: Some(TaskType::Feature),
                module: Some("Sync".to_string()),
                sprint: Some("S26".to_string()),
                updated_from: Some("2026-06-24T00:00:00Z".to_string()),
                updated_to: Some("2026-06-25T00:00:00Z".to_string()),
                ..FilterQuery::default()
            })
            .unwrap();
        let missed = repo
            .list_threads(FilterQuery {
                project_id: Some("p1".to_string()),
                task_type: Some(TaskType::Bugfix),
                ..FilterQuery::default()
            })
            .unwrap();

        assert_eq!(matched.len(), 1);
        assert!(missed.is_empty());
    }

    #[test]
    fn repository_reclassifies_unarchived_threads_after_project_changes() {
        let repo = Repository::open_in_memory().unwrap();
        repo.upsert_thread(CodexThreadUpsert {
            id: "active".to_string(),
            cwd: "/repo/app".to_string(),
            ..CodexThreadUpsert::minimal("active")
        })
        .unwrap();
        repo.upsert_thread(CodexThreadUpsert {
            id: "archived".to_string(),
            cwd: "/repo/app".to_string(),
            ..CodexThreadUpsert::minimal("archived")
        })
        .unwrap();
        repo.archive_thread("archived").unwrap();

        let changed = repo
            .reclassify_unarchived_threads(&[project("p1", "/repo")])
            .unwrap();
        let active = repo.get_thread("active").unwrap().unwrap();
        let archived = repo.get_thread("archived").unwrap().unwrap();

        assert_eq!(changed, 1);
        assert_eq!(active.project_id.as_deref(), Some("p1"));
        assert_eq!(archived.project_id.as_deref(), Some("unknown"));
    }

    #[test]
    fn repository_migrates_existing_thread_table_for_manual_status_timestamp() {
        let temp_path = std::env::temp_dir().join(format!(
            "codex-kanban-old-schema-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&temp_path);
        let connection = rusqlite::Connection::open(&temp_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE codex_threads (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    preview TEXT NOT NULL DEFAULT '',
                    cwd TEXT NOT NULL DEFAULT '',
                    branch TEXT NOT NULL DEFAULT '',
                    source_kind TEXT NOT NULL DEFAULT 'codex',
                    codex_status TEXT NOT NULL DEFAULT 'unknown',
                    raw_status TEXT NOT NULL DEFAULT 'unknown',
                    codex_sub_status TEXT NOT NULL DEFAULT '',
                    board_status TEXT NOT NULL DEFAULT 'untriaged',
                    task_type TEXT NOT NULL DEFAULT '',
                    module TEXT NOT NULL DEFAULT '',
                    sprint TEXT NOT NULL DEFAULT '',
                    notes TEXT NOT NULL DEFAULT '',
                    first_seen_at TEXT NOT NULL,
                    last_seen_running_at TEXT,
                    last_seen_completed_at TEXT,
                    manual_status_override INTEGER NOT NULL DEFAULT 0,
                    archived_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_synced_at TEXT NOT NULL DEFAULT '',
                    raw_json TEXT NOT NULL DEFAULT '{}'
                )",
            )
            .unwrap();
        drop(connection);

        let repo =
            Repository::open_path_with_clock(&temp_path, fixed_clock("2026-06-24T00:00:00Z"))
                .unwrap();
        repo.upsert_thread(CodexThreadUpsert::minimal("t-old-schema"))
            .unwrap();
        repo.mark_reviewed("t-old-schema").unwrap();
        let stored = repo.get_thread("t-old-schema").unwrap().unwrap();

        assert_eq!(
            stored.manual_status_updated_at.as_deref(),
            Some("2026-06-24T00:00:00Z")
        );
        let _ = std::fs::remove_file(&temp_path);
    }

    #[test]
    fn repository_repairs_legacy_manual_status_timestamp_on_open() {
        let temp_path = std::env::temp_dir().join(format!(
            "codex-kanban-legacy-manual-time-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&temp_path);
        {
            let repo =
                Repository::open_path_with_clock(&temp_path, fixed_clock("2026-06-26T03:00:00Z"))
                    .unwrap();
            repo.upsert_thread(CodexThreadUpsert::minimal("t-legacy-time"))
                .unwrap();
            repo.mark_reviewed("t-legacy-time").unwrap();
        }

        {
            let repo =
                Repository::open_path_with_clock(&temp_path, fixed_clock("2026-06-26T04:00:00Z"))
                    .unwrap();
            let stored = repo.get_thread("t-legacy-time").unwrap().unwrap();
            assert_eq!(
                stored.manual_status_updated_at.as_deref(),
                Some("2026-06-26T03:00:00Z")
            );
        }

        {
            let connection = rusqlite::Connection::open(&temp_path).unwrap();
            connection
                .execute(
                    "UPDATE codex_threads
                     SET manual_status_updated_at = '2026-06-24T00:00:00Z'
                     WHERE id = 't-legacy-time'",
                    [],
                )
                .unwrap();
        }

        let repo =
            Repository::open_path_with_clock(&temp_path, fixed_clock("2026-06-26T05:00:00Z"))
                .unwrap();
        let stored = repo.get_thread("t-legacy-time").unwrap().unwrap();

        assert_eq!(
            stored.manual_status_updated_at.as_deref(),
            Some("2026-06-26T05:00:00Z")
        );
        let _ = std::fs::remove_file(&temp_path);
    }

    #[test]
    fn thread_sync_allows_only_read_methods_and_handles_unavailable_client() {
        let client = ReadOnlyCodexClient::new();
        assert!(client.call("thread/list").is_ok());
        assert!(client.call("turn/start").is_err());

        struct UnavailableClient;

        impl CodexAppServerClient for UnavailableClient {
            fn call(&self, _method: &str) -> Result<Vec<super::thread_sync::SyncedThread>, String> {
                Err("Codex app-server 不可用，保留本地快照".to_string())
            }
        }

        let sync = ThreadSync::new(Box::new(UnavailableClient));
        let result = sync.sync_recent();
        assert!(result.is_err());
    }

    #[test]
    fn readonly_client_reads_threads_from_codex_state_sqlite() {
        let temp_path =
            std::env::temp_dir().join(format!("codex-kanban-state-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&temp_path);
        let connection = rusqlite::Connection::open(&temp_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    model_provider TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    title TEXT NOT NULL,
                    sandbox_policy TEXT NOT NULL,
                    approval_mode TEXT NOT NULL,
                    tokens_used INTEGER NOT NULL DEFAULT 0,
                    has_user_event INTEGER NOT NULL DEFAULT 0,
                    archived INTEGER NOT NULL DEFAULT 0,
                    archived_at INTEGER,
                    git_sha TEXT,
                    git_branch TEXT,
                    git_origin_url TEXT,
                    preview TEXT NOT NULL DEFAULT '',
                    recency_at_ms INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO threads (
                    id, rollout_path, created_at, updated_at, source, model_provider, cwd,
                    title, sandbox_policy, approval_mode, git_branch, git_origin_url, preview,
                    recency_at_ms
                ) VALUES (
                    '019ef927-4206-7823-a752-eb0364a6f11b',
                    '/Users/me/.codex/sessions/thread.jsonl',
                    1782296500,
                    1782296699,
                    'vscode',
                    'openai',
                    '/Users/me/project',
                    '接入真实数据',
                    'workspace-write',
                    'never',
                    'main',
                    'git@example.com:me/project.git',
                    '用户要求接入真实 Codex Desktop 数据',
                    1782296699015
                );",
            )
            .unwrap();
        drop(connection);

        let client = ReadOnlyCodexClient::with_state_db_path(temp_path.clone());
        let threads = client.call("thread/list").unwrap();

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].id, "019ef927-4206-7823-a752-eb0364a6f11b");
        assert_eq!(threads[0].title, "接入真实数据");
        assert_eq!(threads[0].cwd, "/Users/me/project");
        assert_eq!(threads[0].branch, "main");
        assert_eq!(
            threads[0].origin_url.as_deref(),
            Some("git@example.com:me/project.git")
        );

        let _ = std::fs::remove_file(temp_path);
    }

    #[test]
    fn thread_sync_initial_sync_classifies_threads_and_avoids_duplicate_events() {
        struct FakeClient {
            threads: Vec<super::thread_sync::SyncedThread>,
        }

        impl CodexAppServerClient for FakeClient {
            fn call(&self, method: &str) -> Result<Vec<super::thread_sync::SyncedThread>, String> {
                assert_eq!(method, "thread/list");
                Ok(self.threads.clone())
            }
        }

        let repo = Repository::open_in_memory().unwrap();
        let projects = [ProjectRule {
            id: "p1".to_string(),
            name: "P1".to_string(),
            path: "/repo".to_string(),
            origin_url: None,
            aliases: vec![],
            active: true,
        }];
        let sync = ThreadSync::new(Box::new(FakeClient {
            threads: vec![super::thread_sync::SyncedThread {
                id: "t-running".to_string(),
                title: "Running".to_string(),
                preview: "preview".to_string(),
                cwd: "/repo/src".to_string(),
                source_kind: "codex".to_string(),
                codex_status: "running".to_string(),
                raw_status: "running".to_string(),
                branch: "main".to_string(),
                origin_url: None,
                archived: false,
                created_at: "2026-06-24T11:00:00Z".to_string(),
                updated_at: "2026-06-24T11:05:00Z".to_string(),
            }],
        }));

        let first = sync
            .sync_recent_into(
                &repo,
                &projects,
                &AppConfig::default(),
                "2026-06-24T11:05:00Z",
            )
            .unwrap();
        let second = sync
            .sync_recent_into(
                &repo,
                &projects,
                &AppConfig::default(),
                "2026-06-24T11:05:10Z",
            )
            .unwrap();
        let stored = repo
            .list_threads(FilterQuery {
                include_archived: true,
                ..FilterQuery::default()
            })
            .unwrap();

        assert_eq!(first.upserted, 1);
        assert_eq!(second.upserted, 1);
        assert_eq!(stored[0].project_id.as_deref(), Some("p1"));
        assert_eq!(stored[0].board_status, BoardStatus::Running);
        assert_eq!(repo.count_thread_events("t-running").unwrap(), 1);
    }

    #[test]
    fn thread_sync_maps_codex_archived_threads_to_archived_board_status() {
        struct FakeClient {
            threads: Vec<super::thread_sync::SyncedThread>,
        }

        impl CodexAppServerClient for FakeClient {
            fn call(&self, method: &str) -> Result<Vec<super::thread_sync::SyncedThread>, String> {
                assert_eq!(method, "thread/list");
                Ok(self.threads.clone())
            }
        }

        let repo = Repository::open_in_memory().unwrap();
        let sync = ThreadSync::new(Box::new(FakeClient {
            threads: vec![super::thread_sync::SyncedThread {
                id: "t-archived".to_string(),
                title: "Archived".to_string(),
                preview: String::new(),
                cwd: "/repo".to_string(),
                source_kind: "codex".to_string(),
                codex_status: "archived".to_string(),
                raw_status: "archived".to_string(),
                branch: "main".to_string(),
                origin_url: None,
                archived: true,
                created_at: "2026-06-24T11:00:00Z".to_string(),
                updated_at: "2026-06-24T11:05:00Z".to_string(),
            }],
        }));

        let report = sync
            .sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T11:05:00Z")
            .unwrap();
        let visible = repo.list_threads(FilterQuery::default()).unwrap();
        let archived = repo
            .list_threads(FilterQuery {
                include_archived: true,
                board_status: Some(BoardStatus::Archived),
                ..FilterQuery::default()
            })
            .unwrap();

        assert_eq!(report.upserted, 1);
        assert!(visible.is_empty());
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].codex_status, "archived");
        assert_eq!(archived[0].board_status, BoardStatus::Archived);
        assert_eq!(repo.count_thread_events("t-archived").unwrap(), 1);
    }

    #[test]
    fn thread_sync_archives_threads_not_updated_for_thirty_days() {
        struct FakeClient {
            threads: Vec<super::thread_sync::SyncedThread>,
        }

        impl CodexAppServerClient for FakeClient {
            fn call(&self, method: &str) -> Result<Vec<super::thread_sync::SyncedThread>, String> {
                assert_eq!(method, "thread/list");
                Ok(self.threads.clone())
            }
        }

        let repo = Repository::open_in_memory().unwrap();
        let sync = ThreadSync::new(Box::new(FakeClient {
            threads: vec![super::thread_sync::SyncedThread {
                id: "t-stale".to_string(),
                title: "Stale".to_string(),
                preview: String::new(),
                cwd: "/repo".to_string(),
                source_kind: "codex".to_string(),
                codex_status: "idle".to_string(),
                raw_status: "idle".to_string(),
                branch: "main".to_string(),
                origin_url: None,
                archived: false,
                created_at: "2026-05-01T11:00:00Z".to_string(),
                updated_at: "2026-05-25T11:05:00Z".to_string(),
            }],
        }));

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T11:05:00Z")
            .unwrap();

        let archived = repo
            .list_threads(FilterQuery {
                include_archived: true,
                board_status: Some(BoardStatus::Archived),
                ..FilterQuery::default()
            })
            .unwrap();

        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, "t-stale");
        assert_eq!(repo.count_thread_events("t-stale").unwrap(), 1);
    }

    #[test]
    fn thread_sync_reopens_reviewed_thread_when_codex_updated_after_manual_status() {
        let repo =
            Repository::open_in_memory_with_clock(fixed_clock("2026-06-24T00:00:00Z")).unwrap();
        repo.upsert_thread(CodexThreadUpsert::minimal("t-reviewed"))
            .unwrap();
        repo.mark_reviewed("t-reviewed").unwrap();
        let sync = ThreadSync::new(Box::new(StaticThreadClient {
            threads: vec![synced_thread("t-reviewed", "idle", "2026-06-24T00:00:01Z")],
        }));

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T00:00:01Z")
            .unwrap();
        let stored = repo.get_thread("t-reviewed").unwrap().unwrap();

        assert_eq!(stored.board_status, BoardStatus::ReviewPending);
        assert!(!stored.manual_status_override);
        assert_eq!(stored.manual_status_updated_at, None);
    }

    #[test]
    fn thread_sync_keeps_reviewed_thread_when_manual_review_is_newer_than_codex_update() {
        let repo =
            Repository::open_in_memory_with_clock(fixed_clock("2026-06-26T03:00:00Z")).unwrap();
        repo.upsert_thread(CodexThreadUpsert::minimal(
            "019f01cd-1308-7a00-ad1f-62de1725c9aa",
        ))
        .unwrap();
        repo.mark_reviewed("019f01cd-1308-7a00-ad1f-62de1725c9aa")
            .unwrap();
        let sync = ThreadSync::new(Box::new(StaticThreadClient {
            threads: vec![synced_thread(
                "019f01cd-1308-7a00-ad1f-62de1725c9aa",
                "idle",
                "2026-06-26T02:47:53Z",
            )],
        }));

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-26T03:05:00Z")
            .unwrap();
        let stored = repo
            .get_thread("019f01cd-1308-7a00-ad1f-62de1725c9aa")
            .unwrap()
            .unwrap();

        assert_eq!(stored.board_status, BoardStatus::Reviewed);
        assert!(stored.manual_status_override);
        assert_eq!(
            stored.manual_status_updated_at.as_deref(),
            Some("2026-06-26T03:00:00Z")
        );
    }

    #[test]
    fn repository_events_use_injected_clock_for_manual_review() {
        let temp_path =
            std::env::temp_dir().join(format!("codex-kanban-events-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&temp_path);
        {
            let repo =
                Repository::open_path_with_clock(&temp_path, fixed_clock("2026-06-26T03:00:00Z"))
                    .unwrap();
            repo.upsert_thread(CodexThreadUpsert::minimal("t-event-time"))
                .unwrap();
            repo.mark_reviewed("t-event-time").unwrap();
        }

        let connection = rusqlite::Connection::open(&temp_path).unwrap();
        let created_at: String = connection
            .query_row(
                "SELECT created_at FROM thread_events WHERE thread_id = 't-event-time'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(created_at, "2026-06-26T03:00:00Z");
        let _ = std::fs::remove_file(&temp_path);
    }

    #[test]
    fn thread_sync_reopens_manually_archived_thread_when_codex_updated_after_manual_status() {
        let repo =
            Repository::open_in_memory_with_clock(fixed_clock("2026-06-24T00:00:00Z")).unwrap();
        repo.upsert_thread(CodexThreadUpsert::minimal("t-archived-manual"))
            .unwrap();
        repo.archive_thread("t-archived-manual").unwrap();
        let sync = ThreadSync::new(Box::new(StaticThreadClient {
            threads: vec![synced_thread(
                "t-archived-manual",
                "idle",
                "2026-06-24T00:00:01Z",
            )],
        }));

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T00:00:01Z")
            .unwrap();
        let stored = repo.get_thread("t-archived-manual").unwrap().unwrap();

        assert_eq!(stored.board_status, BoardStatus::ReviewPending);
        assert!(!stored.manual_status_override);
        assert_eq!(stored.archived_at, None);
        assert_eq!(stored.manual_status_updated_at, None);
        assert_eq!(repo.list_threads(FilterQuery::default()).unwrap().len(), 1);
    }

    #[test]
    fn thread_sync_preserves_manual_status_when_codex_update_is_not_newer() {
        let repo =
            Repository::open_in_memory_with_clock(fixed_clock("2026-06-24T00:00:00Z")).unwrap();
        repo.upsert_thread(CodexThreadUpsert::minimal("t-reviewed-old"))
            .unwrap();
        repo.mark_reviewed("t-reviewed-old").unwrap();
        let sync = ThreadSync::new(Box::new(StaticThreadClient {
            threads: vec![synced_thread(
                "t-reviewed-old",
                "idle",
                "2026-06-24T00:00:00Z",
            )],
        }));

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T00:00:01Z")
            .unwrap();
        let stored = repo.get_thread("t-reviewed-old").unwrap().unwrap();

        assert_eq!(stored.board_status, BoardStatus::Reviewed);
        assert!(stored.manual_status_override);
        assert_eq!(
            stored.manual_status_updated_at.as_deref(),
            Some("2026-06-24T00:00:00Z")
        );
    }

    #[test]
    fn thread_sync_running_update_overrides_stale_manual_archive() {
        let repo =
            Repository::open_in_memory_with_clock(fixed_clock("2026-06-24T00:00:00Z")).unwrap();
        repo.upsert_thread(CodexThreadUpsert::minimal("t-running-after-archive"))
            .unwrap();
        repo.archive_thread("t-running-after-archive").unwrap();
        let sync = ThreadSync::new(Box::new(StaticThreadClient {
            threads: vec![synced_thread(
                "t-running-after-archive",
                "running",
                "2026-06-24T00:00:01Z",
            )],
        }));

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T00:00:01Z")
            .unwrap();
        let stored = repo.get_thread("t-running-after-archive").unwrap().unwrap();

        assert_eq!(stored.board_status, BoardStatus::Running);
        assert!(!stored.manual_status_override);
        assert_eq!(stored.archived_at, None);
        assert_eq!(stored.manual_status_updated_at, None);
    }

    #[test]
    fn thread_sync_codex_archive_and_stale_still_archive_after_manual_status() {
        let repo =
            Repository::open_in_memory_with_clock(fixed_clock("2026-06-24T00:00:00Z")).unwrap();
        for id in ["t-codex-archived", "t-stale-after-review"] {
            repo.upsert_thread(CodexThreadUpsert::minimal(id)).unwrap();
            repo.mark_reviewed(id).unwrap();
        }
        let sync = ThreadSync::new(Box::new(StaticThreadClient {
            threads: vec![
                synced_thread("t-codex-archived", "archived", "2026-06-24T00:00:01Z"),
                synced_thread("t-stale-after-review", "idle", "2026-05-01T00:00:01Z"),
            ],
        }));

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T00:00:01Z")
            .unwrap();

        for id in ["t-codex-archived", "t-stale-after-review"] {
            let stored = repo.get_thread(id).unwrap().unwrap();
            assert_eq!(stored.board_status, BoardStatus::Archived);
            assert!(!stored.manual_status_override);
        }
    }

    #[test]
    fn thread_sync_maps_historical_non_archived_statuses_to_review_pending() {
        struct FakeClient {
            threads: Vec<super::thread_sync::SyncedThread>,
        }

        impl CodexAppServerClient for FakeClient {
            fn call(&self, method: &str) -> Result<Vec<super::thread_sync::SyncedThread>, String> {
                assert_eq!(method, "thread/list");
                Ok(self.threads.clone())
            }
        }

        fn thread_with_status(id: &str, status: &str) -> super::thread_sync::SyncedThread {
            super::thread_sync::SyncedThread {
                id: id.to_string(),
                title: id.to_string(),
                preview: String::new(),
                cwd: "/repo".to_string(),
                source_kind: "codex".to_string(),
                codex_status: status.to_string(),
                raw_status: status.to_string(),
                branch: "main".to_string(),
                origin_url: None,
                archived: false,
                created_at: "2026-06-24T11:00:00Z".to_string(),
                updated_at: "2026-06-24T11:05:00Z".to_string(),
            }
        }

        let repo = Repository::open_in_memory().unwrap();
        let sync = ThreadSync::new(Box::new(FakeClient {
            threads: vec![
                thread_with_status("t-idle", "idle"),
                thread_with_status("t-not-loaded", "notLoaded"),
                thread_with_status("t-unknown", "unknown"),
            ],
        }));

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T11:05:00Z")
            .unwrap();

        let stored = repo
            .list_threads(FilterQuery {
                include_archived: true,
                ..FilterQuery::default()
            })
            .unwrap();

        assert_eq!(stored.len(), 3);
        assert!(stored
            .iter()
            .all(|thread| thread.board_status == BoardStatus::ReviewPending));
    }

    #[test]
    fn thread_sync_moves_finished_running_thread_to_review_pending_immediately() {
        use std::cell::RefCell;

        struct FakeClient {
            batches: RefCell<Vec<Vec<super::thread_sync::SyncedThread>>>,
        }

        impl CodexAppServerClient for FakeClient {
            fn call(&self, method: &str) -> Result<Vec<super::thread_sync::SyncedThread>, String> {
                assert_eq!(method, "thread/list");
                Ok(self.batches.borrow_mut().remove(0))
            }
        }

        fn thread_with_status(status: &str) -> super::thread_sync::SyncedThread {
            super::thread_sync::SyncedThread {
                id: "t-finished".to_string(),
                title: "Finished".to_string(),
                preview: String::new(),
                cwd: "/repo".to_string(),
                source_kind: "codex".to_string(),
                codex_status: status.to_string(),
                raw_status: status.to_string(),
                branch: "main".to_string(),
                origin_url: None,
                archived: false,
                created_at: "2026-06-24T11:00:00Z".to_string(),
                updated_at: "2026-06-24T11:01:00Z".to_string(),
            }
        }

        let repo = Repository::open_in_memory().unwrap();
        let sync = ThreadSync::new(Box::new(FakeClient {
            batches: RefCell::new(vec![
                vec![thread_with_status("running")],
                vec![thread_with_status("idle")],
                vec![thread_with_status("idle")],
            ]),
        }));

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T11:00:00Z")
            .unwrap();
        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T11:01:00Z")
            .unwrap();
        let finished = repo.get_thread("t-finished").unwrap().unwrap();
        assert_eq!(finished.board_status, BoardStatus::ReviewPending);
        assert_eq!(
            finished.last_seen_completed_at.as_deref(),
            Some("2026-06-24T11:01:00Z")
        );

        sync.sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T11:04:00Z")
            .unwrap();
        let settled = repo.get_thread("t-finished").unwrap().unwrap();

        assert_eq!(settled.board_status, BoardStatus::ReviewPending);
        assert_eq!(
            settled.last_seen_completed_at.as_deref(),
            Some("2026-06-24T11:01:00Z")
        );
    }

    #[test]
    fn thread_sync_uses_configured_intervals_and_status_event_refresh() {
        struct FakeClient {
            threads: Vec<super::thread_sync::SyncedThread>,
        }

        impl CodexAppServerClient for FakeClient {
            fn call(&self, _method: &str) -> Result<Vec<super::thread_sync::SyncedThread>, String> {
                Ok(self.threads.clone())
            }
        }

        let config = AppConfig::default();
        assert_eq!(
            refresh_interval_seconds(SyncVisibility::Foreground, &config),
            5
        );
        assert_eq!(
            refresh_interval_seconds(SyncVisibility::Background, &config),
            30
        );

        let repo = Repository::open_in_memory().unwrap();
        let sync = ThreadSync::new(Box::new(FakeClient {
            threads: vec![super::thread_sync::SyncedThread {
                id: "t-event".to_string(),
                title: "Event".to_string(),
                preview: String::new(),
                cwd: "/repo".to_string(),
                source_kind: "codex".to_string(),
                codex_status: "running".to_string(),
                raw_status: "running".to_string(),
                branch: "main".to_string(),
                origin_url: None,
                archived: false,
                created_at: "2026-06-24T11:00:00Z".to_string(),
                updated_at: "2026-06-24T11:05:00Z".to_string(),
            }],
        }));
        let report = sync
            .handle_status_changed_into("t-event", &repo, &[], &config, "2026-06-24T11:05:00Z")
            .unwrap();

        assert_eq!(report.upserted, 1);
        assert_eq!(repo.count_thread_events("t-event").unwrap(), 1);
    }

    #[test]
    fn thread_sync_unknown_status_and_unavailable_client_preserve_user_fields() {
        struct FakeClient(Result<Vec<super::thread_sync::SyncedThread>, String>);

        impl CodexAppServerClient for FakeClient {
            fn call(&self, _method: &str) -> Result<Vec<super::thread_sync::SyncedThread>, String> {
                self.0.clone()
            }
        }

        let repo = Repository::open_in_memory().unwrap();
        repo.upsert_thread(CodexThreadUpsert {
            id: "t1".to_string(),
            title: "Thread".to_string(),
            codex_status: "idle".to_string(),
            ..CodexThreadUpsert::minimal("t1")
        })
        .unwrap();
        repo.update_thread_fields("t1", Some(TaskType::Docs), "Docs", "S26", "keep")
            .unwrap();

        let unknown_sync = ThreadSync::new(Box::new(FakeClient(Ok(vec![
            super::thread_sync::SyncedThread {
                id: "t1".to_string(),
                title: "Thread".to_string(),
                preview: String::new(),
                cwd: String::new(),
                source_kind: "codex".to_string(),
                codex_status: "new-runtime-value".to_string(),
                raw_status: "new-runtime-value".to_string(),
                branch: "main".to_string(),
                origin_url: None,
                archived: false,
                created_at: "2026-06-24T11:00:00Z".to_string(),
                updated_at: "2026-06-24T11:10:00Z".to_string(),
            },
        ]))));
        unknown_sync
            .sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T11:10:00Z")
            .unwrap();

        let unavailable_sync = ThreadSync::new(Box::new(FakeClient(Err(
            "Codex app-server 不可用".to_string(),
        ))));
        assert!(unavailable_sync
            .sync_recent_into(&repo, &[], &AppConfig::default(), "2026-06-24T11:11:00Z")
            .is_err());

        let stored = repo
            .list_threads(FilterQuery {
                include_archived: true,
                ..FilterQuery::default()
            })
            .unwrap();
        assert_eq!(stored[0].board_status, BoardStatus::ReviewPending);
        assert_eq!(stored[0].task_type, Some(TaskType::Docs));
        assert_eq!(stored[0].module, "Docs");
        assert_eq!(stored[0].notes, "keep");
    }

    #[test]
    fn deeplink_builders_validate_thread_ids_and_project_paths() {
        assert_eq!(
            thread_deeplink("550e8400-e29b-41d4-a716-446655440000").unwrap(),
            "codex://threads/550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(
            project_deeplink("/Users/me/project", Some("review this")).unwrap(),
            "codex://new?path=%2FUsers%2Fme%2Fproject&prompt=review%20this"
        );

        assert!(thread_deeplink("not a uuid").is_err());
        assert!(project_deeplink("relative/path", None).is_err());
    }
}
