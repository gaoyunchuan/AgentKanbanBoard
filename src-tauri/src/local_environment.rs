//! Local executable discovery and paths. Never copy, read or log auth tokens.
//! The Codex process inherits HOME / CODEX_HOME and uses its own credential store.
use std::path::{Component, Path, PathBuf};

pub fn absolute_path(value: &str) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    expand_path(value, home.as_deref())
}
fn expand_path(value: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err("请先选择有效的本地项目目录".into());
    }
    let path = if value == "~" || value.starts_with("~/") {
        let home = home.ok_or("无法确定用户主目录，请选择完整的项目目录")?;
        if value == "~" {
            home.to_path_buf()
        } else {
            home.join(&value[2..])
        }
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() {
        return Err("项目工作目录不是绝对路径，请在项目设置中重新选择目录".into());
    }
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(part.as_os_str()),
        }
    }
    // Existing aliases use the same identity. Nonexistent exclusion paths are
    // still accepted so a temporarily unmounted parent can remain excluded.
    Ok(normalized.canonicalize().unwrap_or(normalized))
}
pub fn workspace_directory(value: &str) -> Result<PathBuf, String> {
    let path = absolute_path(value)?;
    if !path.is_dir() {
        return Err(format!(
            "项目目录不存在或不可访问：{}。请重新选择目录。",
            path.display()
        ));
    }
    Ok(path)
}
pub fn is_excluded(path: &Path, exclusions: &[String]) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    exclusions
        .iter()
        .filter_map(|p| absolute_path(p).ok())
        .any(|root| path.starts_with(root))
}
fn executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}
fn candidates(home: Option<&Path>, path: Option<&std::ffi::OsStr>, apps: &Path) -> Vec<PathBuf> {
    let mut values = vec![apps.join("Codex.app/Contents/Resources/codex")];
    if let Some(home) = home {
        values.push(home.join("Applications/Codex.app/Contents/Resources/codex"));
    }
    if let Some(path) = path {
        values.extend(
            std::env::split_paths(path)
                .filter(|p| p.is_absolute())
                .map(|p| p.join("codex")),
        );
    }
    values.extend(
        [
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "/usr/bin/codex",
        ]
        .into_iter()
        .map(PathBuf::from),
    );
    if let Some(home) = home {
        values.extend(
            [
                ".local/bin/codex",
                ".npm-global/bin/codex",
                ".volta/bin/codex",
            ]
            .into_iter()
            .map(|p| home.join(p)),
        );
    }
    values
}
/// Explicit overrides are respected (and never silently replaced). The ordinary
/// blank / legacy "codex" setting discovers Desktop first, then installed CLI.
pub fn resolve_codex(configured: &str) -> Result<PathBuf, String> {
    let env = std::env::var("CODEX_APP_SERVER_PATH").ok();
    let requested = if configured.trim().is_empty() || configured.trim() == "codex" {
        env.as_deref()
            .filter(|x| !x.trim().is_empty())
            .unwrap_or("codex")
    } else {
        configured.trim()
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let search_path = std::env::var_os("PATH");
    if requested != "codex" && !requested.is_empty() {
        if Path::new(requested).components().count() == 1 && !requested.contains('~') {
            if let Some(path) = &search_path {
                if let Some(found) = std::env::split_paths(path)
                    .filter(|p| p.is_absolute())
                    .map(|p| p.join(requested))
                    .find(|p| executable(p))
                {
                    return Ok(found);
                }
            }
        } else {
            let path = absolute_path(requested)?;
            if executable(&path) {
                return Ok(path);
            }
        }
        return Err(format!(
            "指定的 Codex 程序不可用：{requested}。可以在高级设置清除覆盖，恢复自动检测。"
        ));
    }
    for path in candidates(
        home.as_deref(),
        search_path.as_deref(),
        Path::new("/Applications"),
    ) {
        if executable(&path) {
            return Ok(path);
        }
    }
    Err("未找到可执行的 Codex。请确认 Codex Desktop 已安装；非常规安装位置可在高级设置中指定。无需重复安装 CLI 或复制登录凭证。".into())
}
/// GUI launch environments often have a smaller PATH than a Terminal shell.
/// Add known tool locations without sourcing arbitrary login shell scripts.
pub fn child_path(codex: &Path) -> Option<std::ffi::OsString> {
    let mut paths = Vec::<PathBuf>::new();
    if let Some(parent) = codex.parent().filter(|p| p.is_absolute()) {
        paths.push(parent.into());
    }
    paths.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .into_iter()
        .map(PathBuf::from),
    );
    if let Some(value) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&value).filter(|p| p.is_absolute()));
    }
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    std::env::join_paths(paths).ok()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_expand_home_but_never_guess_relative_workspaces() {
        assert_eq!(
            expand_path("~/work/../project", Some(Path::new("/home/test-user"))).unwrap(),
            PathBuf::from("/home/test-user/project")
        );
        assert!(expand_path("project", None).is_err());
        assert!(expand_path("", None).is_err());
    }
    #[test]
    fn exclusions_use_path_components_not_text_prefixes() {
        let roots = vec!["/home/example/plugins".into()];
        assert!(is_excluded(Path::new("/home/example/plugins/a"), &roots));
        assert!(is_excluded(Path::new("/home/example/plugins"), &roots));
        assert!(!is_excluded(
            Path::new("/home/example/plugins-other/a"),
            &roots
        ));
    }
    #[test]
    fn discovery_prioritizes_desktop_and_supports_user_applications() {
        let c = candidates(
            Some(Path::new("/Users/test")),
            Some(std::ffi::OsStr::new("/opt/bin:/another/bin")),
            Path::new("/Applications"),
        );
        assert_eq!(
            c[0],
            PathBuf::from("/Applications/Codex.app/Contents/Resources/codex")
        );
        assert_eq!(
            c[1],
            PathBuf::from("/Users/test/Applications/Codex.app/Contents/Resources/codex")
        );
        assert_eq!(c[2], PathBuf::from("/opt/bin/codex"));
    }
}
