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

        if input.manual_status_override && input.previous_status == BoardStatus::Reviewed {
            return BoardStatus::Reviewed;
        }

        if input.has_running_history
            && input
                .last_seen_completed_at
                .and_then(|completed_at| seconds_between(completed_at, input.now))
                .map(|age| age >= input.config.review_pending_settle_seconds)
                .unwrap_or(false)
        {
            return BoardStatus::ReviewPending;
        }

        input.previous_status
    }
}

fn is_running_status(value: &str) -> bool {
    matches!(
        value,
        "running" | "active" | "waiting_approval" | "waiting approval" | "typing"
    )
}

fn seconds_between(start: &str, end: &str) -> Option<i64> {
    Some(parse_utc_seconds(end)? - parse_utc_seconds(start)?)
}

fn parse_utc_seconds(value: &str) -> Option<i64> {
    let (date, time) = value.trim_end_matches('Z').split_once('T')?;
    let mut date_parts = date.split('-').map(|part| part.parse::<i64>().ok());
    let year = date_parts.next()??;
    let month = date_parts.next()??;
    let day = date_parts.next()??;
    let mut time_parts = time.split(':').map(|part| part.parse::<i64>().ok());
    let hour = time_parts.next()??;
    let minute = time_parts.next()??;
    let second = time_parts.next()??;

    // 状态窗口只需要比较相近时间点，使用单调近似即可覆盖同步决策。
    Some((((year * 12 + month) * 31 + day) * 24 + hour) * 3600 + minute * 60 + second)
}
