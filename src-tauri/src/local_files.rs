//! 用户明确打开的文件由桌面应用读取，独立于 Agent 的工作目录和协议连接。

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

const PREVIEW_BYTES: u64 = 3_000_000;

pub fn is_independent_path(path: &str) -> bool {
    let path = Path::new(path);
    path.is_absolute() || path.starts_with("~")
}

fn local_file_path(workspace: &str, requested: &str) -> Result<PathBuf, String> {
    if requested.is_empty() {
        return Err("文件路径不能为空".into());
    }
    let requested = Path::new(requested);
    let path = if requested.is_absolute() {
        requested.to_path_buf()
    } else if let Ok(relative) = requested.strip_prefix("~") {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .ok_or("无法定位用户主目录")?;
        PathBuf::from(home).join(relative)
    } else {
        Path::new(workspace).join(requested)
    };
    let path = path
        .canonicalize()
        .map_err(|error| format!("无法读取文件路径：{error}"))?;
    if !fs::metadata(&path)
        .map_err(|error| format!("无法读取文件信息：{error}"))?
        .is_file()
    {
        return Err("该路径不是普通文件".into());
    }
    Ok(path)
}

pub fn preview_local_file(workspace: &str, requested: &str) -> Result<Value, String> {
    let path = local_file_path(workspace, requested)?;
    let file = File::open(&path).map_err(|error| format!("无法打开文件：{error}"))?;
    let mut bytes = Vec::new();
    // 即使文件在读取时增长，也最多读取预览上限再多一个字节。
    file.take(PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取文件：{error}"))?;
    if bytes.len() as u64 > PREVIEW_BYTES {
        return Err("文件超过 3 MB，无法在此预览".into());
    }
    Ok(json!({"dataBase64":STANDARD.encode(bytes)}))
}

pub fn open_local_file(workspace: &str, requested: &str) -> Result<Value, String> {
    let path = local_file_path(workspace, requested)?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer.exe"
    } else {
        "xdg-open"
    };
    let status = Command::new(opener)
        .arg(path)
        .status()
        .map_err(|error| format!("无法用系统应用打开文件：{error}"))?;
    if !status.success() && !(cfg!(windows) && status.code() == Some(1)) {
        return Err("系统未能打开文件".into());
    }
    Ok(json!({"opened":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_file_preview_accepts_paths_outside_workspace() {
        let root = std::env::temp_dir().join(format!("akb-local-file-{}", std::process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let outside = root.join("设计 图.txt");
        fs::write(&outside, "原图").unwrap();
        let workspace = project.to_str().unwrap();
        let expected = json!({"dataBase64":STANDARD.encode("原图")});
        assert_eq!(
            preview_local_file(workspace, outside.to_str().unwrap()).unwrap(),
            expected
        );
        assert_eq!(
            preview_local_file(workspace, "../设计 图.txt").unwrap(),
            expected
        );
        assert!(preview_local_file(workspace, ".").is_err());
        File::create(&outside)
            .unwrap()
            .set_len(PREVIEW_BYTES + 1)
            .unwrap();
        assert!(preview_local_file(workspace, outside.to_str().unwrap())
            .unwrap_err()
            .contains("3 MB"));
        fs::remove_dir_all(root).unwrap();
    }
}
