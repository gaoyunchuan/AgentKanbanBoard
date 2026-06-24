fn is_session_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }

    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
            continue;
        }

        if !byte.is_ascii_hexdigit() {
            return false;
        }
    }

    true
}

fn encode_query_value(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

pub fn thread_deeplink(thread_id: &str) -> Result<String, String> {
    if !is_session_uuid(thread_id) {
        return Err("thread id 必须是 Codex session UUID".to_string());
    }

    Ok(format!("codex://threads/{thread_id}"))
}

pub fn project_deeplink(path: &str, prompt: Option<&str>) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err("项目路径必须是本机绝对路径".to_string());
    }

    let mut link = format!("codex://new?path={}", encode_query_value(path));
    if let Some(prompt) = prompt.filter(|value| !value.is_empty()) {
        link.push_str("&prompt=");
        link.push_str(&encode_query_value(prompt));
    }

    Ok(link)
}

pub fn ensure_codex_deeplink(target: &str) -> Result<(), String> {
    if !target.starts_with("codex://") {
        return Err("只允许打开 codex:// deep link".to_string());
    }

    Ok(())
}
