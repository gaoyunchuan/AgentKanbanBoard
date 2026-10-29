//! 完全访问的桌面验收准备；仅接受显式的 /tmp 隔离目录，不触发模型执行。
use codex_kanban::{domain::ProjectInput, repository::Repository, work_service::WorkService};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).expect("需要测试目录"))
        .canonicalize()
        .unwrap();
    assert!(root.starts_with("/private/tmp") || root.starts_with("/tmp"));
    assert!(root.join("codex-wrapper").is_file());
    let db = root.join("app.db");
    let repo = Repository::open_path(&db).unwrap();
    repo.upsert_project(ProjectInput {
        id: "permission-fixture".into(),
        name: "权限验收".into(),
        path: root.to_string_lossy().into_owned(),
        origin_url: None,
        aliases: vec![],
        active: true,
    })
    .unwrap();
    let task = repo
        .chat_create_task(&json!({"title":"E2E-Permissions","project_id":"permission-fixture"}))
        .unwrap();
    let conversation = repo.chat_create_conversation(&task, None).unwrap();
    drop(repo);
    let service = WorkService::spawn_with_path(db, Arc::new(|| {})).unwrap();
    service
        .call(
            "connect",
            json!({"executable":root.join("codex-wrapper").to_string_lossy()}),
        )
        .unwrap();
    service.shutdown();
    println!("{}", json!({"task":task,"conversation":conversation.id}));
}
