use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoardStatus {
    Untriaged,
    Running,
    ReviewPending,
    Reviewed,
    Archived,
}

pub struct BoardStatusMapper;

impl BoardStatusMapper {
    pub fn map_runtime(
        codex_status: &str,
        has_running_history: bool,
        is_archived: bool,
    ) -> BoardStatus {
        if is_archived {
            return BoardStatus::Archived;
        }

        if matches!(codex_status, "running" | "active" | "waiting_approval") {
            return BoardStatus::Running;
        }

        if has_running_history {
            return BoardStatus::ReviewPending;
        }

        BoardStatus::Untriaged
    }
}
