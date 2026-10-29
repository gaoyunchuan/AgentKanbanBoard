use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_OWNER_BYTES: usize = 96;
const MAX_PAGES: usize = 16;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserStatePaths {
    pub root: PathBuf,
    pub profile: PathBuf,
    pub downloads: PathBuf,
    pub manifest: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPage {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageManifest {
    pub version: u32,
    pub pages: Vec<BrowserPage>,
    pub active_index: Option<usize>,
}

impl Default for PageManifest {
    fn default() -> Self {
        Self {
            version: 1,
            pages: vec![],
            active_index: None,
        }
    }
}

/// 状态目录跟随数据库一起迁移；相同父目录中的不同数据库不能共用 Chrome 登录态。
pub fn state_root(database_path: &Path) -> Result<PathBuf, String> {
    if !database_path.is_absolute() {
        return Err("浏览器状态需要已打开数据库的绝对文件路径".into());
    }
    let filename = database_path
        .file_name()
        .filter(|name| !name.is_empty() && *name != ":memory:")
        .ok_or_else(|| "内存或无文件名数据库不支持持久化浏览器状态".to_string())?;
    let parent = database_path
        .parent()
        .ok_or_else(|| "数据库路径没有父目录".to_string())?;
    let container = parent.join("browser-state");
    private_directory(&container)?;
    let root = container.join(filename);
    private_directory(&root)?;
    Ok(root)
}

pub fn for_owner(root: &Path, owner: &str) -> Result<BrowserStatePaths, String> {
    let encoded = encode_owner(owner)?;
    private_directory(root)?;
    let root = root.join(encoded);
    let paths = BrowserStatePaths {
        profile: root.join("profile"),
        downloads: root.join("downloads"),
        manifest: root.join("pages.json"),
        root,
    };
    for directory in [&paths.root, &paths.profile, &paths.downloads] {
        private_directory(directory)?;
    }
    Ok(paths)
}

fn encode_owner(owner: &str) -> Result<String, String> {
    if owner.is_empty()
        || owner.len() > MAX_OWNER_BYTES
        || owner == "."
        || owner == ".."
        || owner
            .chars()
            .any(|character| matches!(character, '/' | '\\' | '\0'))
    {
        return Err("浏览器归属标识必须为不超过96字节的非空标识，不能包含路径分隔符".into());
    }
    // 固定 UTF-8 十六进制编码使升级、容器重建后仍能找到原 profile，不能换成随机种子哈希。
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(owner.len() * 2);
    for byte in owner.bytes() {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 15) as usize] as char);
    }
    Ok(encoded)
}

fn private_directory(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if !fs::symlink_metadata(path)
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                return Err("浏览器状态目录不能是符号链接或普通文件".into());
            }
        }
        Err(error) => return Err(format!("创建浏览器状态目录失败: {error}")),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("设置浏览器状态目录权限失败: {error}"))?;
    }
    Ok(())
}

/// 文件描述符拥有锁的生命周期；进程崩溃也会释放锁，残留锁文件不能阻止恢复。
pub struct ProfileLease {
    paths: BrowserStatePaths,
    _lock: File,
    manifest_write: Mutex<()>,
}

impl ProfileLease {
    pub fn acquire(paths: &BrowserStatePaths) -> Result<Self, String> {
        let lock_path = paths.root.join("profile.lock");
        reject_non_regular_file(&lock_path)?;
        let mut options = private_file_options();
        let lock = options
            .read(true)
            .write(true)
            .create(true)
            .open(&lock_path)
            .map_err(|error| format!("打开浏览器状态锁失败: {error}"))?;
        lock.try_lock()
            .map_err(|error| format!("浏览器状态正在被另一个使用者占用: {error}"))?;
        Ok(Self {
            paths: paths.clone(),
            _lock: lock,
            manifest_write: Mutex::new(()),
        })
    }

    pub fn paths(&self) -> &BrowserStatePaths {
        &self.paths
    }

    pub fn read_manifest(&self) -> Result<Option<PageManifest>, String> {
        reject_non_regular_file(&self.paths.manifest)?;
        let file = match File::open(&self.paths.manifest) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("读取浏览器页面清单失败: {error}")),
        };
        let mut bytes = Vec::new();
        file.take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("读取浏览器页面清单失败: {error}"))?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("浏览器页面清单超过256KiB，保留原文件等待恢复".into());
        }
        let manifest: PageManifest = serde_json::from_slice(&bytes)
            .map_err(|_| "浏览器页面清单损坏，保留原文件等待恢复".to_string())?;
        validate_manifest(&manifest)?;
        Ok(Some(manifest))
    }

    pub fn write_manifest(&self, manifest: &PageManifest) -> Result<(), String> {
        let _write_guard = self
            .manifest_write
            .lock()
            .map_err(|_| "浏览器页面清单写入锁已失效".to_string())?;
        validate_manifest(manifest)?;
        // 未知版本或损坏清单需要显式恢复；正常运行不能用新空白状态抹去恢复线索。
        self.read_manifest()?;
        let bytes = serde_json::to_vec(manifest)
            .map_err(|error| format!("序列化浏览器页面清单失败: {error}"))?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("浏览器页面清单不能超过256KiB".into());
        }
        self.persist_manifest(&bytes)
    }

    fn persist_manifest(&self, bytes: &[u8]) -> Result<(), String> {
        // lease 排除其他进程，写入锁排除同一 lease 的并发；固定暂存名可复用崩溃留下的半份文件。
        let temp_path = self.paths.root.join(".pages.json.tmp");
        reject_non_regular_file(&temp_path)?;
        let mut options = private_file_options();
        let mut file = options
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp_path)
            .map_err(|error| format!("创建浏览器页面临时清单失败: {error}"))?;
        let result = commit_manifest(
            &mut file,
            bytes,
            &temp_path,
            &self.paths.manifest,
            &self.paths.root,
        );
        if result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        result
    }
}

fn private_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn reject_non_regular_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => Err("浏览器状态文件不能是符号链接或目录".into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("读取浏览器状态文件属性失败: {error}")),
    }
}

fn validate_manifest(manifest: &PageManifest) -> Result<(), String> {
    if manifest.version != 1 {
        return Err("浏览器页面清单版本不受支持，保留原文件等待恢复".into());
    }
    if manifest.pages.len() > MAX_PAGES {
        return Err("浏览器页面清单最多保留16页".into());
    }
    match (manifest.pages.is_empty(), manifest.active_index) {
        (true, None) => Ok(()),
        (false, Some(index)) if index < manifest.pages.len() => Ok(()),
        _ => Err("浏览器页面清单的活动页面索引无效".into()),
    }
}

fn commit_manifest(
    file: &mut File,
    bytes: &[u8],
    temporary: &Path,
    destination: &Path,
    root: &Path,
) -> Result<(), String> {
    // 先落盘临时文件再原子替换，避免退出/容器重建留下半份 JSON；Chrome 自己持久化 Cookie。
    file.write_all(bytes)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("持久化浏览器页面临时清单失败: {error}"))?;
    fs::rename(temporary, destination)
        .map_err(|error| format!("替换浏览器页面清单失败: {error}"))?;
    #[cfg(unix)]
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("同步浏览器页面清单目录失败: {error}"))?;
    Ok(())
}

#[cfg(test)]
#[path = "browser_state_tests.rs"]
mod tests;
