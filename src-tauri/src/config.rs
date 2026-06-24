use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub foreground_sync_interval_seconds: u64,
    pub background_sync_interval_seconds: u64,
    pub review_pending_settle_seconds: i64,
    pub reviewed_retention_days: i64,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            foreground_sync_interval_seconds: 5,
            background_sync_interval_seconds: 30,
            review_pending_settle_seconds: 120,
            reviewed_retention_days: 7,
        }
    }
}
