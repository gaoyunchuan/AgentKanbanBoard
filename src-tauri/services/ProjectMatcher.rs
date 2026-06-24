use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRule {
    pub id: String,
    pub name: String,
    pub path: String,
    pub origin_url: Option<String>,
    pub aliases: Vec<String>,
    pub active: bool,
}

pub struct ProjectMatcher;

impl ProjectMatcher {
    pub fn match_by_longest_path<'a>(
        cwd: &str,
        projects: &'a [ProjectRule],
    ) -> Option<&'a ProjectRule> {
        projects
            .iter()
            .filter(|project| project.active)
            .filter(|project| cwd == project.path || cwd.starts_with(&format!("{}/", project.path)))
            .max_by_key(|project| project.path.len())
    }
}
