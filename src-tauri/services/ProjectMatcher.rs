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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadProjectHint {
    pub cwd: Option<String>,
    pub origin_url: Option<String>,
}

impl ProjectMatcher {
    pub fn match_thread<'a>(
        hint: &ThreadProjectHint,
        projects: &'a [ProjectRule],
    ) -> Option<&'a ProjectRule> {
        if let Some(cwd) = hint.cwd.as_deref() {
            if let Some(project) = Self::match_by_longest_path(cwd, projects) {
                return Some(project);
            }
        }

        if let Some(origin_url) = hint.origin_url.as_deref() {
            if let Some(project) = projects
                .iter()
                .filter(|project| project.active)
                .find(|project| project.origin_url.as_deref() == Some(origin_url))
            {
                return Some(project);
            }
        }

        hint.cwd
            .as_deref()
            .and_then(basename)
            .and_then(|cwd_basename| {
                projects
                    .iter()
                    .filter(|project| project.active)
                    .find(|project| {
                        basename(&project.path) == Some(cwd_basename)
                            || project.aliases.iter().any(|alias| alias == cwd_basename)
                    })
            })
    }

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

fn basename(path: &str) -> Option<&str> {
    path.trim_end_matches('/').rsplit('/').next()
}
