//! 公司认证由 JoyCode 管理。只向隔离认证存储注入本次应用的回环凭证。
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub(crate) const BRIDGE_URL: &str = "AKB_JOYCODE_BRIDGE_URL";
pub(crate) const BRIDGE_KEY: &str = "AKB_JOYCODE_BRIDGE_KEY";

pub(crate) struct JoyCodeLaunch {
    port: u16,
    key: String,
    catalog: PathBuf,
    default_model: String,
}

impl JoyCodeLaunch {
    pub(crate) fn discover() -> Result<Self, String> {
        let port = std::env::var(BRIDGE_URL)
            .ok()
            .and_then(|url| {
                url.strip_prefix("http://127.0.0.1:")?
                    .strip_suffix("/v1")?
                    .parse::<u16>()
                    .ok()
            })
            .filter(|port| *port > 0)
            .ok_or("当前应用无法启用 JoyCode 桥接")?;
        let key = std::env::var(BRIDGE_KEY)
            .ok()
            .filter(|key| key.len() == 64 && key.bytes().all(|ch| ch.is_ascii_hexdigit()))
            .ok_or("JoyCode 桥接凭证不可用，请重启看板")?;
        Self::probe(port, &key)?;
        let catalog = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("无法确定 JoyCode 模型目录")?
            .join(".joycode/cli-runtime/model-registry/pro-model-catalog.json");
        let default_model = Self::default_model(&catalog)?;
        Ok(Self {
            port,
            key,
            catalog,
            default_model,
        })
    }

    fn probe(port: u16, key: &str) -> Result<(), String> {
        let timeout = Duration::from_secs(10);
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        let mut stream = TcpStream::connect_timeout(&address.into(), timeout)
            .map_err(|_| "JoyCode 桥接不可用，请重启看板")?;
        let failure = "JoyCode 未连接，请打开并登录 JoyCode 桌面版后重试";
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|_| failure)?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|_| failure)?;
        write!(stream, "GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n")
            .map_err(|_| failure)?;
        let mut status = String::new();
        BufReader::new(stream.take(1024))
            .read_line(&mut status)
            .map_err(|_| failure)?;
        if !status.starts_with("HTTP/1.1 204 ") {
            return Err(failure.into());
        }
        Ok(())
    }

    fn default_model(catalog: &Path) -> Result<String, String> {
        let data = read_bounded(catalog, 4 * 1024 * 1024)
            .ok_or("JoyCode 模型目录不可用，请先打开 JoyCode")?;
        let value: Value =
            serde_json::from_slice(&data).map_err(|_| "JoyCode 模型目录格式不兼容")?;
        let models = value["models"].as_array().ok_or("JoyCode 没有可用模型")?;
        // 使用 JoyCode 当前选中的模型；目录刷新后不再可用时再取首个可见模型。
        let configured = catalog
            .ancestors()
            .nth(3)
            .and_then(|root| read_bounded(&root.join("config.toml"), 256 * 1024))
            .and_then(|data| String::from_utf8(data).ok())
            .and_then(|data| data.parse::<toml::Value>().ok())
            .and_then(|data| data.get("model")?.as_str().map(str::to_owned));
        let visible = models
            .iter()
            .filter(|model| model["visibility"] == "list" && model["supported_in_api"] == true)
            .filter_map(|model| model["slug"].as_str());
        visible
            .clone()
            .find(|slug| Some(*slug) == configured.as_deref())
            .or_else(|| visible.into_iter().next())
            .filter(|slug| !slug.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "JoyCode 没有可用模型".into())
    }

    pub(crate) fn configure(&self, command: &mut Command) {
        // 保留 openai 这一持久化身份，只覆盖端点和模型，不改 CODEX_HOME。
        for (name, value) in [
            ("model_provider", json!("openai")),
            (
                "openai_base_url",
                json!(format!("http://127.0.0.1:{}/v1", self.port)),
            ),
            ("model_catalog_json", json!(self.catalog)),
            ("model", json!(self.default_model)),
            ("cli_auth_credentials_store", json!("ephemeral")),
            ("forced_login_method", json!("api")),
        ] {
            command.args(["-c", &format!("{name}={value}")]);
        }
        command
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY");
    }

    pub(crate) fn validate_endpoint(&self, config: &Value) -> Result<(), String> {
        let expected = format!("http://127.0.0.1:{}/v1", self.port);
        if config
            .pointer("/config/openai_base_url")
            .and_then(Value::as_str)
            != Some(&expected)
            || config
                .pointer("/config/model_provider")
                .and_then(Value::as_str)
                != Some("openai")
        {
            return Err("当前 Codex 内核未应用 JoyCode 端点配置".into());
        }
        Ok(())
    }

    pub(crate) fn authorize(&self, server: &crate::app_server::AppServer) -> Result<(), String> {
        let initial = server
            .request_with_timeout(
                "account/read",
                json!({"refreshToken":false}),
                Duration::from_secs(8),
            )
            .map_err(|_| "无法确认 JoyCode 的认证隔离")?;
        if !initial.get("account").is_some_and(Value::is_null) {
            return Err("JoyCode 子进程未使用空白认证，连接已拒绝".into());
        }
        let result = server.request_with_timeout(
            "account/login/start",
            json!({"type":"apiKey","apiKey":self.key}),
            Duration::from_secs(8),
        );
        if !result.is_ok_and(|value| value["type"] == "apiKey") {
            return Err("无法初始化 JoyCode 的隔离认证".into());
        }
        Ok(())
    }
}

fn read_bounded(path: &Path, limit: usize) -> Option<Vec<u8>> {
    let mut data = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take((limit + 1) as u64)
        .read_to_end(&mut data)
        .ok()?;
    (data.len() <= limit).then_some(data)
}
