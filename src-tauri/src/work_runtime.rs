//! Task-scoped Codex sessions. Durable task policy belongs to `work_service`.
//!
//! Every callback carries the original task/run binding. Selecting another task in the
//! UI, retrying a run, or receiving a late notification never changes that ownership.

use crate::app_server::{AppServer, ServerMessage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_EARLY_EVENTS: usize = 128;
const MAX_REMEMBERED_BINDINGS: usize = 2048;
const MAX_ATTACHMENTS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskExecutionConfig {
    pub task_id: String,
    pub run_id: String,
    pub thread_id: Option<String>,
    pub workspace: String,
    pub prompt: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub instructions: Option<String>,
    #[serde(default)]
    pub browser_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartedTask {
    pub run_id: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeEvent {
    pub connection_id: String,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub request_id: Option<Value>,
    pub method: String,
    pub params: Value,
}

pub type RuntimeSink = Arc<dyn Fn(RuntimeEvent) + Send + Sync>;

#[derive(Debug, Clone)]
struct Binding {
    task_id: String,
    run_id: String,
    thread_id: String,
    turn_id: Option<String>,
}

#[derive(Clone)]
struct TaskSlot {
    config: TaskExecutionConfig,
    binding: Binding,
    accepting_input: bool,
    completed_turns: HashSet<String>,
}

#[derive(Clone)]
struct PendingRequest {
    binding: Binding,
    method: String,
}

struct DeferredCompletion {
    binding: Binding,
    params: Value,
    pending_children: HashSet<String>,
    pending_goals: HashSet<String>,
}

#[derive(Default)]
struct Registry {
    tasks: HashMap<String, TaskSlot>,
    threads: HashMap<String, String>,
    descendants: HashMap<String, Binding>,
    turns: HashMap<String, Binding>,
    turn_order: VecDeque<String>,
    pending_requests: HashMap<String, PendingRequest>,
    request_bindings: HashMap<String, Binding>,
    request_order: VecDeque<String>,
    early_events: Vec<ServerMessage>,
    starting_thread: bool,
    processes: HashMap<String, Binding>,
    deferred_completions: HashMap<String, DeferredCompletion>,
    goal_pause_pending: HashMap<String, Binding>,
    pending_turn_starts: HashSet<String>,
    cancelled_runs: HashSet<(String, String)>,
    uncertain_runs: HashSet<String>,
}

struct RuntimeShared {
    server: AppServer,
    connection_id: String,
    registry: Mutex<Registry>,
    operations: Mutex<()>,
    sink: RuntimeSink,
    next_process_id: AtomicU64,
    child_stop_timeout_ms: AtomicU64,
}

#[derive(Clone)]
pub struct CodexRuntime {
    shared: Arc<RuntimeShared>,
}

impl CodexRuntime {
    pub fn connect(executable: &Path, sink: RuntimeSink) -> Result<Self, String> {
        let (server, events) = AppServer::spawn(executable)?;
        Self::from_server(server, events, sink)
    }

    fn from_server(
        server: AppServer,
        events: mpsc::Receiver<ServerMessage>,
        sink: RuntimeSink,
    ) -> Result<Self, String> {
        server.initialize()?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let shared = Arc::new(RuntimeShared {
            server,
            connection_id: format!("codex-{}-{stamp}", std::process::id()),
            registry: Mutex::new(Registry::default()),
            operations: Mutex::new(()),
            sink,
            next_process_id: AtomicU64::new(1),
            child_stop_timeout_ms: AtomicU64::new(10_000),
        });
        let weak = Arc::downgrade(&shared);
        thread::Builder::new()
            .name("codex-work-events".into())
            .spawn(move || {
                while let Ok(message) = events.recv() {
                    let Some(shared) = weak.upgrade() else {
                        break;
                    };
                    let disconnected = matches!(&message, ServerMessage::Disconnected { .. });
                    shared.handle_message(message);
                    if disconnected {
                        break;
                    }
                }
            })
            .map_err(|error| format!("无法启动 Codex 事件处理：{error}"))?;
        Ok(Self { shared })
    }

    pub fn connection_id(&self) -> &str {
        &self.shared.connection_id
    }

    pub fn is_alive(&self) -> bool {
        self.shared.server.is_alive()
    }

    pub fn binding_snapshot(&self, task_id: &str, run_id: &str) -> Option<StartedTask> {
        self.shared
            .slot(task_id, run_id)
            .ok()
            .map(|slot| started(&slot.binding))
    }

    /// The scheduler must durably claim `run_id` before calling this method.
    pub fn start_task(&self, mut config: TaskExecutionConfig) -> Result<StartedTask, String> {
        validate_config(&mut config)?;
        if !self.is_alive() {
            return Err("Codex app-server 已断开，请恢复连接后再开始任务".into());
        }
        let _operation = self
            .shared
            .operations
            .lock()
            .map_err(|_| "Codex 执行操作锁已损坏".to_string())?;
        {
            let registry = self.shared.lock_registry()?;
            if registry
                .cancelled_runs
                .contains(&(config.task_id.clone(), config.run_id.clone()))
            {
                return Err("任务已在启动前暂停或取消，不再启动这次执行".into());
            }
            if let Some(slot) = registry.tasks.get(&config.task_id) {
                if slot.binding.run_id == config.run_id {
                    if !slot.accepting_input {
                        return Err("这次任务执行已停止，恢复时需要新的执行标识".into());
                    }
                    return Ok(started(&slot.binding));
                }
                if slot.binding.turn_id.is_some()
                    || registry
                        .deferred_completions
                        .contains_key(&slot.binding.run_id)
                {
                    return Err("上一轮 Codex 仍在执行，请等待停止确认后重试".into());
                }
            }
            if let Some(thread_id) = &config.thread_id {
                if let Some(task_id) = registry.threads.get(thread_id) {
                    if task_id != &config.task_id {
                        return Err("这个 Codex 会话已由另一个任务使用".into());
                    }
                }
            }
        }

        let mut params = thread_params(&config);
        let thread_id = if let Some(thread_id) = config.thread_id.clone() {
            self.shared.register(&config, &thread_id)?;
            self.shared.active_slot(&config.task_id, &config.run_id)?;
            params["threadId"] = json!(thread_id);
            params["excludeTurns"] = json!(true);
            match self.shared.server.request_with_timeout(
                "thread/resume",
                params,
                thread_start_timeout(&config),
            ) {
                Ok(_) => thread_id,
                Err(error) => {
                    // A resumed thread may carry native continuation state. Do not
                    // release its workspace while that state cannot be reconciled.
                    self.shared.server.shutdown();
                    return Err(format!("恢复 Codex 会话失败：{error}"));
                }
            }
        } else {
            {
                let mut registry = self.shared.lock_registry()?;
                if registry
                    .cancelled_runs
                    .contains(&(config.task_id.clone(), config.run_id.clone()))
                {
                    return Err("任务已在启动前暂停或取消，不再创建会话".into());
                }
                registry.starting_thread = true;
            }
            let response = self.shared.server.request_with_timeout(
                "thread/start",
                params,
                thread_start_timeout(&config),
            );
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    self.shared.lock_registry()?.starting_thread = false;
                    self.shared.flush_early_events();
                    return Err(format!(
                        "创建 Codex 会话失败：{error}。自动任务需要支持 dynamicTools 的 app-server 版本。"
                    ));
                }
            };
            let thread_id = match response.pointer("/thread/id").and_then(Value::as_str) {
                Some(id) => id.to_string(),
                None => {
                    self.shared.lock_registry()?.starting_thread = false;
                    self.shared.flush_early_events();
                    self.shared.server.shutdown();
                    return Err("Codex thread/start 没有返回 thread.id".into());
                }
            };
            self.shared.register(&config, &thread_id)?;
            self.shared.lock_registry()?.starting_thread = false;
            self.shared.flush_early_events();
            thread_id
        };

        // This release has exactly one continuation authority: our task scheduler.
        // A previously imported or interrupted session may still contain a native Goal.
        if let Err(error) = self.pause_inherited_goal(&thread_id) {
            self.shared.server.shutdown();
            return Err(error);
        }
        self.shared.emit(
            Some(Binding {
                task_id: config.task_id.clone(),
                run_id: config.run_id.clone(),
                thread_id: thread_id.clone(),
                turn_id: None,
            }),
            "runtime/thread/bound",
            json!({"threadId":thread_id}),
            None,
        );
        let input = vec![text_input(&config.prompt)];
        self.start_turn(&config, &thread_id, input)
    }

    pub fn send_message(
        &self,
        task_id: &str,
        run_id: &str,
        message: &str,
        attachments: Vec<Value>,
    ) -> Result<StartedTask, String> {
        let slot = self.shared.active_slot(task_id, run_id)?;
        let mut input = validate_attachments(attachments)?;
        if !message.trim().is_empty() {
            input.insert(0, text_input(message));
        }
        if input.is_empty() {
            return Err("消息或附件不能为空".into());
        }
        if self
            .shared
            .lock_registry()?
            .pending_requests
            .values()
            .any(|request| request.binding.task_id == task_id && request.binding.run_id == run_id)
        {
            return Err("当前会话正在等待审批或回答，请先处理对应请求".into());
        }
        if let Some(turn_id) = &slot.binding.turn_id {
            self.shared.server.request(
                "turn/steer",
                json!({
                    "threadId": slot.binding.thread_id,
                    "expectedTurnId": turn_id,
                    "input": input
                }),
            )?;
            Ok(started(&slot.binding))
        } else {
            // A WorkRun is one turn. Its terminal event may already be queued at the
            // host even though the UI still says running. Never start a second turn
            // on that old lease; the host claims a fresh run for the saved message.
            Err("本轮执行已结束，请等待任务状态同步后继续；下一轮由任务调度器启动".into())
        }
    }

    pub fn interrupt(&self, task_id: &str, run_id: &str) -> Result<(), String> {
        let bindings = {
            let mut registry = self.shared.lock_registry()?;
            let awaiting_registration = registry.tasks.get(task_id).is_none_or(|slot| {
                slot.binding.run_id != run_id
                    && slot.binding.turn_id.is_none()
                    && !registry.pending_turn_starts.contains(&slot.binding.run_id)
                    && !registry
                        .deferred_completions
                        .contains_key(&slot.binding.run_id)
            });
            if awaiting_registration {
                // Service has already fenced this durable run. A worker may still
                // be waiting behind another task's thread setup. Remember the stop
                // before it obtains the operations lock; do not kill that other task.
                registry
                    .cancelled_runs
                    .insert((task_id.into(), run_id.into()));
                return Ok(());
            }
            let slot = registry.tasks.get_mut(task_id).ok_or("任务没有活动会话")?;
            if slot.binding.run_id != run_id {
                return Err("执行已被更新，不能停止旧的任务执行".into());
            }
            slot.accepting_input = false;
            let mut bindings = vec![slot.binding.clone()];
            let turn_unknown = slot.binding.turn_id.is_none();
            registry
                .cancelled_runs
                .insert((task_id.into(), run_id.into()));
            if turn_unknown && registry.pending_turn_starts.contains(run_id) {
                // turn/start may have executed, but its ID is not known yet. The
                // caller closes this uncertain connection instead of treating this
                // as a confirmed pause and releasing the workspace.
                return Err(
                    "Codex 正在启动这一轮，尚未获得停止所需的 turn.id；需要停止连接核对状态".into(),
                );
            }
            bindings.extend(
                registry
                    .descendants
                    .values()
                    .filter(|b| b.task_id == task_id && b.run_id == run_id)
                    .cloned(),
            );
            bindings
        };
        let mut errors = Vec::new();
        for binding in bindings {
            if let Some(turn_id) = &binding.turn_id {
                if let Err(error) = self.shared.server.request(
                    "turn/interrupt",
                    json!({"threadId":binding.thread_id,"turnId":turn_id}),
                ) {
                    errors.push(error);
                }
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("；"));
        }
        Ok(())
    }

    /// A response can only consume a currently pending request for this exact run.
    pub fn respond_to_request(
        &self,
        task_id: &str,
        run_id: &str,
        request_id: Value,
        result: Value,
    ) -> Result<(), String> {
        let key = request_key(&request_id);
        {
            let mut registry = self.shared.lock_registry()?;
            let pending = registry
                .pending_requests
                .get(&key)
                .ok_or("此请求已失效或已处理，请刷新任务状态")?;
            if pending.binding.task_id != task_id || pending.binding.run_id != run_id {
                return Err("请求不属于当前任务执行，拒绝跨任务回应".into());
            }
            let slot = registry.tasks.get(task_id).ok_or("此任务执行已结束")?;
            if slot.binding.run_id != run_id || !slot.accepting_input {
                return Err("此任务执行已暂停或被替换，请勿批准旧请求".into());
            }
            validate_response(&pending.method, &result)?;
            registry.pending_requests.remove(&key);
        }
        self.shared.server.respond(request_id, result)
    }

    /// Use only after a terminal turn event (or transport loss) has been persisted.
    pub fn forget_task(&self, task_id: &str, run_id: &str) -> Result<(), String> {
        let mut registry = self.shared.lock_registry()?;
        if let Some(slot) = registry.tasks.get(task_id) {
            if slot.binding.run_id != run_id {
                return Ok(());
            }
            let thread_id = slot.binding.thread_id.clone();
            registry.tasks.remove(task_id);
            registry.threads.remove(&thread_id);
            registry
                .descendants
                .retain(|_, binding| binding.task_id != task_id || binding.run_id != run_id);
            registry.pending_requests.retain(|_, request| {
                request.binding.task_id != task_id || request.binding.run_id != run_id
            });
        }
        Ok(())
    }

    pub fn rpc_read(&self, method: &str, params: Value) -> Result<Value, String> {
        if !matches!(
            method,
            "account/read"
                | "account/rateLimits/read"
                | "model/list"
                | "mcpServerStatus/list"
                | "skills/list"
                | "config/read"
                | "thread/read"
                | "thread/items/list"
                | "thread/turns/list"
                | "thread/goal/get"
        ) {
            return Err("不允许通过只读接口调用该 Codex 方法".into());
        }
        self.shared.server.request(method, params)
    }

    pub fn login_start(&self) -> Result<Value, String> {
        self.shared
            .server
            .request("account/login/start", json!({"type":"chatgpt"}))
    }

    pub fn login_cancel(&self, login_id: &str) -> Result<Value, String> {
        self.shared
            .server
            .request("account/login/cancel", json!({"loginId":login_id}))
    }

    pub fn read_file(&self, task_id: &str, run_id: &str, path: &str) -> Result<Value, String> {
        let slot = self.shared.slot(task_id, run_id)?;
        self.read_workspace_file(&slot.config.workspace, path)
    }

    pub fn list_directory(&self, task_id: &str, run_id: &str, path: &str) -> Result<Value, String> {
        let slot = self.shared.slot(task_id, run_id)?;
        self.list_workspace_directory(&slot.config.workspace, path)
    }

    pub fn read_workspace_file(&self, workspace: &str, path: &str) -> Result<Value, String> {
        let path = workspace_path(workspace, path)?;
        self.shared
            .server
            .request("fs/readFile", json!({"path":path}))
    }

    pub fn list_workspace_directory(&self, workspace: &str, path: &str) -> Result<Value, String> {
        let path = workspace_path(workspace, path)?;
        self.shared
            .server
            .request("fs/readDirectory", json!({"path":path}))
    }

    /// Inspecting a finished task does not create a new task run or start a model turn.
    pub fn execute_workspace_command(
        &self,
        task_id: &str,
        workspace: &str,
        sandbox_mode: &str,
        command: Vec<String>,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        if !matches!(
            sandbox_mode,
            "workspace-write" | "read-only" | "danger-full-access"
        ) {
            return Err("不支持的终端沙箱模式".into());
        }
        let workspace = workspace_path(workspace, ".")?;
        let binding = Binding {
            task_id: task_id.to_string(),
            run_id: String::new(),
            thread_id: String::new(),
            turn_id: None,
        };
        self.execute_bound_command(binding, &workspace, sandbox_mode, command, timeout_ms)
    }

    /// Only an explicit terminal action should call this. Agent commands use Codex tools.
    /// Execution remains inside the configured sandbox; it never uses thread/shellCommand.
    pub fn execute_command(
        &self,
        task_id: &str,
        run_id: &str,
        command: Vec<String>,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        let slot = self.shared.slot(task_id, run_id)?;
        self.execute_bound_command(
            slot.binding,
            &slot.config.workspace,
            &slot.config.sandbox_mode,
            command,
            timeout_ms,
        )
    }

    fn execute_bound_command(
        &self,
        binding: Binding,
        workspace: &str,
        sandbox_mode: &str,
        command: Vec<String>,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        if command.is_empty() || command[0].trim().is_empty() {
            return Err("终端命令不能为空".into());
        }
        if timeout_ms == 0 || timeout_ms > 30 * 60 * 1000 {
            return Err("终端超时必须在 1 毫秒至 30 分钟之间".into());
        }
        let process_id = format!(
            "{}-terminal-{}",
            self.connection_id(),
            self.shared.next_process_id.fetch_add(1, Ordering::Relaxed)
        );
        self.shared
            .lock_registry()?
            .processes
            .insert(process_id.clone(), binding.clone());
        self.shared.emit(
            Some(binding.clone()),
            "runtime/command/started",
            json!({"processId":process_id,"command":command,"cwd":workspace}),
            None,
        );
        let result = self.shared.server.request_with_timeout(
            "command/exec",
            json!({
                "command": command,
                "processId": process_id,
                "cwd": workspace,
                "timeoutMs": timeout_ms,
                "streamStdoutStderr": true,
                "sandboxPolicy": sandbox_policy(sandbox_mode, workspace)
            }),
            Duration::from_millis(timeout_ms + 10_000),
        );
        self.shared.emit(
            Some(binding),
            "runtime/command/completed",
            json!({"processId":process_id,"result":result.as_ref().ok(),"error":result.as_ref().err()}),
            None,
        );
        self.shared.lock_registry()?.processes.remove(&process_id);
        result
    }

    pub fn terminate_command(
        &self,
        task_id: &str,
        run_id: &str,
        process_id: &str,
    ) -> Result<(), String> {
        {
            let registry = self.shared.lock_registry()?;
            let binding = registry.processes.get(process_id).ok_or("终端进程已结束")?;
            if binding.task_id != task_id || binding.run_id != run_id {
                return Err("终端进程不属于当前任务执行".into());
            }
        }
        self.shared
            .server
            .request("command/exec/terminate", json!({"processId":process_id}))?;
        Ok(())
    }

    pub fn terminate_workspace_command(
        &self,
        task_id: &str,
        process_id: &str,
    ) -> Result<(), String> {
        {
            let registry = self.shared.lock_registry()?;
            let binding = registry.processes.get(process_id).ok_or("终端进程已结束")?;
            if binding.task_id != task_id {
                return Err("终端进程不属于当前任务".into());
            }
        }
        self.shared
            .server
            .request("command/exec/terminate", json!({"processId":process_id}))?;
        Ok(())
    }

    pub fn shutdown(&self) {
        self.shared.server.shutdown();
    }

    fn start_turn(
        &self,
        config: &TaskExecutionConfig,
        thread_id: &str,
        input: Vec<Value>,
    ) -> Result<StartedTask, String> {
        let mut params = json!({"threadId":thread_id,"input":input});
        if let Some(model) = &config.model {
            params["model"] = json!(model);
        }
        if let Some(effort) = &config.reasoning_effort {
            params["effort"] = json!(effort);
        }
        {
            let mut registry = self.shared.lock_registry()?;
            let active = registry
                .tasks
                .get(&config.task_id)
                .is_some_and(|slot| slot.binding.run_id == config.run_id && slot.accepting_input);
            if !active {
                return Err("任务已在会话启动期间暂停，不再启动新一轮执行".into());
            }
            registry.pending_turn_starts.insert(config.run_id.clone());
        }
        let response = match self.shared.server.request("turn/start", params) {
            Ok(response) => response,
            Err(error) => {
                self.shared
                    .lock_registry()?
                    .pending_turn_starts
                    .remove(&config.run_id);
                // Once turn/start is sent, an error cannot safely prove that no
                // work ran. The caller may release its lease only after fail-close.
                self.shared.server.shutdown();
                return Err(error);
            }
        };
        let turn_id = match response.pointer("/turn/id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                self.shared
                    .lock_registry()?
                    .pending_turn_starts
                    .remove(&config.run_id);
                // A malformed successful response leaves the execution outcome unknown.
                self.shared.server.shutdown();
                return Err("Codex turn/start 没有返回 turn.id，执行状态需要核对".into());
            }
        };
        let binding = Binding {
            task_id: config.task_id.clone(),
            run_id: config.run_id.clone(),
            thread_id: thread_id.to_string(),
            turn_id: Some(turn_id.clone()),
        };
        let mut registry = self.shared.lock_registry()?;
        registry.pending_turn_starts.remove(&config.run_id);
        registry.remember_turn(&binding);
        if let Some(slot) = registry.tasks.get_mut(&config.task_id) {
            // A very short turn can complete before the start RPC response is handled.
            if slot.binding.run_id == config.run_id && !slot.completed_turns.contains(&turn_id) {
                slot.binding.turn_id = Some(turn_id);
            }
        }
        Ok(started(&binding))
    }

    fn pause_inherited_goal(&self, thread_id: &str) -> Result<(), String> {
        match self
            .shared
            .server
            .request("thread/goal/get", json!({"threadId":thread_id}))
        {
            Ok(response)
                if response.pointer("/goal/status").and_then(Value::as_str) == Some("active") =>
            {
                self.shared.server.request(
                    "thread/goal/set",
                    json!({"threadId":thread_id,"status":"paused","origin":"automatic"}),
                )?;
                Ok(())
            }
            Ok(_) => Ok(()),
            // Older app-server versions may provide dynamic tools but no Goal API.
            Err(error) if error.contains("-32601") || error.contains("Unknown method") => Ok(()),
            Err(error) => Err(format!("无法核对会话的自动续跑状态：{error}")),
        }
    }
}

impl RuntimeShared {
    fn lock_registry(&self) -> Result<std::sync::MutexGuard<'_, Registry>, String> {
        self.registry.lock().map_err(|_| {
            self.server.shutdown();
            "Codex 会话状态锁已损坏".into()
        })
    }

    fn register(&self, config: &TaskExecutionConfig, thread_id: &str) -> Result<(), String> {
        let mut registry = self.lock_registry()?;
        if let Some(previous) = registry.tasks.get(&config.task_id) {
            if previous.binding.thread_id != thread_id {
                let previous_thread = previous.binding.thread_id.clone();
                registry.threads.remove(&previous_thread);
                registry
                    .descendants
                    .retain(|_, child| child.task_id != config.task_id);
            }
        }
        registry
            .threads
            .insert(thread_id.into(), config.task_id.clone());
        let accepting_input = !registry
            .cancelled_runs
            .contains(&(config.task_id.clone(), config.run_id.clone()));
        registry.tasks.insert(
            config.task_id.clone(),
            TaskSlot {
                config: config.clone(),
                binding: Binding {
                    task_id: config.task_id.clone(),
                    run_id: config.run_id.clone(),
                    thread_id: thread_id.into(),
                    turn_id: None,
                },
                accepting_input,
                completed_turns: HashSet::new(),
            },
        );
        Ok(())
    }

    fn slot(&self, task_id: &str, run_id: &str) -> Result<TaskSlot, String> {
        self.lock_registry()?
            .tasks
            .get(task_id)
            .filter(|slot| slot.binding.run_id == run_id)
            .cloned()
            .ok_or_else(|| "任务执行已结束或已被新的执行替换".into())
    }

    fn active_slot(&self, task_id: &str, run_id: &str) -> Result<TaskSlot, String> {
        let slot = self.slot(task_id, run_id)?;
        if !slot.accepting_input {
            return Err("此任务执行已暂停或被替换".into());
        }
        Ok(slot)
    }

    fn flush_early_events(self: &Arc<Self>) {
        let events = self
            .lock_registry()
            .map(|mut registry| std::mem::take(&mut registry.early_events))
            .unwrap_or_default();
        for event in events {
            self.handle_message(event);
        }
    }

    fn handle_message(self: &Arc<Self>, message: ServerMessage) {
        match message {
            ServerMessage::Disconnected { reason } => {
                let bindings = self
                    .lock_registry()
                    .map(|mut registry| {
                        registry.pending_requests.clear();
                        registry.deferred_completions.clear();
                        registry.goal_pause_pending.clear();
                        registry.pending_turn_starts.clear();
                        registry
                            .tasks
                            .values_mut()
                            .map(|slot| {
                                slot.accepting_input = false;
                                slot.binding.clone()
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                for binding in bindings {
                    self.emit(
                        Some(binding),
                        "runtime/disconnected",
                        json!({"reason":reason}),
                        None,
                    );
                }
                self.emit(None, "runtime/disconnected", json!({"reason":reason}), None);
            }
            ServerMessage::Event {
                method,
                params,
                request_id,
            } => {
                if method == "runtime/internal/goal-pause-result" {
                    self.goal_pause_result(params);
                    return;
                }
                let thread_id = event_thread_id(&params);
                let turn_id = event_turn_id(&params);
                let mut binding = None;
                let mut stale_request = false;
                let mut interrupt_children = Vec::new();
                let mut defer_parent = false;
                let mut start_watchdog = None;
                let mut released_completions = Vec::new();
                let mut pause_goal = None;
                let mut unexpected_turn = None;
                if let Ok(mut registry) = self.lock_registry() {
                    if method == "thread/started" {
                        if let (Some(child_id), Some(parent_id)) = (
                            thread_id.as_deref(),
                            params
                                .pointer("/thread/parentThreadId")
                                .and_then(Value::as_str),
                        ) {
                            let parent = registry
                                .threads
                                .get(parent_id)
                                .and_then(|task| registry.tasks.get(task))
                                .map(|slot| slot.binding.clone())
                                .or_else(|| registry.descendants.get(parent_id).cloned());
                            if let Some(mut parent) = parent {
                                parent.thread_id = child_id.to_string();
                                parent.turn_id = None;
                                registry.descendants.insert(child_id.to_string(), parent);
                            }
                        }
                    }
                    if let (Some(thread_id), Some(turn_id)) = (&thread_id, &turn_id) {
                        binding = registry.turns.get(&turn_key(thread_id, turn_id)).cloned();
                    }
                    if method == "serverRequest/resolved" {
                        if let Some(id) = params.get("requestId") {
                            let key = request_key(id);
                            binding = registry.request_bindings.get(&key).cloned().or(binding);
                            registry.pending_requests.remove(&key);
                        }
                    }
                    if binding.is_none() {
                        if let Some(thread_id) = &thread_id {
                            binding = registry
                                .threads
                                .get(thread_id)
                                .and_then(|task| registry.tasks.get(task))
                                .map(|slot| slot.binding.clone())
                                .or_else(|| registry.descendants.get(thread_id).cloned());
                        }
                    }
                    if binding.is_none() {
                        if let Some(process_id) = params.get("processId").and_then(Value::as_str) {
                            binding = registry.processes.get(process_id).cloned();
                        }
                    }
                    if binding.is_none() && thread_id.is_some() && registry.starting_thread {
                        if registry.early_events.len() < MAX_EARLY_EVENTS {
                            registry.early_events.push(ServerMessage::Event {
                                method,
                                params,
                                request_id,
                            });
                            return;
                        }
                    }
                    if let Some(current) = binding.as_mut() {
                        if let Some(turn_id) = &turn_id {
                            current.turn_id = Some(turn_id.clone());
                        }
                        if method == "turn/started" {
                            let known = current.turn_id.as_ref().is_some_and(|id| {
                                registry
                                    .turns
                                    .contains_key(&turn_key(&current.thread_id, id))
                            });
                            if !known && registry.descendants.contains_key(&current.thread_id) {
                                let owner = registry.tasks.get(&current.task_id).cloned();
                                let active_owner = owner.as_ref().is_some_and(|slot| {
                                    slot.binding.turn_id.is_some()
                                        || registry
                                            .pending_turn_starts
                                            .contains(&slot.binding.run_id)
                                        || registry
                                            .deferred_completions
                                            .contains_key(&slot.binding.run_id)
                                });
                                if active_owner {
                                    let slot = owner.expect("active owner exists");
                                    // Native resume_agent can reuse a child thread in a
                                    // later business run. Only its new turn changes owner;
                                    // remembered old turn IDs keep their historical run.
                                    current.run_id = slot.binding.run_id;
                                    if let Some(child) =
                                        registry.descendants.get_mut(&current.thread_id)
                                    {
                                        child.run_id = current.run_id.clone();
                                    }
                                    if !slot.accepting_input {
                                        interrupt_children.push(current.clone());
                                    }
                                } else {
                                    registry.uncertain_runs.insert(current.run_id.clone());
                                    unexpected_turn = Some(current.clone());
                                }
                            }
                            let is_main =
                                registry.tasks.get(&current.task_id).is_some_and(|slot| {
                                    slot.binding.run_id == current.run_id
                                        && slot.binding.thread_id == current.thread_id
                                });
                            if is_main
                                && !known
                                && !registry.pending_turn_starts.remove(&current.run_id)
                            {
                                registry.uncertain_runs.insert(current.run_id.clone());
                                registry.deferred_completions.remove(&current.run_id);
                                if let Some(slot) = registry.tasks.get_mut(&current.task_id) {
                                    slot.accepting_input = false;
                                }
                                unexpected_turn = Some(current.clone());
                            }
                            registry.remember_turn(current);
                            if let Some(slot) = registry.tasks.get_mut(&current.task_id) {
                                if slot.binding.run_id == current.run_id
                                    && slot.binding.thread_id == current.thread_id
                                {
                                    slot.binding.turn_id = current.turn_id.clone();
                                }
                            }
                            if let Some(child) = registry.descendants.get_mut(&current.thread_id) {
                                if child.run_id == current.run_id {
                                    child.turn_id = current.turn_id.clone();
                                }
                            }
                            if let Some(completion) =
                                registry.deferred_completions.get_mut(&current.run_id)
                            {
                                if current.thread_id != completion.binding.thread_id {
                                    if let Some(turn_id) = &current.turn_id {
                                        completion
                                            .pending_children
                                            .insert(turn_key(&current.thread_id, turn_id));
                                        interrupt_children.push(current.clone());
                                    }
                                }
                            }
                        } else if method == "turn/completed" {
                            let is_main =
                                registry.tasks.get(&current.task_id).is_some_and(|slot| {
                                    slot.binding.run_id == current.run_id
                                        && slot.binding.thread_id == current.thread_id
                                });
                            if let Some(slot) = registry.tasks.get_mut(&current.task_id) {
                                if slot.binding.run_id == current.run_id
                                    && slot.binding.thread_id == current.thread_id
                                {
                                    if let Some(id) = &current.turn_id {
                                        slot.completed_turns.insert(id.clone());
                                    }
                                    if slot.binding.turn_id == current.turn_id {
                                        slot.binding.turn_id = None;
                                    }
                                }
                            }
                            if let Some(child) = registry.descendants.get_mut(&current.thread_id) {
                                if child.turn_id == current.turn_id {
                                    child.turn_id = None;
                                }
                            }
                            registry.pending_requests.retain(|_, pending| {
                                !(pending.binding.run_id == current.run_id
                                    && pending.binding.thread_id == current.thread_id
                                    && pending.binding.turn_id == current.turn_id)
                            });
                            if is_main {
                                let children: Vec<_> = registry
                                    .descendants
                                    .values()
                                    .filter(|child| {
                                        child.task_id == current.task_id
                                            && child.run_id == current.run_id
                                            && child.turn_id.is_some()
                                    })
                                    .cloned()
                                    .collect();
                                let pending_goals: HashSet<_> = registry
                                    .goal_pause_pending
                                    .iter()
                                    .filter(|(_, owner)| {
                                        owner.task_id == current.task_id
                                            && owner.run_id == current.run_id
                                    })
                                    .map(|(thread_id, _)| thread_id.clone())
                                    .collect();
                                if registry.uncertain_runs.contains(&current.run_id) {
                                    defer_parent = true;
                                } else if !children.is_empty() || !pending_goals.is_empty() {
                                    defer_parent = true;
                                    if let Some(slot) = registry.tasks.get_mut(&current.task_id) {
                                        slot.accepting_input = false;
                                    }
                                    if !registry.deferred_completions.contains_key(&current.run_id)
                                    {
                                        let pending_children = children
                                            .iter()
                                            .filter_map(|child| {
                                                child.turn_id.as_ref().map(|turn_id| {
                                                    turn_key(&child.thread_id, turn_id)
                                                })
                                            })
                                            .collect();
                                        registry.deferred_completions.insert(
                                            current.run_id.clone(),
                                            DeferredCompletion {
                                                binding: current.clone(),
                                                params: params.clone(),
                                                pending_children,
                                                pending_goals,
                                            },
                                        );
                                        interrupt_children.extend(children);
                                        start_watchdog = Some(current.clone());
                                    }
                                }
                            } else if let Some(turn_id) = &current.turn_id {
                                let ready = registry
                                    .deferred_completions
                                    .get_mut(&current.run_id)
                                    .is_some_and(|completion| {
                                        completion
                                            .pending_children
                                            .remove(&turn_key(&current.thread_id, turn_id));
                                        completion.pending_children.is_empty()
                                            && completion.pending_goals.is_empty()
                                    });
                                if ready {
                                    if let Some(completion) =
                                        registry.deferred_completions.remove(&current.run_id)
                                    {
                                        released_completions.push(completion);
                                    }
                                }
                            }
                        }
                        if method == "thread/goal/updated"
                            && params.pointer("/goal/status").and_then(Value::as_str)
                                == Some("active")
                        {
                            if !registry.goal_pause_pending.contains_key(&current.thread_id) {
                                registry
                                    .goal_pause_pending
                                    .insert(current.thread_id.clone(), current.clone());
                                if let Some(completion) =
                                    registry.deferred_completions.get_mut(&current.run_id)
                                {
                                    completion.pending_goals.insert(current.thread_id.clone());
                                }
                                pause_goal = Some(current.clone());
                            }
                        }
                        if let Some(id) = &request_id {
                            let valid = registry.tasks.get(&current.task_id).is_some_and(|slot| {
                                slot.binding.run_id == current.run_id && slot.accepting_input
                            });
                            stale_request = !valid;
                            if valid {
                                let key = request_key(id);
                                registry.remember_request(&key, current);
                                registry.pending_requests.insert(
                                    key,
                                    PendingRequest {
                                        binding: current.clone(),
                                        method: method.clone(),
                                    },
                                );
                            }
                        }
                    }
                }
                if stale_request {
                    if let Some(id) = request_id.clone() {
                        let _ = self.server.respond_error(
                            id,
                            -32600,
                            "This task execution has been superseded or paused",
                        );
                    }
                }
                if !interrupt_children.is_empty() {
                    self.stop_children_async(interrupt_children);
                }
                if let Some(owner) = pause_goal {
                    self.pause_goal_async(owner);
                }
                if let Some(owner) = unexpected_turn {
                    self.stop_unexpected_turn(owner);
                    return;
                }
                if let Some(parent) = start_watchdog {
                    self.emit(Some(parent.clone()), "runtime/children/stopping", json!({"reason":"Waiting for internal subagents to stop before releasing the task workspace"}), None);
                    self.watch_child_shutdown(parent);
                }
                if !defer_parent {
                    self.emit(binding, &method, params, request_id);
                }
                for completion in released_completions {
                    self.emit(
                        Some(completion.binding),
                        "turn/completed",
                        completion.params,
                        None,
                    );
                }
            }
        }
    }

    fn pause_goal_async(self: &Arc<Self>, owner: Binding) {
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            let Some(shared) = weak.upgrade() else {
                return;
            };
            let result = shared.server.request_with_timeout(
                "thread/goal/set",
                json!({"threadId":owner.thread_id,"status":"paused","origin":"automatic"}),
                Duration::from_secs(5),
            );
            // The reader has already enqueued any wire notifications preceding this
            // RPC response. Process the acknowledgement on that same queue so a
            // hidden native turn cannot be overtaken by a success callback.
            let _ = shared.server.enqueue_local_event(
                "runtime/internal/goal-pause-result",
                json!({
                    "threadId":owner.thread_id,"runId":owner.run_id,"error":result.err()
                }),
            );
        });
    }

    fn goal_pause_result(&self, params: Value) {
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let Some(run_id) = params.get("runId").and_then(Value::as_str) else {
            return;
        };
        let error = params
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string);
        let (owner, completion) =
            match self.lock_registry() {
                Ok(mut registry) => {
                    let Some(owner) = registry.goal_pause_pending.get(thread_id).cloned() else {
                        return;
                    };
                    if owner.run_id != run_id {
                        return;
                    }
                    registry.goal_pause_pending.remove(thread_id);
                    if error.is_some() {
                        registry.uncertain_runs.insert(run_id.to_string());
                        registry.deferred_completions.remove(run_id);
                        (owner, None)
                    } else {
                        let ready = registry.deferred_completions.get_mut(run_id).is_some_and(
                            |completion| {
                                completion.pending_goals.remove(thread_id);
                                completion.pending_goals.is_empty()
                                    && completion.pending_children.is_empty()
                            },
                        );
                        let completion = if ready && !registry.uncertain_runs.contains(run_id) {
                            registry.deferred_completions.remove(run_id)
                        } else {
                            None
                        };
                        (owner, completion)
                    }
                }
                Err(_) => {
                    self.server.shutdown();
                    return;
                }
            };
        if let Some(error) = error {
            self.emit(
                Some(owner),
                "runtime/goal/pause_failed",
                json!({"reason":error}),
                None,
            );
            self.server.shutdown();
        } else {
            self.emit(
                Some(owner),
                "runtime/goal/paused",
                json!({"reason":"Task scheduler owns continuation"}),
                None,
            );
            if let Some(completion) = completion {
                self.emit(
                    Some(completion.binding),
                    "turn/completed",
                    completion.params,
                    None,
                );
            }
        }
    }

    fn stop_unexpected_turn(self: &Arc<Self>, owner: Binding) {
        self.emit(Some(owner.clone()),"runtime/unexpected_turn",json!({
            "reason":"Codex started a turn without a scheduler lease; execution is being stopped for reconciliation"
        }),None);
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            let Some(shared) = weak.upgrade() else {
                return;
            };
            if let Some(turn_id) = &owner.turn_id {
                let _ = shared.server.request_with_timeout(
                    "turn/interrupt",
                    json!({"threadId":owner.thread_id,"turnId":turn_id}),
                    Duration::from_secs(5),
                );
            }
            shared.server.shutdown();
        });
    }

    fn stop_children_async(self: &Arc<Self>, children: Vec<Binding>) {
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            for child in children {
                let Some(shared) = weak.upgrade() else {
                    return;
                };
                let Some(turn_id) = &child.turn_id else {
                    continue;
                };
                if let Err(error) = shared.server.request(
                    "turn/interrupt",
                    json!({"threadId":child.thread_id,"turnId":turn_id}),
                ) {
                    shared.emit(
                        Some(child),
                        "runtime/children/stop_failed",
                        json!({"reason":error}),
                        None,
                    );
                    // The child may already have ended while the interrupt was in
                    // flight. Only a terminal notification releases the workspace;
                    // the watchdog handles a genuinely missing confirmation.
                }
            }
        });
    }

    fn watch_child_shutdown(self: &Arc<Self>, parent: Binding) {
        let weak = Arc::downgrade(self);
        let timeout = Duration::from_millis(self.child_stop_timeout_ms.load(Ordering::Relaxed));
        thread::spawn(move || {
            thread::sleep(timeout);
            let Some(shared) = weak.upgrade() else {
                return;
            };
            let pending = shared
                .lock_registry()
                .map(|mut registry| {
                    registry
                        .deferred_completions
                        .remove(&parent.run_id)
                        .is_some()
                })
                .unwrap_or(true);
            if pending {
                shared.emit(Some(parent), "runtime/children/stop_timeout", json!({"reason":"Internal subagents did not confirm termination; task completion is not accepted"}), None);
                // The parent completion stays withheld. Transport loss makes the host
                // reconcile this run as uncertain instead of accepting its submission.
                shared.server.shutdown();
            }
        });
    }

    fn emit(
        &self,
        binding: Option<Binding>,
        method: &str,
        params: Value,
        request_id: Option<Value>,
    ) {
        let thread_id = binding
            .as_ref()
            .filter(|b| !b.thread_id.is_empty())
            .map(|b| b.thread_id.clone())
            .or_else(|| event_thread_id(&params));
        let turn_id =
            event_turn_id(&params).or_else(|| binding.as_ref().and_then(|b| b.turn_id.clone()));
        (self.sink)(RuntimeEvent {
            connection_id: self.connection_id.clone(),
            task_id: binding.as_ref().map(|b| b.task_id.clone()),
            run_id: binding
                .as_ref()
                .filter(|b| !b.run_id.is_empty())
                .map(|b| b.run_id.clone()),
            thread_id,
            turn_id,
            request_id,
            method: method.to_string(),
            params,
        });
    }
}

impl Registry {
    fn remember_turn(&mut self, binding: &Binding) {
        if let Some(turn_id) = &binding.turn_id {
            let key = turn_key(&binding.thread_id, turn_id);
            if !self.turns.contains_key(&key) {
                self.turn_order.push_back(key.clone());
            }
            self.turns.insert(key, binding.clone());
            while self.turn_order.len() > MAX_REMEMBERED_BINDINGS {
                if let Some(old) = self.turn_order.pop_front() {
                    self.turns.remove(&old);
                }
            }
        }
    }

    fn remember_request(&mut self, key: &str, binding: &Binding) {
        if !self.request_bindings.contains_key(key) {
            self.request_order.push_back(key.into());
        }
        self.request_bindings.insert(key.into(), binding.clone());
        while self.request_order.len() > MAX_REMEMBERED_BINDINGS {
            if let Some(old) = self.request_order.pop_front() {
                self.request_bindings.remove(&old);
            }
        }
    }
}

fn started(binding: &Binding) -> StartedTask {
    StartedTask {
        run_id: binding.run_id.clone(),
        thread_id: binding.thread_id.clone(),
        turn_id: binding.turn_id.clone(),
    }
}

fn event_thread_id(params: &Value) -> Option<String> {
    params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/thread/id").and_then(Value::as_str))
        .map(str::to_string)
}

fn event_turn_id(params: &Value) -> Option<String> {
    params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/id").and_then(Value::as_str))
        .map(str::to_string)
}

fn request_key(id: &Value) -> String {
    id.to_string()
}
fn turn_key(thread_id: &str, turn_id: &str) -> String {
    format!("{thread_id}\0{turn_id}")
}

fn validate_config(config: &mut TaskExecutionConfig) -> Result<(), String> {
    if config.task_id.is_empty() || config.run_id.is_empty() || config.prompt.trim().is_empty() {
        return Err("任务、执行标识和任务内容不能为空".into());
    }
    let workspace = Path::new(&config.workspace);
    if !workspace.is_absolute() || !workspace.is_dir() {
        return Err("工作目录必须是存在的绝对目录".into());
    }
    config.workspace = workspace
        .canonicalize()
        .map_err(|e| format!("无法读取工作目录：{e}"))?
        .to_string_lossy()
        .into_owned();
    if !matches!(
        config.approval_policy.as_str(),
        "on-request" | "untrusted" | "never"
    ) {
        return Err("不支持的 Codex 审批策略".into());
    }
    if !matches!(
        config.sandbox_mode.as_str(),
        "workspace-write" | "read-only" | "danger-full-access"
    ) {
        return Err("不支持的 Codex 沙箱模式".into());
    }
    Ok(())
}

pub fn text_input(text: &str) -> Value {
    json!({"type":"text","text":text,"text_elements":[]})
}

fn validate_attachments(attachments: Vec<Value>) -> Result<Vec<Value>, String> {
    if attachments.len() > MAX_ATTACHMENTS {
        return Err("单条消息最多附带 16 个附件".into());
    }
    for attachment in &attachments {
        let valid = match attachment.get("type").and_then(Value::as_str) {
            Some("image") => attachment
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|s| s.starts_with("data:image/") || s.starts_with("https://")),
            Some("localImage") => attachment
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|s| Path::new(s).is_absolute()),
            Some("skill" | "mention") => {
                attachment.get("name").and_then(Value::as_str).is_some()
                    && attachment.get("path").and_then(Value::as_str).is_some()
            }
            _ => false,
        };
        if !valid {
            return Err("不支持的附件格式".into());
        }
    }
    Ok(attachments)
}

fn workspace_path(workspace: &str, requested: &str) -> Result<String, String> {
    let root = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = Path::new(requested);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let path = path
        .canonicalize()
        .map_err(|e| format!("无法读取文件路径：{e}"))?;
    if !path.starts_with(&root) {
        return Err("文件路径必须位于当前任务的工作目录内".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn sandbox_policy(mode: &str, workspace: &str) -> Value {
    match mode {
        "read-only" => json!({"type":"readOnly","networkAccess":false}),
        "danger-full-access" => json!({"type":"dangerFullAccess"}),
        _ => {
            json!({"type":"workspaceWrite","writableRoots":[workspace],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
        }
    }
}

fn thread_params(config: &TaskExecutionConfig) -> Value {
    let mut params = json!({
        "cwd": config.workspace,
        "approvalPolicy": config.approval_policy,
        "sandbox": config.sandbox_mode,
        "developerInstructions": format!("{}\n\n{}", config.instructions.as_deref().unwrap_or(""), task_protocol_instructions()),
        "dynamicTools": task_tool_specs()
    });
    if let Some(model) = &config.model {
        params["model"] = json!(model);
    }
    if config.browser_enabled {
        // This override is captured when the thread is first loaded. The task store
        // freezes browser configuration after thread creation; a warm resume cannot
        // silently change its MCP servers. Playwright owns a separate headed browser.
        params["config"] = json!({
            "mcp_servers.agentkanban_browser": {
                "command": "npx",
                "args": ["-y", "@playwright/mcp@0.0.83", "--isolated", "--browser", "chrome"],
                "enabled": true,
                "required": true,
                "startup_timeout_sec": 60,
                "tool_timeout_sec": 120
            }
        });
    }
    params
}

fn thread_start_timeout(config: &TaskExecutionConfig) -> Duration {
    Duration::from_secs(if config.browser_enabled { 90 } else { 30 })
}

fn validate_response(method: &str, result: &Value) -> Result<(), String> {
    match method {
        "item/tool/call"
            if result.get("success").and_then(Value::as_bool).is_some()
                && result
                    .get("contentItems")
                    .and_then(Value::as_array)
                    .is_some() =>
        {
            Ok(())
        }
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            if matches!(
                result.get("decision").and_then(Value::as_str),
                Some("accept" | "acceptForSession" | "decline" | "cancel")
            ) {
                Ok(())
            } else {
                Err("审批结果必须是明确的允许、拒绝或取消".into())
            }
        }
        "item/tool/requestUserInput"
            if result.get("answers").and_then(Value::as_object).is_some() =>
        {
            Ok(())
        }
        "item/permissions/requestApproval"
            if result
                .get("permissions")
                .and_then(Value::as_object)
                .is_some() =>
        {
            Ok(())
        }
        "mcpServer/elicitation/request"
            if matches!(
                result.get("action").and_then(Value::as_str),
                Some("accept" | "decline" | "cancel")
            ) =>
        {
            Ok(())
        }
        _ => Err(format!("不支持或无效的 Codex 请求回应：{method}")),
    }
}

pub fn tool_result(success: bool, value: Value) -> Value {
    json!({"success":success,"contentItems":[{"type":"inputText","text":value.to_string()}]})
}

pub fn task_protocol_instructions() -> &'static str {
    "You are executing a durable task in AgentKanbanBoard. The host scheduler owns task lifecycle and continuation. Do not enable native thread Goals, do not start another Codex process, and do not modify the task database directly. Use the task tools for coordination. Before ending a work turn, call exactly one of task_submit_result (only with concrete evidence that acceptance is met), task_wait (a real blocker, dependency, or question), or task_continue (the next actionable step). A final chat message alone does not complete a task. task_delegate creates a real child task; tree ownership is not an execution dependency. Add blocked_by explicitly when a result is required. task_message delivers durable context to another task without assuming that it has received or acted on it. Never approve your own permission request or claim a check passed if it was not run. After task_submit_result or task_wait succeeds, stop work and return a concise handoff; the host resumes you when the task is eligible. A rejected submission should be fixed within the same turn. Respect workspace and permission boundaries."
}

pub fn task_tool_specs() -> Vec<Value> {
    let function = |name: &str, description: &str, properties: Value, required: Vec<&str>| {
        json!({"type":"function","name":name,"description":description,"inputSchema":{
            "type":"object","properties":properties,"required":required,"additionalProperties":false
        }})
    };
    vec![
        function("task_submit_result", "Submit a candidate task result with verifiable evidence. The host checks acceptance/review policy before completing the task.", json!({
            "summary":{"type":"string"},"evidence":{"type":"array","items":{"type":"string"}},"checks":{"type":"array","items":{"type":"string"}}
        }), vec!["summary","evidence"]),
        function("task_wait", "Persist a blocker and yield. Use task IDs for blocked_by; ask a concrete question only when human input is necessary.", json!({
            "reason":{"type":"string"},"blocked_by":{"type":"array","items":{"type":"string"}},"question":{"type":"string"}
        }), vec!["reason"]),
        function("task_delegate", "Create and assign a child task. Child completion does not itself complete the parent. Do not make the child depend on the parent's completion.", json!({
            "title":{"type":"string"},"prompt":{"type":"string"},"acceptance":{"type":"string"},"agent_id":{"type":"string"},"blocked_by":{"type":"array","items":{"type":"string"}}
        }), vec!["title","prompt","acceptance"]),
        function("task_message", "Send durable task context or feedback to another task. The host wakes it only when eligible.", json!({
            "target_task_id":{"type":"string"},"message":{"type":"string"}
        }), vec!["target_task_id","message"]),
        function("task_continue", "Request another bounded work turn with a specific next action. Do not use this to poll a blocker or repeat an unchanged attempt.", json!({
            "next_action":{"type":"string"}
        }), vec!["next_action"]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> TaskExecutionConfig {
        TaskExecutionConfig {
            task_id: "task".into(),
            run_id: "run".into(),
            thread_id: None,
            workspace: std::env::temp_dir().to_string_lossy().into_owned(),
            prompt: "work".into(),
            model: None,
            reasoning_effort: None,
            approval_policy: "on-request".into(),
            sandbox_mode: "workspace-write".into(),
            instructions: None,
            browser_enabled: false,
        }
    }

    #[test]
    fn browser_is_opt_in_and_pins_a_required_isolated_headed_mcp() {
        let mut config = test_config();
        assert!(thread_params(&config).get("config").is_none());
        assert_eq!(thread_start_timeout(&config), Duration::from_secs(30));
        config.browser_enabled = true;
        assert_eq!(
            thread_params(&config)["config"]["mcp_servers.agentkanban_browser"],
            json!({
                "command":"npx",
                "args":["-y","@playwright/mcp@0.0.83","--isolated","--browser","chrome"],
                "enabled":true,"required":true,"startup_timeout_sec":60,"tool_timeout_sec":120
            })
        );
        assert_eq!(thread_start_timeout(&config), Duration::from_secs(90));
        let mut legacy = serde_json::to_value(config).unwrap();
        legacy.as_object_mut().unwrap().remove("browser_enabled");
        assert!(
            !serde_json::from_value::<TaskExecutionConfig>(legacy)
                .unwrap()
                .browser_enabled
        );
    }

    fn receive_method(receiver: &mpsc::Receiver<RuntimeEvent>, method: &str) -> RuntimeEvent {
        loop {
            let event = receiver
                .recv_timeout(Duration::from_secs(3))
                .expect("runtime event");
            if event.method == method {
                return event;
            }
        }
    }

    fn active_goal_fixture(mode: &str) -> (CodexRuntime, mpsc::Receiver<RuntimeEvent>) {
        let script = r#"
import sys, json, time
def emit(value): print(json.dumps(value), flush=True)
for line in sys.stdin:
    message=json.loads(line)
    method=message.get('method')
    if method=='initialize':
        emit({'id':message['id'],'result':{}})
    elif method=='thread/start':
        emit({'id':message['id'],'result':{'thread':{'id':'parent'}}})
    elif method=='thread/goal/get':
        emit({'id':message['id'],'result':{'goal':None}})
    elif method=='turn/start':
        emit({'id':message['id'],'result':{'turn':{'id':'parent-turn','status':'inProgress'}}})
        emit({'method':'turn/started','params':{'threadId':'parent','turn':{'id':'parent-turn','status':'inProgress'}}})
        emit({'method':'thread/goal/updated','params':{'threadId':'parent','goal':{'status':'active','objective':'native goal'}}})
        emit({'method':'turn/completed','params':{'threadId':'parent','turn':{'id':'parent-turn','status':'completed'}}})
    elif method=='thread/goal/set':
        assert message['params']=={'threadId':'parent','status':'paused','origin':'automatic'}
        time.sleep(0.03)
        if MODE=='hidden':
            # These wire events precede the pause RPC response. Its worker must not
            # release parent success before the runtime has inspected this turn.
            emit({'method':'turn/started','params':{'threadId':'parent','turn':{'id':'hidden-turn','status':'inProgress'}}})
        if MODE=='error':
            emit({'id':message['id'],'error':{'code':-32000,'message':'cannot pause goal'}})
        else:
            emit({'id':message['id'],'result':{'goal':{'status':'paused'}}})
    elif method=='turn/interrupt':
        assert message['params']['turnId']=='hidden-turn'
        emit({'id':message['id'],'result':{}})
"#.replace("MODE", &serde_json::to_string(mode).unwrap());
        let mut command = std::process::Command::new("python3");
        command.args(["-u", "-c", &script]);
        let (server, events) = AppServer::spawn_command(command).unwrap();
        let (send, receive) = mpsc::channel();
        let runtime = CodexRuntime::from_server(
            server,
            events,
            Arc::new(move |event| {
                let _ = send.send(event);
            }),
        )
        .unwrap();
        runtime.start_task(test_config()).unwrap();
        (runtime, receive)
    }

    #[test]
    fn active_goal_is_paused_before_parent_completion_is_released() {
        let (runtime, receive) = active_goal_fixture("normal");
        let mut paused = false;
        loop {
            let event = receive.recv_timeout(Duration::from_secs(3)).unwrap();
            if event.method == "runtime/goal/paused" {
                paused = true;
            }
            if event.method == "turn/completed" {
                assert!(
                    paused,
                    "native Goal pause acknowledgement must precede completion"
                );
                assert_eq!(event.params["turn"]["status"], "completed");
                break;
            }
        }
        assert!(runtime.is_alive());
        runtime.shutdown();
    }

    #[test]
    fn hidden_native_turn_cannot_be_overtaken_by_async_goal_pause_acknowledgement() {
        let (runtime, receive) = active_goal_fixture("hidden");
        let mut interrupted = false;
        loop {
            let event = receive.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_ne!(
                event.method, "turn/completed",
                "unknown native execution must withhold success"
            );
            if event.method == "runtime/unexpected_turn" {
                interrupted = true;
            }
            if event.method == "runtime/disconnected" {
                break;
            }
        }
        assert!(interrupted);
        assert!(!runtime.is_alive());
    }

    #[test]
    fn failed_native_goal_pause_disconnects_without_releasing_parent_success() {
        let (runtime, receive) = active_goal_fixture("error");
        let mut saw_failure = false;
        loop {
            let event = receive.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_ne!(
                event.method, "turn/completed",
                "failed Goal pause must withhold success"
            );
            if event.method == "runtime/goal/pause_failed" {
                saw_failure = true;
            }
            if event.method == "runtime/disconnected" {
                break;
            }
        }
        assert!(saw_failure);
        assert!(!runtime.is_alive());
    }

    fn startup_pause_fixture(
        hold_turn_start: bool,
    ) -> (
        CodexRuntime,
        mpsc::Receiver<RuntimeEvent>,
        thread::JoinHandle<Result<StartedTask, String>>,
    ) {
        let script = r#"
import sys, json
pending_goal=None
def emit(value): print(json.dumps(value),flush=True)
for line in sys.stdin:
    message=json.loads(line)
    method=message.get('method')
    if method=='initialize': emit({'id':message['id'],'result':{}})
    elif method=='thread/start': emit({'id':message['id'],'result':{'thread':{'id':'parent'}}})
    elif method=='thread/goal/get':
        if HOLD_TURN:
            emit({'id':message['id'],'result':{'goal':None}})
        else:
            pending_goal=message['id']
            emit({'method':'test/startup-held','params':{'threadId':'parent'}})
    elif method=='model/list':
        emit({'id':pending_goal,'result':{'goal':None}})
        emit({'id':message['id'],'result':{'data':[]}})
    elif method=='turn/start':
        assert HOLD_TURN, 'paused startup must never send turn/start'
        emit({'method':'test/startup-held','params':{'threadId':'parent'}})
"#
        .replace("HOLD_TURN", if hold_turn_start { "True" } else { "False" });
        let mut command = std::process::Command::new("python3");
        command.args(["-u", "-c", &script]);
        let (server, events) = AppServer::spawn_command(command).unwrap();
        let (send, receive) = mpsc::channel();
        let runtime = CodexRuntime::from_server(
            server,
            events,
            Arc::new(move |event| {
                let _ = send.send(event);
            }),
        )
        .unwrap();
        let starter = runtime.clone();
        let worker = thread::spawn(move || starter.start_task(test_config()));
        receive_method(&receive, "test/startup-held");
        (runtime, receive, worker)
    }

    #[test]
    fn pause_during_thread_setup_prevents_turn_start() {
        let (runtime, _receive, worker) = startup_pause_fixture(false);
        runtime.interrupt("task", "run").unwrap();
        runtime.rpc_read("model/list", json!({})).unwrap();
        assert!(worker.join().unwrap().unwrap_err().contains("暂停"));
        assert!(runtime.is_alive());
        runtime.shutdown();
    }

    #[test]
    fn interrupt_without_pending_start_turn_id_reports_uncertainty() {
        let (runtime, _receive, worker) = startup_pause_fixture(true);
        assert!(runtime
            .interrupt("task", "run")
            .unwrap_err()
            .contains("turn.id"));
        // The service responds to uncertainty by stopping the owned process.
        runtime.shutdown();
        assert!(worker.join().unwrap().is_err());
    }

    #[test]
    fn cancelling_a_start_waiting_for_operations_does_not_stop_another_task() {
        let script = r#"
import sys, json
starts=0
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    if method=='initialize': result={}
    elif method=='thread/start':
        starts+=1
        assert starts==1, 'cancelled task must not create a thread'
        result={'thread':{'id':'thread-a'}}
    elif method=='thread/goal/get': result={'goal':None}
    elif method=='turn/start': result={'turn':{'id':'turn-a','status':'inProgress'}}
    elif method=='model/list': result={'data':[],'starts':starts}
    else: continue
    print(json.dumps({'id':request['id'],'result':result}),flush=True)
"#;
        let mut command = std::process::Command::new("python3");
        command.args(["-u", "-c", script]);
        let (server, events) = AppServer::spawn_command(command).unwrap();
        let runtime = CodexRuntime::from_server(server, events, Arc::new(|_| {})).unwrap();
        runtime.start_task(test_config()).unwrap();
        let operation = runtime.shared.operations.lock().unwrap();
        let starter = runtime.clone();
        let (ready_send, ready_receive) = mpsc::channel();
        let worker = thread::spawn(move || {
            ready_send.send(()).unwrap();
            starter.start_task(TaskExecutionConfig {
                task_id: "task-b".into(),
                run_id: "run-b".into(),
                ..test_config()
            })
        });
        ready_receive.recv_timeout(Duration::from_secs(3)).unwrap();
        runtime.interrupt("task-b", "run-b").unwrap();
        assert!(runtime.is_alive());
        drop(operation);
        assert!(worker.join().unwrap().is_err());
        assert!(runtime.binding_snapshot("task-b", "run-b").is_none());
        assert_eq!(
            runtime
                .binding_snapshot("task", "run")
                .unwrap()
                .turn_id
                .as_deref(),
            Some("turn-a")
        );
        assert_eq!(
            runtime.rpc_read("model/list", json!({})).unwrap()["starts"],
            1
        );
        assert!(runtime.is_alive());
        runtime.shutdown();
    }

    #[test]
    fn inherited_goal_pause_error_closes_the_uncertain_registered_thread() {
        let script = r#"
import sys, json
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    if method=='initialize': result={}
    elif method=='thread/start': result={'thread':{'id':'created-thread'}}
    elif method=='thread/goal/get': result={'goal':{'status':'active'}}
    elif method=='thread/goal/set':
        print(json.dumps({'id':request['id'],'error':{'code':-32000,'message':'cannot pause'}}),flush=True)
        continue
    elif method=='turn/start': raise Exception('must not start a turn with uncertain Goal state')
    else: continue
    print(json.dumps({'id':request['id'],'result':result}),flush=True)
"#;
        let mut command = std::process::Command::new("python3");
        command.args(["-u", "-c", script]);
        let (server, events) = AppServer::spawn_command(command).unwrap();
        let runtime = CodexRuntime::from_server(server, events, Arc::new(|_| {})).unwrap();
        assert!(runtime.start_task(test_config()).is_err());
        assert!(!runtime.is_alive());
        assert_eq!(
            runtime.binding_snapshot("task", "run").unwrap().thread_id,
            "created-thread"
        );
    }

    fn stopping_child_fixture(acknowledge: bool) -> (CodexRuntime, mpsc::Receiver<RuntimeEvent>) {
        let script = r#"
import sys, json, time
def emit(value): print(json.dumps(value), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if method == 'initialize':
        emit({'id':message['id'],'result':{}})
    elif method == 'thread/start':
        emit({'id':message['id'],'result':{'thread':{'id':'parent'}}})
    elif method == 'thread/goal/get':
        emit({'id':message['id'],'result':{'goal':None}})
    elif method == 'turn/start':
        emit({'id':message['id'],'result':{'turn':{'id':'parent-turn','status':'inProgress'}}})
        emit({'method':'turn/started','params':{'threadId':'parent','turn':{'id':'parent-turn','status':'inProgress'}}})
        emit({'method':'thread/started','params':{'thread':{'id':'child','parentThreadId':'parent'}}})
        emit({'method':'turn/started','params':{'threadId':'child','turn':{'id':'child-turn','status':'inProgress'}}})
        emit({'method':'turn/completed','params':{'threadId':'parent','turn':{'id':'parent-turn','status':'completed'}}})
    elif method == 'turn/interrupt':
        assert message['params']['threadId'] == 'child'
        emit({'id':message['id'],'result':{}})
        if ACK_CHILD:
            time.sleep(0.04)
            emit({'method':'turn/completed','params':{'threadId':'child','turn':{'id':'child-turn','status':'interrupted'}}})
"#.replace("ACK_CHILD", if acknowledge { "True" } else { "False" });
        let mut command = std::process::Command::new("python3");
        command.args(["-u", "-c", &script]);
        let (server, events) = AppServer::spawn_command(command).unwrap();
        let (send, receive) = mpsc::channel();
        let runtime = CodexRuntime::from_server(
            server,
            events,
            Arc::new(move |event| {
                let _ = send.send(event);
            }),
        )
        .unwrap();
        runtime
            .shared
            .child_stop_timeout_ms
            .store(150, Ordering::Relaxed);
        runtime
            .start_task(TaskExecutionConfig {
                task_id: "task".into(),
                run_id: "run".into(),
                thread_id: None,
                workspace: std::env::temp_dir().to_string_lossy().into_owned(),
                prompt: "work".into(),
                model: None,
                reasoning_effort: None,
                approval_policy: "on-request".into(),
                sandbox_mode: "workspace-write".into(),
                instructions: None,
                browser_enabled: false,
            })
            .unwrap();
        (runtime, receive)
    }

    #[test]
    fn parent_completion_waits_for_child_stop_confirmation() {
        let (runtime, receive) = stopping_child_fixture(true);
        receive_method(&receive, "runtime/children/stopping");
        let first_terminal = receive_method(&receive, "turn/completed");
        assert_eq!(first_terminal.thread_id.as_deref(), Some("child"));
        let parent_terminal = receive_method(&receive, "turn/completed");
        assert_eq!(parent_terminal.thread_id.as_deref(), Some("parent"));
        assert_eq!(parent_terminal.params["turn"]["status"], "completed");
        assert!(runtime.is_alive());
        runtime.shutdown();
    }

    #[test]
    fn missing_child_stop_confirmation_never_releases_success() {
        let (runtime, receive) = stopping_child_fixture(false);
        let mut saw_timeout = false;
        loop {
            let event = receive.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_ne!(
                event.method, "turn/completed",
                "parent success must stay withheld"
            );
            if event.method == "runtime/children/stop_timeout" {
                saw_timeout = true;
            }
            if event.method == "runtime/disconnected" {
                break;
            }
        }
        assert!(saw_timeout);
        assert!(!runtime.is_alive());
    }

    #[test]
    fn failed_turn_start_still_exposes_created_thread_for_recovery() {
        let script = r#"
import json, sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    if method=='initialize': result={}
    elif method=='thread/start': result={'thread':{'id':'created-thread'}}
    elif method=='thread/goal/get': result={'goal':None}
    elif method=='turn/start':
        print(json.dumps({'id':request['id'],'error':{'code':-32000,'message':'login required'}}),flush=True)
        continue
    else: continue
    print(json.dumps({'id':request['id'],'result':result}),flush=True)
"#;
        let mut command = std::process::Command::new("python3");
        command.args(["-u", "-c", script]);
        let (server, events) = AppServer::spawn_command(command).unwrap();
        let runtime = CodexRuntime::from_server(server, events, Arc::new(|_| {})).unwrap();
        assert!(runtime
            .start_task(TaskExecutionConfig {
                task_id: "task".into(),
                run_id: "run".into(),
                thread_id: None,
                workspace: std::env::temp_dir().to_string_lossy().into_owned(),
                prompt: "work".into(),
                model: None,
                reasoning_effort: None,
                approval_policy: "on-request".into(),
                sandbox_mode: "workspace-write".into(),
                instructions: None,
                browser_enabled: false,
            })
            .is_err());
        let binding = runtime.binding_snapshot("task", "run").unwrap();
        assert_eq!(binding.thread_id, "created-thread");
        assert!(binding.turn_id.is_none());
        runtime.shutdown();
    }

    #[test]
    fn live_protocol_routes_child_approvals_and_never_completes_parent_from_child_turn() {
        let script = r#"
import sys, json
turn = 0
def emit(value):
    print(json.dumps(value), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if method == 'initialize':
        assert message['params']['capabilities']['experimentalApi'] is True
        emit({'id':message['id'],'result':{'userAgent':'fake-codex/0.128.0'}})
    elif method == 'thread/start':
        specs = message['params']['dynamicTools']
        assert all(tool['type'] == 'function' for tool in specs)
        assert 'task_submit_result' in [tool['name'] for tool in specs]
        emit({'method':'thread/started','params':{'thread':{'id':'main-thread'}}})
        emit({'id':message['id'],'result':{'thread':{'id':'main-thread'}}})
    elif method == 'thread/resume':
        emit({'method':'item/agentMessage/delta','params':{'threadId':'main-thread','turnId':'main-turn-1','delta':'late old output'}})
        emit({'id':message['id'],'result':{'thread':{'id':'main-thread'}}})
    elif method == 'thread/goal/get':
        emit({'id':message['id'],'result':{'goal':None}})
    elif method == 'turn/start':
        turn += 1
        main_turn = 'main-turn-' + str(turn)
        child = 'native-child'
        child_turn = 'child-turn-' + str(turn)
        emit({'id':message['id'],'result':{'turn':{'id':main_turn,'status':'inProgress'}}})
        emit({'method':'turn/started','params':{'threadId':'main-thread','turn':{'id':main_turn,'status':'inProgress'}}})
        if turn == 1:
            emit({'method':'thread/started','params':{'thread':{'id':child,'parentThreadId':'main-thread'}}})
        emit({'method':'turn/started','params':{'threadId':child,'turn':{'id':child_turn,'status':'inProgress'}}})
        emit({'id':'child-approval-' + str(turn),'method':'item/commandExecution/requestApproval','params':{'threadId':child,'turnId':child_turn,'itemId':'command'}})
    elif str(message.get('id','')).startswith('child-approval-'):
        assert message['result']['decision'] == 'decline'
        emit({'method':'serverRequest/resolved','params':{'threadId':child,'requestId':message['id']}})
        emit({'method':'turn/completed','params':{'threadId':child,'turn':{'id':child_turn,'status':'completed'}}})
        emit({'id':'submission-' + str(turn),'method':'item/tool/call','params':{'threadId':'main-thread','turnId':main_turn,'callId':'submit','tool':'task_submit_result','arguments':{'summary':'finished','evidence':['checks passed']}}})
    elif str(message.get('id','')).startswith('submission-'):
        assert message['result']['contentItems'][0]['type'] == 'inputText'
        emit({'method':'serverRequest/resolved','params':{'threadId':'main-thread','requestId':message['id']}})
        emit({'method':'turn/completed','params':{'threadId':'main-thread','turn':{'id':main_turn,'status':'completed'}}})
"#;
        let mut command = std::process::Command::new("python3");
        command.args(["-u", "-c", script]);
        let (server, events) = AppServer::spawn_command(command).unwrap();
        let (send, receive) = mpsc::channel();
        let runtime = CodexRuntime::from_server(
            server,
            events,
            Arc::new(move |event| {
                let _ = send.send(event);
            }),
        )
        .unwrap();
        let config = TaskExecutionConfig {
            task_id: "task-a".into(),
            run_id: "run-1".into(),
            thread_id: None,
            workspace: std::env::temp_dir().to_string_lossy().into_owned(),
            prompt: "Complete the task with evidence".into(),
            model: None,
            reasoning_effort: None,
            approval_policy: "on-request".into(),
            sandbox_mode: "workspace-write".into(),
            instructions: None,
            browser_enabled: false,
        };
        let first = runtime.start_task(config.clone()).unwrap();
        assert_eq!(first.turn_id.as_deref(), Some("main-turn-1"));
        let approval = receive_method(&receive, "item/commandExecution/requestApproval");
        assert_eq!(approval.task_id.as_deref(), Some("task-a"));
        assert_eq!(approval.run_id.as_deref(), Some("run-1"));
        assert_eq!(approval.thread_id.as_deref(), Some("native-child"));
        runtime
            .respond_to_request(
                "task-a",
                "run-1",
                approval.request_id.unwrap(),
                json!({"decision":"decline"}),
            )
            .unwrap();
        let submit = receive_method(&receive, "item/tool/call");
        assert_eq!(
            runtime
                .shared
                .slot("task-a", "run-1")
                .unwrap()
                .binding
                .turn_id
                .as_deref(),
            Some("main-turn-1")
        );
        assert!(runtime
            .respond_to_request(
                "other-task",
                "run-1",
                submit.request_id.clone().unwrap(),
                tool_result(true, json!({}))
            )
            .is_err());
        runtime
            .respond_to_request(
                "task-a",
                "run-1",
                submit.request_id.clone().unwrap(),
                tool_result(true, json!({"accepted":true})),
            )
            .unwrap();
        let completed = receive_method(&receive, "turn/completed");
        assert_eq!(completed.thread_id.as_deref(), Some("main-thread"));
        assert_eq!(completed.params["turn"]["status"], "completed");
        assert!(runtime
            .respond_to_request(
                "task-a",
                "run-1",
                submit.request_id.unwrap(),
                tool_result(true, json!({}))
            )
            .is_err());
        let second = runtime
            .start_task(TaskExecutionConfig {
                run_id: "run-2".into(),
                thread_id: Some("main-thread".into()),
                ..config
            })
            .unwrap();
        assert_eq!(second.turn_id.as_deref(), Some("main-turn-2"));
        let late = receive_method(&receive, "item/agentMessage/delta");
        assert_eq!(late.run_id.as_deref(), Some("run-1"));
        let resumed_child = receive_method(&receive, "item/commandExecution/requestApproval");
        assert_eq!(resumed_child.thread_id.as_deref(), Some("native-child"));
        assert_eq!(resumed_child.run_id.as_deref(), Some("run-2"));
        assert!(runtime.interrupt("task-a", "run-1").is_err());
        runtime.shutdown();
    }

    #[test]
    fn tools_use_current_dynamic_tool_wire_format_and_no_complete_task_shortcut() {
        let tools = task_tool_specs();
        assert_eq!(tools.len(), 5);
        assert!(tools.iter().all(|tool| tool["type"] == "function"));
        let submit = tools
            .iter()
            .find(|tool| tool["name"] == "task_submit_result")
            .unwrap();
        assert_eq!(
            submit["inputSchema"]["required"],
            json!(["summary", "evidence"])
        );
        assert!(submit["inputSchema"]["properties"].get("status").is_none());
        assert_eq!(
            tool_result(true, json!({"accepted":true}))["contentItems"][0]["type"],
            "inputText"
        );
    }

    #[test]
    fn request_keys_do_not_conflate_integer_and_string_ids() {
        assert_ne!(request_key(&json!(1)), request_key(&json!("1")));
    }

    #[test]
    fn late_turn_binding_keeps_original_run_identity() {
        let mut registry = Registry::default();
        let old = Binding {
            task_id: "task-a".into(),
            run_id: "run-old".into(),
            thread_id: "thread".into(),
            turn_id: Some("turn-old".into()),
        };
        let new = Binding {
            run_id: "run-new".into(),
            turn_id: Some("turn-new".into()),
            ..old.clone()
        };
        registry.remember_turn(&old);
        registry.remember_turn(&new);
        assert_eq!(
            registry.turns[&turn_key("thread", "turn-old")].run_id,
            "run-old"
        );
        assert_eq!(
            registry.turns[&turn_key("thread", "turn-new")].run_id,
            "run-new"
        );
        registry.remember_request(&request_key(&json!(9)), &old);
        assert_eq!(
            registry.request_bindings[&request_key(&json!(9))].run_id,
            "run-old"
        );
    }

    #[test]
    fn validates_explicit_approval_responses_and_input_shapes() {
        assert!(validate_response(
            "item/fileChange/requestApproval",
            &json!({"decision":"accept"})
        )
        .is_ok());
        assert!(
            validate_response("item/fileChange/requestApproval", &json!({"resolved":true}))
                .is_err()
        );
        assert!(validate_response("item/tool/requestUserInput", &json!({"answers":{}})).is_ok());
        assert!(
            validate_response("item/tool/call", &tool_result(false, json!({"error":"no"}))).is_ok()
        );
        assert!(
            validate_attachments(vec![json!({"type":"image","url":"javascript:alert(1)"})])
                .is_err()
        );
        assert!(
            validate_attachments(vec![json!({"type":"localImage","path":"relative.png"})]).is_err()
        );
        assert!(validate_attachments(vec![
            json!({"type":"image","url":"data:image/png;base64,YQ=="})
        ])
        .is_ok());
        assert_eq!(text_input("hello")["text_elements"], json!([]));
    }

    #[test]
    fn read_paths_cannot_escape_workspace() {
        let root = std::env::temp_dir().join(format!("akb-runtime-path-{}", std::process::id()));
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        std::fs::write(root.join("outside.txt"), "private").unwrap();
        std::fs::write(root.join("workspace/inside.txt"), "allowed").unwrap();
        let workspace = root.join("workspace").to_string_lossy().into_owned();
        assert!(workspace_path(&workspace, "inside.txt").is_ok());
        assert!(workspace_path(&workspace, "../outside.txt").is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
