//! Classify RPC errors by evidence, not by whichever feature we hoped to use.
use serde_json::Value;

pub fn message(error: &str) -> String {
    error
        .find('{')
        .and_then(|start| serde_json::from_str::<Value>(&error[start..]).ok())
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| error.to_owned())
}
pub fn is_configuration_error(error: &str) -> bool {
    let value = error.to_ascii_lowercase();
    value.contains("failed to load config")
        || value.contains("error loading config")
        || value.contains("invalid configuration")
        || value.contains("failed to read configuration")
        || value.contains("agentroletoml")
        || value.contains("config.toml")
            && ["invalid type", "parse", "unknown field", "expected"]
                .iter()
                .any(|s| value.contains(s))
}
pub fn explain(operation: &str, error: &str) -> String {
    let detail = message(error);
    if is_configuration_error(error) {
        let hint = if error.contains("AgentRoleToml") {
            "[agents] 中至少一个值被解析为角色配置，但其类型不是角色表；可能是字段拼写/所属节错误，或当前 Codex 版本不支持该配置项。不能仅把数字改成字符串。"
        } else {
            "请核对错误所指文件与位置，以及正在使用的 Codex 版本。"
        };
        return format!("{operation}：Codex 配置加载失败。{detail}\n{hint}本产品不会删除、改写或忽略你的配置。可在设置中重新检测兼容程序；若所有程序均失败，需要修正对应字段后重连。本次请求未开始新一轮模型执行。");
    }
    let lower = detail.to_ascii_lowercase();
    if lower.contains("dynamictools")
        && [
            "unknown",
            "unsupported",
            "unrecognized",
            "not supported",
            "experimental",
        ]
        .iter()
        .any(|s| lower.contains(s))
    {
        return format!("{operation}：当前 app-server 明确拒绝 dynamicTools。请更新 Codex 或选择支持该协议的已安装版本。原错误：{detail}");
    }
    format!("{operation}：{detail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn user_configuration_error_is_not_a_dynamic_tools_diagnosis() {
        let raw = r#"Codex app-server 拒绝请求：{"code":-32600,"message":"failed to load configuration: /Users/test/.codex/config.toml:387:1: invalid type: integer `10`, expected struct AgentRoleToml"}"#;
        let result = explain("创建会话失败", raw);
        assert!(result.contains("config.toml:387:1"));
        assert!(result.contains("版本不支持"));
        assert!(!result.contains("dynamicTools"));
    }
    #[test]
    fn unrelated_errors_never_recommend_dynamic_tools() {
        assert!(!explain("创建失败", "authentication failed").contains("dynamicTools"));
        assert!(!explain("创建失败", "network error").contains("配置加载失败"));
        assert!(
            explain("创建失败", "unknown field `dynamicTools`").contains("明确拒绝 dynamicTools")
        );
    }
}
