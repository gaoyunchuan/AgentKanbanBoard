use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoardStatus {
    Untriaged,
    Running,
    ReviewPending,
    Reviewed,
    Archived,
}

impl BoardStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Untriaged => "untriaged",
            Self::Running => "running",
            Self::ReviewPending => "review_pending",
            Self::Reviewed => "reviewed",
            Self::Archived => "archived",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "untriaged" => Some(Self::Untriaged),
            "running" => Some(Self::Running),
            "review_pending" => Some(Self::ReviewPending),
            "reviewed" => Some(Self::Reviewed),
            "archived" => Some(Self::Archived),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Feature,
    Bugfix,
    Review,
    Docs,
    Ops,
}

impl TaskType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Feature => "feature",
            Self::Bugfix => "bugfix",
            Self::Review => "review",
            Self::Docs => "docs",
            Self::Ops => "ops",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "" => None,
            "feature" => Some(Self::Feature),
            "bugfix" => Some(Self::Bugfix),
            "review" => Some(Self::Review),
            "docs" => Some(Self::Docs),
            "ops" => Some(Self::Ops),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInput {
    pub id: String,
    pub name: String,
    pub path: String,
    pub origin_url: Option<String>,
    pub aliases: Vec<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub path: String,
    pub origin_url: Option<String>,
    pub aliases: Vec<String>,
    pub active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexThreadUpsert {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub preview: String,
    pub cwd: String,
    pub branch: String,
    pub source_kind: String,
    pub codex_status: String,
    pub codex_sub_status: String,
    pub created_at: String,
    pub updated_at: String,
    pub raw_json: Value,
}

impl CodexThreadUpsert {
    pub fn minimal(id: &str) -> Self {
        Self {
            id: id.to_string(),
            project_id: None,
            title: id.to_string(),
            preview: String::new(),
            cwd: String::new(),
            branch: String::new(),
            source_kind: "codex".to_string(),
            codex_status: "unknown".to_string(),
            codex_sub_status: String::new(),
            created_at: "2026-06-24T00:00:00Z".to_string(),
            updated_at: "2026-06-24T00:00:00Z".to_string(),
            raw_json: serde_json::json!({}),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub preview: String,
    pub cwd: String,
    pub branch: String,
    pub source_kind: String,
    pub codex_status: String,
    pub codex_sub_status: String,
    pub board_status: BoardStatus,
    pub task_type: Option<TaskType>,
    pub module: String,
    pub sprint: String,
    pub notes: String,
    pub first_seen_at: String,
    pub last_seen_running_at: Option<String>,
    pub last_seen_completed_at: Option<String>,
    pub manual_status_override: bool,
    pub manual_status_updated_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FilterQuery {
    pub project_id: Option<String>,
    pub board_status: Option<BoardStatus>,
    pub codex_status: Option<String>,
    pub task_type: Option<TaskType>,
    pub module: Option<String>,
    pub sprint: Option<String>,
    pub include_archived: bool,
    pub updated_from: Option<String>,
    pub updated_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterPreset {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub filters_json: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadEventInput {
    pub thread_id: String,
    pub event_type: String,
    pub from_status: Option<BoardStatus>,
    pub to_status: Option<BoardStatus>,
    pub reason: String,
}
