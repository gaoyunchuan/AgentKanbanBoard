use crate::browser_state::BrowserStatePaths;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_UPLOAD_BYTES: u64 = 64 * 1024 * 1024;
const COPY_CHUNK_BYTES: usize = 64 * 1024;
const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
const MAX_STAGED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_STAGED_FILES: usize = 128;
const COMPLETED_PREFIX: &str = "kanban-upload-";
static NEXT_UPLOAD: AtomicU64 = AtomicU64::new(0);

const PENDING_PREFIX: &str = ".kanban-upload-";
const PENDING_SUFFIX: &str = ".part";

/// 一次用户拖入或粘贴上传；调用方按 owner 串行操作，并最多持有一个实例。
pub struct PendingUpload {
    file: Option<File>,
    part: PathBuf,
    destination: PathBuf,
    container_path: String,
    declared: u64,
    written: u64,
    completed: bool,
}

impl PendingUpload {
    pub fn begin(paths: &BrowserStatePaths, name: &str, size: u64) -> Result<Self, String> {
        validate_pending_upload(name, size)?;
        let filename = safe_upload_filename(Path::new(name))?;
        let directory = upload_directory(paths)?;
        cleanup_abandoned_parts(&directory)?;
        check_staging_quota(&directory, size)?;
        let (file, part, safe_name) = create_pending_file(&directory, &filename)?;
        // 预留逻辑长度使尚未写入的声明字节也进入后续配额计算，避免交错上传绕过总量限制。
        if let Err(error) = file.set_len(size) {
            let _ = fs::remove_file(&part);
            return Err(format!("预留分块上传容量失败: {error}"));
        }
        Ok(Self {
            file: Some(file),
            part,
            destination: directory.join(&safe_name),
            container_path: format!("/data/downloads/.uploads/{safe_name}"),
            declared: size,
            written: 0,
            completed: false,
        })
    }

    pub fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        let result = self.append_chunk(bytes);
        if result.is_err() {
            self.discard_part();
        }
        result
    }

    pub fn finish(mut self) -> Result<String, String> {
        if self.written != self.declared {
            return Err("上传文件尚未达到声明长度".into());
        }
        self.file
            .as_ref()
            .ok_or("上传已取消或失败")?
            .sync_all()
            .map_err(|error| format!("同步分块上传文件失败: {error}"))?;
        // 同目录硬链接原子创建最终名称，目标已存在（包括符号链接）时拒绝覆盖。
        fs::hard_link(&self.part, &self.destination)
            .map_err(|error| format!("完成分块上传失败: {error}"))?;
        if let Err(error) = fs::remove_file(&self.part) {
            let _ = fs::remove_file(&self.destination);
            return Err(format!("清理分块上传临时文件失败: {error}"));
        }
        self.completed = true;
        Ok(self.container_path.clone())
    }

    fn append_chunk(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.file.is_none() {
            return Err("上传已取消或失败".into());
        }
        if bytes.len() > COPY_CHUNK_BYTES {
            return Err("单次上传数据块不能超过64KiB".into());
        }
        let next = self.written + bytes.len() as u64;
        if next > self.declared || next > MAX_UPLOAD_BYTES {
            return Err("上传累计长度超过声明长度或64MiB限制".into());
        }
        self.file
            .as_mut()
            .ok_or("上传已取消或失败")?
            .write_all(bytes)
            .map_err(|error| format!("写入分块上传失败: {error}"))?;
        self.written = next;
        Ok(())
    }

    fn discard_part(&mut self) {
        // 仅删除本实例创建的 part；保留既有上传、下载与 Chrome profile。
        let _ = fs::remove_file(&self.part);
        self.file.take();
    }
}

impl Drop for PendingUpload {
    fn drop(&mut self) {
        if !self.completed {
            self.discard_part();
        }
    }
}

fn validate_pending_upload(name: &str, size: u64) -> Result<(), String> {
    if size > MAX_UPLOAD_BYTES {
        return Err("上传文件不能超过64MiB".into());
    }
    if name.is_empty()
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err("上传文件名不能包含目录、路径分隔符或控制字符".into());
    }
    Ok(())
}

fn create_pending_file(
    directory: &Path,
    filename: &str,
) -> Result<(File, PathBuf, String), String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效，不能创建分块上传文件".to_string())?
        .as_nanos();
    for _ in 0..8 {
        let sequence = NEXT_UPLOAD.fetch_add(1, Ordering::Relaxed);
        let nonce = format!("{timestamp:x}-{sequence:x}");
        let part = directory.join(format!("{PENDING_PREFIX}{nonce}{PENDING_SUFFIX}"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&part) {
            Ok(file) => {
                if let Err(error) = file.try_lock() {
                    let _ = fs::remove_file(&part);
                    return Err(format!("锁定分块上传临时文件失败: {error}"));
                }
                return Ok((file, part, format!("{COMPLETED_PREFIX}{nonce}-{filename}")));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建分块上传临时文件失败: {error}")),
        }
    }
    Err("不能分配唯一分块上传文件名，请重试".into())
}

fn cleanup_abandoned_parts(directory: &Path) -> Result<(), String> {
    // 浏览器调用方已持 profile 锁；额外 part 文件锁保留本进程仍活动的上传。
    // 只识别本模块保留的 .kanban-upload-<hex>-<hex>.part 名称，不清理其他数据。
    for entry in
        fs::read_dir(directory).map_err(|error| format!("读取分块上传目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取分块上传条目失败: {error}"))?;
        if is_pending_filename(&entry.file_name().to_string_lossy()) {
            remove_unlocked_staging_file(&entry.path())?;
        }
    }
    Ok(())
}

fn is_pending_filename(name: &str) -> bool {
    let Some(nonce) = name
        .strip_prefix(PENDING_PREFIX)
        .and_then(|value| value.strip_suffix(PENDING_SUFFIX))
    else {
        return false;
    };
    let Some((timestamp, sequence)) = nonce.split_once('-') else {
        return false;
    };
    !timestamp.is_empty()
        && !sequence.is_empty()
        && timestamp
            .bytes()
            .all(|character| character.is_ascii_hexdigit())
        && sequence
            .bytes()
            .all(|character| character.is_ascii_hexdigit())
}

/// 仅在所属 Chrome 完全停止后清理传输副本；下载、页面清单和 profile 属于持久用户状态。
pub fn clear_staged_uploads(paths: &BrowserStatePaths) -> Result<(), String> {
    require_real_directory(&paths.downloads)?;
    let directory = paths.downloads.join(".uploads");
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取上传暂存目录失败: {error}")),
        Ok(metadata) if !metadata.is_dir() => return Err("上传暂存目录不能是符号链接或文件".into()),
        Ok(_) => (),
    }
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_pending_filename(&name) || is_completed_filename(&name) {
            remove_unlocked_staging_file(&entry.path())?;
        }
    }
    Ok(())
}

fn is_completed_filename(name: &str) -> bool {
    let Some(value) = name.strip_prefix(COMPLETED_PREFIX) else {
        return false;
    };
    let mut pieces = value.splitn(3, '-');
    let (Some(timestamp), Some(sequence), Some(filename)) =
        (pieces.next(), pieces.next(), pieces.next())
    else {
        return false;
    };
    !timestamp.is_empty()
        && !sequence.is_empty()
        && !filename.is_empty()
        && timestamp
            .bytes()
            .all(|character| character.is_ascii_hexdigit())
        && sequence
            .bytes()
            .all(|character| character.is_ascii_hexdigit())
}

fn remove_unlocked_staging_file(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取上传暂存文件失败: {error}")),
    };
    if !metadata.is_file() {
        return Ok(());
    }
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("打开上传暂存文件失败: {error}")),
    };
    if file.try_lock().is_err() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|error| format!("清理上传暂存副本失败: {error}"))
}

fn check_staging_quota(directory: &Path, declared: u64) -> Result<(), String> {
    let mut count = 0usize;
    let mut total = declared;
    for entry in
        fs::read_dir(directory).map_err(|error| format!("读取上传暂存配额失败: {error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        count += 1;
        // 只需检查前128项即可拒绝超额目录，不能收集全部文件后再计算。
        if count >= MAX_STAGED_FILES {
            return Err("上传暂存副本最多128个，请关闭浏览器后重试".into());
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("上传暂存目录包含非普通文件，拒绝继续上传".into());
        }
        total = total
            .checked_add(metadata.len())
            .ok_or("上传暂存容量溢出")?;
        if total > MAX_STAGED_BYTES {
            return Err("上传暂存总量不能超过256MiB，请关闭浏览器后重试".into());
        }
    }
    if total > MAX_STAGED_BYTES {
        return Err("上传暂存总量不能超过256MiB".into());
    }
    Ok(())
}

/// 仅由用户界面调用原生选择器，模型没有访问宿主任意路径的入口。
pub fn pick_upload(paths: &BrowserStatePaths) -> Result<Option<String>, String> {
    match choose_upload_file()? {
        Some(path) => stage_upload(paths, &path).map(Some),
        None => Ok(None),
    }
}

pub fn stage_upload(paths: &BrowserStatePaths, source: &Path) -> Result<String, String> {
    let mut file = open_upload_source(source)?;
    let filename = safe_upload_filename(source)?;
    let declared = file.metadata().map_err(|error| error.to_string())?.len();
    write_staged_upload(paths, &filename, declared, &mut file)
}

fn open_upload_source(source: &Path) -> Result<File, String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| format!("读取所选上传文件失败: {error}"))?;
    validate_upload_metadata(&metadata)?;
    let file = File::open(source).map_err(|error| format!("打开所选上传文件失败: {error}"))?;
    validate_upload_metadata(&file.metadata().map_err(|error| error.to_string())?)?;
    Ok(file)
}

fn validate_upload_metadata(metadata: &fs::Metadata) -> Result<(), String> {
    if !metadata.is_file() {
        return Err("只能上传本机普通文件，不能上传目录或符号链接".into());
    }
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err("上传文件不能超过64MiB".into());
    }
    Ok(())
}

fn safe_upload_filename(source: &Path) -> Result<String, String> {
    let original = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "上传文件名必须为有效UTF-8文本".to_string())?;
    let mut safe = String::new();
    for character in original.chars() {
        let character = if character.is_control() || matches!(character, '/' | '\\') {
            '_'
        } else {
            character
        };
        if safe.len() + character.len_utf8() > 160 {
            break;
        }
        safe.push(character);
    }
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("上传文件名无效".into());
    }
    Ok(safe)
}

fn upload_directory(paths: &BrowserStatePaths) -> Result<PathBuf, String> {
    // 目的目录完全由会话持久目录派生，不允许选择器或模型提供宿主写入位置。
    require_real_directory(&paths.downloads)?;
    let directory = paths.downloads.join(".uploads");
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            require_real_directory(&directory)?
        }
        Err(error) => return Err(format!("创建上传暂存目录失败: {error}")),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("设置上传暂存目录权限失败: {error}"))?;
    }
    Ok(directory)
}

fn require_real_directory(path: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("读取浏览器下载目录失败: {error}"))?;
    if !metadata.is_dir() {
        return Err("浏览器下载目录不能是符号链接或文件".into());
    }
    Ok(())
}

fn create_upload_file(directory: &Path, filename: &str) -> Result<(File, PathBuf, String), String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效，不能创建上传暂存文件".to_string())?
        .as_nanos();
    for _ in 0..8 {
        let sequence = NEXT_UPLOAD.fetch_add(1, Ordering::Relaxed);
        let safe_name = format!("{COMPLETED_PREFIX}{timestamp:x}-{sequence:x}-{filename}");
        let path = directory.join(&safe_name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => return Ok((file, path, safe_name)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建上传暂存文件失败: {error}")),
        }
    }
    Err("不能分配唯一上传文件名，请重试".into())
}

fn write_staged_upload(
    paths: &BrowserStatePaths,
    filename: &str,
    declared: u64,
    reader: &mut impl Read,
) -> Result<String, String> {
    let directory = upload_directory(paths)?;
    check_staging_quota(&directory, declared)?;
    // create_new 同时拒绝覆盖现有文件和跟随最终路径的符号链接。
    let (mut destination, path, safe_name) = create_upload_file(&directory, filename)?;
    let result = copy_upload_chunks(reader, &mut destination, declared).and_then(|()| {
        destination
            .sync_all()
            .map_err(|error| format!("同步上传暂存文件失败: {error}"))
    });
    if let Err(error) = result {
        drop(destination);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(format!("/data/downloads/.uploads/{safe_name}"))
}

fn copy_upload_chunks(
    reader: &mut impl Read,
    writer: &mut impl Write,
    declared: u64,
) -> Result<(), String> {
    let mut buffer = [0u8; COPY_CHUNK_BYTES];
    let mut total = 0u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取上传文件失败: {error}"))?;
        if count == 0 {
            return Ok(());
        }
        total += count as u64;
        // 文件在选择后可能继续增长，不能只依靠打开前的长度预检。
        if total > MAX_UPLOAD_BYTES || total > declared {
            return Err("上传文件在复制期间超过64MiB或预检长度，请重新选择文件".into());
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|error| format!("写入上传暂存文件失败: {error}"))?;
    }
}

pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err("复制内容不能超过1MiB".into());
    }
    #[cfg(target_os = "macos")]
    {
        copy_with_command("pbcopy", &[], text)
    }
    #[cfg(target_os = "linux")]
    {
        for (program, args) in [
            ("wl-copy", vec![]),
            ("xclip", vec!["-selection", "clipboard"]),
        ] {
            if copy_with_command(program, &args, text).is_ok() {
                return Ok(());
            }
        }
        Err("复制失败，请安装并启用wl-copy或xclip及对应桌面剪贴板服务".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err("当前平台不支持原生剪贴板复制".into())
    }
}

fn copy_with_command(program: &str, args: &[&str], text: &str) -> Result<(), String> {
    // 正文只经有界 stdin 传入，不出现在进程参数、日志或错误信息中。
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "原生剪贴板程序不可用".to_string())?;
    let result = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开剪贴板输入".to_string())
        .and_then(|mut input| {
            input
                .write_all(text.as_bytes())
                .map_err(|_| "写入原生剪贴板失败".to_string())
        });
    if let Err(error) = result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let status = child
        .wait()
        .map_err(|_| "等待原生剪贴板程序失败".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("原生剪贴板程序复制失败".into())
    }
}

pub fn open_downloads(paths: &BrowserStatePaths) -> Result<(), String> {
    require_real_directory(&paths.downloads)?;
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let status = Command::new(program)
            .arg(&paths.downloads)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "系统下载目录打开程序不可用".to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("系统无法打开浏览器下载目录".into())
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err("当前平台不支持打开浏览器下载目录".into())
    }
}

fn choose_upload_file() -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript").args(["-e", "try\nPOSIX path of (choose file with prompt \"选择要上传的文件\")\non error number -128\nreturn \"\"\nend try"])
            .output().map_err(|_| "系统文件选择器不可用".to_string())?;
        if !output.status.success() {
            return Err("系统文件选择器失败".into());
        }
        parse_picker_path(&output.stdout)
    }
    #[cfg(target_os = "linux")]
    {
        for (program, args) in [
            (
                "zenity",
                vec!["--file-selection", "--title=选择要上传的文件"],
            ),
            (
                "kdialog",
                vec!["--getopenfilename", ".", "*", "--title", "选择要上传的文件"],
            ),
        ] {
            match Command::new(program).args(args).output() {
                Ok(output) if output.status.success() => return parse_picker_path(&output.stdout),
                Ok(output) if output.status.code() == Some(1) => return Ok(None),
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("系统文件选择器启动失败".into()),
            }
        }
        Err("系统文件选择器不可用，请安装并启用zenity或kdialog".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err("当前平台不支持原生文件选择".into())
    }
}

fn parse_picker_path(bytes: &[u8]) -> Result<Option<PathBuf>, String> {
    let value =
        std::str::from_utf8(bytes).map_err(|_| "系统文件选择器返回了无效路径编码".to_string())?;
    // 只移除选择器添加的一次行尾，保留用户文件名中的中文与前后空格。
    let value = value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value);
    if value.is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("系统文件选择器未返回绝对文件路径".into());
    }
    Ok(Some(path))
}

#[cfg(test)]
#[path = "browser_files_tests.rs"]
mod tests;
