//! 仅用于隔离端到端验收：真实调用产品浏览器管理器，不访问正式数据库。
use codex_kanban::{browser_bridge, domain::ProjectInput, repository::Repository};
use serde_json::{json, Value};
use std::io::{self, BufRead};
use std::path::PathBuf;
struct Cleanup;
impl Drop for Cleanup { fn drop(&mut self) { browser_bridge::shutdown_all(); codex_kanban::browser_mcp::shutdown(); } }
fn main() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let db = PathBuf::from(args.first().ok_or("缺少隔离数据库路径")?);
    if !db.is_absolute() || db == std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".codex-kanban/app.db") { return Err("仅允许显式隔离数据库".into()); }
    std::fs::create_dir_all(db.parent().ok_or("缺少父目录")?).map_err(|e| e.to_string())?;
    let repo = Repository::open_path(&db).map_err(|e| e.to_string())?;
    browser_bridge::configure(repo.browser_state_root()?, PathBuf::from(&args[1]), PathBuf::from(&args[2]))?;
    let _cleanup = Cleanup;
    std::fs::create_dir_all(db.parent().unwrap().join("project")).map_err(|e| e.to_string())?;
    repo.upsert_project(ProjectInput { id:"browser-e2e".into(),name:"浏览器隔离验证".into(),path:db.parent().unwrap().join("project").to_string_lossy().into_owned(),origin_url:None,aliases:vec![],active:true }).map_err(|e| e.to_string())?;
    let mut owners=vec![];
    for title in ["浏览器验收 A","浏览器验收 B"] {
        let task=repo.chat_create_task(&json!({"title":title,"project_id":"browser-e2e"}))?;
        let c=repo.chat_create_conversation(&task,Some("browser-e2e"))?;
        owners.push(json!({"owner":format!("chat:{}",c.id),"conversation_id":c.id,"title":title}));
    }
    println!("{}", json!({"ready":true,"owners":owners}));
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let owner = request["owner"].as_str().ok_or("缺少owner")?;
        let method = request["method"].as_str().ok_or("缺少method")?;
        let result = if method == "mcp_config" { codex_kanban::browser_mcp::server_config(owner) }
            else { browser_bridge::call(owner, method, request.get("params").cloned().unwrap_or_else(|| json!({}))) };
        println!("{}", match result { Ok(result) => json!({"id":request["id"],"result":result}), Err(error) => json!({"id":request["id"],"error":error}) });
    }
    Ok(())
}
