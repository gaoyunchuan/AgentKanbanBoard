//! 真实桌面验收的数据准备；只写显式指定的隔离数据库，不启动执行。
use codex_kanban::{domain::ProjectInput, repository::Repository};
use serde_json::{json, Value};
use std::path::Path;

fn add_task(
    repo: &Repository,
    title: &str,
    project: &str,
    parent: Option<&str>,
    prompt: &str,
) -> String {
    let id = repo
        .chat_create_task(&json!({"title":title,"project_id":project,"parent_id":parent}))
        .unwrap();
    repo.chat_update_task(
        &id,
        &json!({"process_tracking":prompt}),
        &json!({"process_tracking":""}),
    )
    .unwrap();
    id
}

fn main() {
    let root = std::env::args().nth(1).expect("需要隔离测试目录的绝对路径");
    let root = Path::new(&root);
    assert!(root.is_absolute());
    assert_ne!(
        root.join("app.db"),
        std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join(".codex-kanban/app.db")
    );
    let repo = Repository::open_path(&root.join("app.db")).unwrap();
    let index = root.join("fixture-ids.json");
    let mut ids: serde_json::Map<String, Value> = if index.exists() {
        serde_json::from_slice(&std::fs::read(&index).unwrap()).unwrap()
    } else {
        serde_json::Map::new()
    };
    for (key, title, prompt) in [
        ("auto", "02-自动委托交付", "只读取当前项目 server.log 和 client.log，生成 auto-diagnosis.md，中文说明原因、两份日志证据、修复及验证方法。不得操作项目外文件，不联网。通过 task_submit_result 提交实际文件及检查证据。"),
        ("context", "03-上下文隔离", "任务专属标记为 CONTEXT-ALPHA-1028。只讨论当前任务，不读取项目外文件。"),
        ("handoff", "04-必须由人选择", "生成文件前必须通过 task_wait 的 question 提问：仅给建议，还是生成修订文件？等待用户选择，不能自行决定。若选择生成文件，写 choice.md 记录选择；之后提交交付证据。不得联网或操作项目外文件。"),
        ("dependency", "05-依赖与返工", "这是依赖测试根任务，子任务 A 分析，B 根据 A 的有效结果生成验证清单。"),
        ("scheduled", "06-预约自动启动", "只在当前目录生成 scheduled.md，内容为 SCHEDULED-1028，并提交文件路径和实际验证证据。"),
        ("rework", "07-独立任务不受返工影响", "本任务不依赖其他任务，专属标记为 INDEPENDENT-1028。"),
        ("tools", "08-工具与停止恢复", "仅允许操作当前项目中的测试文件；工具联动验收。"),
    ] {
        if let Some(id) = ids.get(key).and_then(Value::as_str) {
            repo.chat_require_task(id).unwrap();
            continue;
        }
        let project = format!("e2e-{key}");
        repo.upsert_project(ProjectInput { id:project.clone(), name:format!("E2E-{key}"), path:root.join(key).to_string_lossy().into_owned(), origin_url:None, aliases:vec![], active:true }).unwrap();
        let id = add_task(&repo, title, &project, None, prompt);
        ids.insert(key.into(), Value::String(id));
    }
    let parent = ids["dependency"].as_str().unwrap().to_string();
    for (key, title, prompt) in [
        ("dependency_a", "05-A-分析故障", "读取当前项目 server.log 和 client.log，生成 upstream.md，结论须引用日志。通过 task_submit_result 提交实际文件与验证证据，不联网。"),
        ("dependency_b", "05-B-使用A的交付", "使用系统提供的前置任务 A 的有效交付，生成 downstream.md，明确记录采用的上游结论、来源及验证清单。通过 task_submit_result 提交实际文件与检查证据，不联网。"),
    ] {
        if ids.contains_key(key) { continue; }
        ids.insert(key.into(), Value::String(add_task(&repo,title,"e2e-dependency",Some(&parent),prompt)));
    }
    for (key, title, prompt) in [
        ("parent", "10-Agent-parent-child", "Create exactly one business child using task_delegate: title 10-generated-child, prompt write child.txt containing CHILD-OK in the inherited workspace and verify it, acceptance verified file content. Then call task_wait with the returned child task ID in blocked_by. Once the child's accepted result is supplied, read child.txt and create parent.txt containing PARENT-OK plus the child evidence. Verify and submit with task_submit_result. Do not create another child, do not enable native Goals, do not access network or other directories."),
        ("repeat-1", "11-repeat-1", "Write check.txt containing CHECK-1 in this workspace only. Read it back and call task_submit_result with the actual file path and verification evidence. No network, no child tasks."),
        ("repeat-2", "11-repeat-2", "Write check.txt containing CHECK-2 in this workspace only. Read it back and call task_submit_result with the actual file path and verification evidence. No network, no child tasks."),
        ("repeat-3", "11-repeat-3", "Write check.txt containing CHECK-3 in this workspace only. Read it back and call task_submit_result with the actual file path and verification evidence. No network, no child tasks."),
    ] {
        if ids.contains_key(key) { continue; }
        let directory = root.join(key);
        std::fs::create_dir_all(&directory).unwrap();
        let project = format!("e2e-{key}");
        repo.upsert_project(ProjectInput { id:project.clone(), name:format!("E2E-{key}"), path:directory.to_string_lossy().into_owned(), origin_url:None, aliases:vec![], active:true }).unwrap();
        ids.insert(key.into(), Value::String(add_task(&repo,title,&project,None,prompt)));
    }
    let output = serde_json::to_string_pretty(&ids).unwrap();
    std::fs::write(index, &output).unwrap();
    println!("{output}");
}
