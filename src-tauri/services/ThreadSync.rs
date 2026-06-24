use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncedThread {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub codex_status: String,
    pub updated_at: String,
}

pub struct ThreadSync;

impl ThreadSync {
    pub fn readonly_methods() -> &'static [&'static str] {
        &["thread/list", "thread/read", "thread/status/changed"]
    }

    pub fn blocked_methods() -> &'static [&'static str] {
        &[
            "thread/start",
            "turn/start",
            "approval/approve",
            "approval/reject",
            "shell/command",
            "thread/delete",
            "thread/archive",
            "thread/unarchive",
            "thread/metadata/update",
        ]
    }
}
