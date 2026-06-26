use crate::config::AppConfig;
pub use crate::domain::BoardStatus;

pub struct BoardStatusMapper;

pub struct StatusInput<'a> {
    pub codex_status: &'a str,
    pub previous_status: BoardStatus,
    pub has_running_history: bool,
    pub is_archived: bool,
    pub manual_status_override: bool,
    pub last_seen_completed_at: Option<&'a str>,
    pub now: &'a str,
    pub config: &'a AppConfig,
}

impl BoardStatusMapper {
    pub fn map_runtime(input: StatusInput<'_>) -> BoardStatus {
        if input.is_archived {
            return BoardStatus::Archived;
        }

        if is_running_status(input.codex_status) {
            return BoardStatus::Running;
        }

        if input.manual_status_override {
            if matches!(
                input.previous_status,
                BoardStatus::Reviewed | BoardStatus::Suspended
            ) {
                return input.previous_status;
            }
        }

        BoardStatus::ReviewPending
    }
}

fn is_running_status(value: &str) -> bool {
    matches!(
        value,
        "running" | "active" | "waiting_approval" | "waiting approval" | "typing"
    )
}
