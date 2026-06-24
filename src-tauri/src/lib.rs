pub mod config;
pub mod deeplink;
pub mod domain;
pub mod repository;

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
    use super::domain::{BoardStatus, CodexThreadUpsert, FilterQuery, ProjectInput, TaskType};
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
    fn board_status_mapper_protects_manual_decisions_and_uses_settle_window() {
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
        let too_early = BoardStatusMapper::map_runtime(StatusInput {
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
        assert_eq!(too_early, BoardStatus::Running);
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
                BoardStatus::Untriaged,
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
    fn repository_combines_filters_and_keeps_reviewed_retention_queryable() {
        let repo = Repository::open_in_memory().unwrap();
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
        assert_eq!(stored[0].board_status, BoardStatus::Untriaged);
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
