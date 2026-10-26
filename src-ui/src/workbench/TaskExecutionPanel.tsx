import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Bot, Check, ChevronDown, FileCode2, History, LoaderCircle, MessageSquare, Paperclip, Pause, Play, RotateCcw, Send, Settings2, ShieldCheck, Square, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TodoTask } from "@/todo/types";
import { workbenchApi, type WorkbenchApi } from "./api";
import { executionDiff, executionTimeline, record } from "./events";
import { isCurrentInteraction, workStatusLabels } from "./types";
import type { AgentProfile, ContextAttachment, TaskAction, TaskConfig, TaskExecutionDetail, TaskInteraction, WorkTask } from "./types";
import { WorkspacePanel } from "./WorkspacePanel";

type Props = {
  task: TodoTask;
  tasks: TodoTask[];
  work?: WorkTask;
  agents?: AgentProfile[];
  defaultWorkspace?: string;
  enabled: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  api?: WorkbenchApi;
};
type Tab = "conversation" | "diff" | "workspace" | "history" | "settings";
const tabs: { id: Tab; label: string; icon: typeof MessageSquare }[] = [
  { id: "conversation", label: "会话", icon: MessageSquare },
  { id: "diff", label: "变更", icon: FileCode2 },
  { id: "workspace", label: "工作区", icon: Terminal },
  { id: "history", label: "记录", icon: History },
  { id: "settings", label: "委派设置", icon: Settings2 }
];

export function TaskExecutionPanel({ task, tasks, work, agents, defaultWorkspace = "", enabled, onClose, onChanged, api = workbenchApi }: Props) {
  const [detail, setDetail] = useState<TaskExecutionDetail>();
  const [tab, setTab] = useState<Tab>(work ? "conversation" : "settings");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const [showAttachments, setShowAttachments] = useState(false);
  const [fileContext, setFileContext] = useState("");
  const [imageContext, setImageContext] = useState("");
  const requestSequence = useRef(0);
  const currentTaskId = useRef(task.id);
  const detailBusy = useRef(false);
  const current = detail?.task.task_id === task.id && (!work || detail.task.revision >= work.revision) ? detail.task : work;

  const refresh = async () => {
    if (!enabled || !work || detailBusy.current) return;
    detailBusy.current = true;
    const taskId = task.id;
    const sequence = ++requestSequence.current;
    try {
      const next = await api.detail(taskId);
      if (currentTaskId.current === taskId && sequence === requestSequence.current && next?.task.task_id === taskId) setDetail(next);
    } catch (reason) {
      if (currentTaskId.current === taskId) setError(String(reason));
    } finally { detailBusy.current = false; }
  };

  useEffect(() => {
    currentTaskId.current = task.id;
    requestSequence.current += 1;
    setDetail(undefined);
    setDraft(""); setFeedback(""); setError(undefined);
    setTab(work ? "conversation" : "settings");
    return () => { currentTaskId.current = ""; requestSequence.current += 1; };
  }, [task.id]);

  useEffect(() => {
    if (!enabled || !work) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [task.id, enabled, Boolean(work), work?.revision]);

  const perform = async (key: string, operation: () => Promise<unknown>) => {
    if (!enabled || busy) return;
    const taskId = task.id;
    setBusy(key); setError(undefined);
    try {
      await operation();
      await onChanged();
      if (currentTaskId.current === taskId) await refresh();
    } catch (reason) {
      if (currentTaskId.current === taskId) setError(String(reason));
      await onChanged();
    } finally { if (currentTaskId.current === taskId) setBusy(undefined); }
  };

  const action = (name: TaskAction, text?: string) => {
    if (!current) return;
    void perform(name, () => api.action(task.id, name, current.revision, text));
  };

  const timeline = useMemo(() => executionTimeline(detail?.events ?? []), [detail?.events]);
  const diff = useMemo(() => executionDiff(detail?.events ?? []), [detail?.events]);
  const run = detail?.runs.find((entry) => entry.id === current?.current_run_id) ?? detail?.runs.slice().sort((a, b) => b.generation - a.generation)[0];
  const detailIsCurrent = Boolean(detail && current && detail.task.task_id === current.task_id && detail.task.revision >= current.revision);
  const interactions = (detailIsCurrent ? detail?.interactions ?? [] : []).filter((entry) => current && isCurrentInteraction(entry, current));
  const canSend = current && ["queued", "running"].includes(current.status) && !interactions.length;
  const hasMessageContent = Boolean(draft.trim() || fileContext.trim() || imageContext.trim());

  const send = () => {
    if (!current || !hasMessageContent || !canSend) return;
    const attachments: ContextAttachment[] = [];
    for (const path of imageContext.split("\n").map((line) => line.trim()).filter(Boolean)) attachments.push({ type: "localImage", path });
    const paths = fileContext.split("\n").map((line) => line.trim()).filter(Boolean);
    const text = (draft.trim() || (attachments.length ? "请查看附图。" : "请查看参考文件。")) + (paths.length ? `\n\n参考本地文件（遵循当前工作区权限）：\n${paths.join("\n")}` : "");
    void perform("message", async () => {
      await api.message(task.id, text, current.current_run_id, attachments);
      if (currentTaskId.current === task.id) { setDraft(""); setFileContext(""); setImageContext(""); }
    });
  };

  return (
    <aside aria-label={`任务执行工作台 ${task.title || "未命名任务"}`} className="task-execution-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-card shadow-sm xl:max-w-[70%] xl:basis-[620px]">
      <header className="border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"><Bot className="h-3.5 w-3.5" />任务工作台{current && <WorkStatusBadge task={current} />}</div>
            <h2 className="break-words text-[14px] font-semibold">{task.title || "未命名任务"}</h2>
            {current && <p className="mt-1 truncate text-[10px] text-muted-foreground" title={current.config.workspace}>{current.config.agent_id} · {current.config.workspace}</p>}
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="关闭执行工作台"><X className="h-4 w-4" /></Button>
        </div>
        {current && <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {["queued", "running", "waiting"].includes(current.status) && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => action("pause")}><Pause className="h-3 w-3" />暂停</Button>}
          {current.status === "paused" && <Button size="sm" disabled={Boolean(busy)} onClick={() => action("resume")}><Play className="h-3 w-3" />恢复执行</Button>}
          {current.status === "waiting" && current.wait_reason === "environment" && <Button size="sm" disabled={Boolean(busy)} onClick={() => action("resume")}><Play className="h-3 w-3" />问题已解决，继续执行</Button>}
          {current.status === "attention" && <Button size="sm" disabled={Boolean(busy)} onClick={() => action("retry")}><RotateCcw className="h-3 w-3" />重试执行</Button>}
          {!["completed", "cancelled"].includes(current.status) && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => action("cancel")}><Square className="h-3 w-3" />取消任务</Button>}
          <span className="ml-auto text-[10px] text-muted-foreground">{run ? `第 ${run.generation} 次执行 · ${runStatusLabel(run.status)}` : "等待执行记录"}</span>
        </div>}
      </header>

      {!enabled && <div className="border-b bg-amber-50 px-4 py-2 text-[11px] text-amber-900">浏览器预览：可查看配置，实际委派和执行需要桌面应用与本地 Codex。</div>}
      {error && <div role="alert" className="flex gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-800"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="break-all">{error}</span></div>}

      <div role="tablist" aria-label="任务执行详情" className="flex shrink-0 overflow-x-auto border-b px-2">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn("flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[11px]", tab === id ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}><Icon className="h-3.5 w-3.5" />{label}</button>)}
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {tab === "settings" ? <TaskConfiguration key={`${task.id}:${current?.revision ?? "new"}`} task={task} tasks={tasks} existing={current?.config} browserLocked={Boolean(current?.thread_id)} agents={agents} defaultWorkspace={defaultWorkspace} disabled={Boolean(busy) || !enabled || (current && ["running", "queued", "waiting", "review"].includes(current.status))} onSubmit={(config) => void perform("delegate", async () => { await api.delegate(task.id, config); if (currentTaskId.current === task.id) setTab("conversation"); })} />
          : tab === "workspace" ? <WorkspacePanel task={current} events={detail?.events ?? []} enabled={enabled} />
          : tab === "diff" ? <div className="p-4"><h3 className="mb-2 text-[12px] font-medium">最近一次代码变更</h3>{diff ? <pre className="overflow-x-auto whitespace-pre rounded-md border bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100">{diff}</pre> : <EmptyState title="暂无代码变更" description="Codex 产生的变更会在这里显示。会话结束不代表任务已完成。" />}</div>
          : tab === "history" ? <div className="space-y-3 p-4">
            <h3 className="text-[12px] font-medium">执行与流转记录</h3>
            {(detail?.runs ?? []).map((entry) => <div key={entry.id} className="rounded-md border p-3 text-[11px]"><div className="flex justify-between gap-2 font-medium"><span>第 {entry.generation} 次执行</span><span>{runStatusLabel(entry.status)}</span></div><div className="mt-1 break-all text-[10px] text-muted-foreground">{entry.thread_id} · {entry.started_at}</div>{entry.error && <p className="mt-2 text-red-700">{entry.error}</p>}</div>)}
            {(detail?.events ?? []).slice().reverse().map((entry) => <details key={entry.id} className="rounded border bg-secondary/20 px-3 py-2 text-[10px]"><summary className="cursor-pointer break-all">{entry.kind} <span className="text-muted-foreground">· {entry.created_at}</span></summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(entry.payload, null, 2)}</pre></details>)}
            {!detail?.events.length && <p className="text-[11px] text-muted-foreground">委派后的每次执行、等待、提交与返工都会保留在这里。</p>}
          </div> : <div className="space-y-4 p-4">
            {current?.wait_reason && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900"><strong>等待原因</strong><p className="mt-1 whitespace-pre-wrap break-words">{waitReasonLabel(current.wait_reason)}</p>{Boolean(current.config.blocked_by.length) && <p className="mt-2">依赖：{current.config.blocked_by.map((id) => tasks.find((candidate) => candidate.id === id)?.title || id).join("、")}</p>}</div>}
            {current?.last_error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-[11px] text-red-800">{current.last_error}</div>}
            {interactions.map((interaction) => <InteractionCard key={interaction.id} interaction={interaction} disabled={Boolean(busy)} onRespond={(response) => void perform(`interaction:${interaction.id}`, () => api.respond(task.id, interaction.id, interaction.run_id, response))} />)}
            {current?.result_summary && <section className="rounded-md border border-emerald-200 bg-emerald-50/60 p-3"><h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-emerald-900"><Check className="h-3.5 w-3.5" />{current.status === "completed" ? "已验收的交付" : "Agent 提交的结果"}</h3><p className="whitespace-pre-wrap break-words text-[12px] leading-6">{current.result_summary}</p></section>}
            {current?.status === "review" && <section className="rounded-md border border-primary/25 bg-primary/5 p-3">
              <h3 className="text-[12px] font-medium">等待验收</h3><p className="mt-1 text-[11px] text-muted-foreground">检查交付与变更。验收通过后，依赖此任务的工作会自动进入调度。</p>
              <textarea className="mt-3 w-full rounded-md border bg-card p-2 text-[12px]" rows={3} aria-label="返工反馈" placeholder="需要调整什么？填写具体反馈可退回 Agent 返工。" value={feedback} onChange={(event) => setFeedback(event.target.value)} />
              <div className="mt-2 flex gap-2"><Button size="sm" disabled={Boolean(busy) || Boolean(current.current_run_id) || !detailIsCurrent} onClick={() => action("accept")}><ShieldCheck className="h-3.5 w-3.5" />验收通过</Button><Button size="sm" variant="outline" disabled={Boolean(busy) || !feedback.trim()} onClick={() => action("rework", feedback.trim())}>反馈并返工</Button></div>
            </section>}
            {current && ["completed", "cancelled"].includes(current.status) && <section className="rounded-md border p-3"><p className="text-[11px] text-muted-foreground">任务已结束。需要修正同一目标时，填写反馈开启新的执行，历史记录会保留。</p><textarea className="mt-2 w-full rounded border p-2 text-[12px]" rows={2} value={feedback} onChange={(event) => setFeedback(event.target.value)} aria-label="返工反馈" placeholder="返工原因与要求" /><Button className="mt-2" size="sm" variant="outline" disabled={Boolean(busy) || !feedback.trim()} onClick={() => action("rework", feedback.trim())}><RotateCcw className="h-3.5 w-3.5" />创建返工执行</Button></section>}
            {timeline.map((item) => item.role === "tool" ? <details key={item.id} className="rounded-md border bg-secondary/25 px-3 py-2"><summary className="cursor-pointer break-all text-[11px] font-medium">{item.title || "工具执行"} <span className="font-normal text-muted-foreground">{item.status}</span></summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-5">{item.text || "正在等待输出…"}</pre>{item.images?.map((source, index) => <img key={index} src={source} alt={`${item.title || "工具"} 截图 ${index + 1}`} loading="lazy" className="mt-3 max-h-[480px] max-w-full rounded border object-contain" />)}</details> : <section key={item.id} className={cn("rounded-lg p-3", item.role === "user" ? "ml-6 bg-secondary" : "border bg-card")}><div className="mb-1 text-[10px] font-medium text-muted-foreground">{item.role === "user" ? "你" : "Codex"}</div><p className="whitespace-pre-wrap break-words text-[12px] leading-6">{item.text}</p></section>)}
            {!timeline.length && <EmptyState title={current ? "工作已交给执行队列" : "把任务交给 Codex"} description={current ? "执行开始后，消息、工具调用与交付会出现在这里。" : "设置工作目录、执行 Agent 和验收要求。满足依赖后自动执行。"} />}
            {current?.status === "running" && <div role="status" className="flex items-center gap-2 text-[11px] text-muted-foreground"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Codex 正在推进任务</div>}
          </div>}
      </div>

      {tab === "conversation" && current && <form className="border-t p-3" onSubmit={(event) => { event.preventDefault(); send(); }}>
        {showAttachments && <div className="mb-2 grid gap-2 sm:grid-cols-2"><label className="text-[10px] text-muted-foreground">文件路径（每行一个）<textarea className="mt-1 w-full rounded border p-2 text-[11px]" rows={2} placeholder="/absolute/path/to/file.ts" value={fileContext} onChange={(event) => setFileContext(event.target.value)} /></label><label className="text-[10px] text-muted-foreground">本地图片路径（每行一个）<textarea className="mt-1 w-full rounded border p-2 text-[11px]" rows={2} placeholder="/absolute/path/to/screenshot.png" value={imageContext} onChange={(event) => setImageContext(event.target.value)} /></label></div>}
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="发送给 Codex" disabled={!enabled || !canSend} className="min-h-[76px] w-full resize-y rounded-md border bg-background/40 p-2.5 text-[12px] outline-none focus:ring-2 focus:ring-ring disabled:opacity-50" placeholder={current.status === "paused" ? "先恢复任务，再继续对话" : current.status === "review" ? "请在上方验收，或填写反馈并返工" : ["completed", "cancelled"].includes(current.status) ? "任务已结束，可通过返工继续同一目标" : "补充上下文，或纠正当前执行方向…"} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }} />
        <div className="mt-2 flex items-center justify-between gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setShowAttachments((value) => !value)} aria-expanded={showAttachments}><Paperclip className="h-3.5 w-3.5" />添加上下文</Button><span className="hidden text-[10px] text-muted-foreground sm:inline">⌘ / Ctrl + Enter 发送</span><Button type="submit" size="sm" disabled={!enabled || !canSend || !hasMessageContent || Boolean(busy)}>{busy === "message" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}发送</Button></div>
      </form>}
    </aside>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="flex min-h-[180px] flex-col items-center justify-center px-5 text-center"><Bot className="mb-3 h-7 w-7 text-primary/45" /><h3 className="text-[13px] font-medium">{title}</h3><p className="mt-2 max-w-sm text-[11px] leading-5 text-muted-foreground">{description}</p></div>;
}

export function WorkStatusBadge({ task }: { task: WorkTask }) {
  return <span className={cn("inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium", task.status === "completed" ? "bg-emerald-100 text-emerald-800" : ["review", "waiting", "attention"].includes(task.status) ? "bg-amber-100 text-amber-900" : task.status === "running" ? "bg-blue-100 text-blue-800" : "bg-secondary text-muted-foreground")}>{task.status === "running" && <span className="h-1.5 w-1.5 rounded-full bg-blue-600" />}{workStatusLabels[task.status]}</span>;
}

function runStatusLabel(status: string) {
  const labels: Record<string, string> = { queued: "待执行", starting: "启动中", running: "运行中", in_progress: "运行中", completed: "本轮结束", submitted: "已提交", failed: "本轮失败", interrupted: "已中断", cancelled: "已取消", waiting: "等待交互", superseded: "已被替换" };
  return labels[status] || status;
}

function waitReasonLabel(reason: string) {
  const labels: Record<string, string> = { dependencies: "前置任务尚未完成，满足条件后会自动进入队列。", input: "需要你补充信息，请处理本次请求。", question: "Agent 需要你的回答，收到后会自动继续。", approval: "操作需要你的批准，请检查具体请求。", environment: "执行遇到环境问题，处理后可恢复。", recovery: "上次连接中断，需要检查执行结果后恢复。" };
  return labels[reason] ?? reason;
}

function TaskConfiguration({ task, tasks, existing, browserLocked, agents, defaultWorkspace, disabled, onSubmit }: { task: TodoTask; tasks: TodoTask[]; existing?: TaskConfig; browserLocked: boolean; agents?: AgentProfile[]; defaultWorkspace: string; disabled?: boolean; onSubmit: (config: TaskConfig) => void }) {
  const [config, setConfig] = useState<TaskConfig>(() => existing ?? { agent_id: agents?.[0]?.id || "codex", delegated_by: "user", workspace: defaultWorkspace, prompt: task.processTracking || task.title, acceptance: task.resultReview || "", review_policy: "human", blocked_by: [], approval_policy: "on-request", sandbox_mode: "workspace-write", browser_enabled: false });
  const patch = (value: Partial<TaskConfig>) => setConfig((previous) => ({ ...previous, ...value }));
  return <form className="space-y-4 p-4" onSubmit={(event) => { event.preventDefault(); onSubmit(config); }}>
    <div className="rounded-md bg-secondary/40 p-3 text-[11px] leading-5 text-muted-foreground">任务树保留工作关系，Blocked by 决定启动条件。委派后，系统负责等待、执行与结果提交。</div>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-[11px] font-medium">受理 Agent<Input value={config.agent_id} onChange={(event) => patch({ agent_id: event.target.value })} list="work-agent-profiles" className="mt-1" required disabled={disabled} /><datalist id="work-agent-profiles">{(agents ?? [{ id: "codex", name: "Codex" }]).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</datalist></label><label className="text-[11px] font-medium">委托人<Input value={config.delegated_by} onChange={(event) => patch({ delegated_by: event.target.value })} className="mt-1" placeholder="user 或来源任务 ID" required disabled={disabled} /></label></div>
    <label className="block text-[11px] font-medium">工作目录<Input value={config.workspace} onChange={(event) => patch({ workspace: event.target.value })} className="mt-1" placeholder="/absolute/path/to/project" required disabled={disabled} /><span className="mt-1 block font-normal text-muted-foreground">使用本机绝对路径。相同工作目录的写入任务按队列执行。</span></label>
    <label className="block text-[11px] font-medium">任务上下文<textarea value={config.prompt} onChange={(event) => patch({ prompt: event.target.value })} className="mt-1 min-h-[100px] w-full rounded-md border p-2.5 text-[12px]" placeholder="目标、现状、限制与必要背景" required disabled={disabled} /></label>
    <label className="block text-[11px] font-medium">验收要求<textarea value={config.acceptance} onChange={(event) => patch({ acceptance: event.target.value })} className="mt-1 min-h-[72px] w-full rounded-md border p-2.5 text-[12px]" placeholder="例如：修复问题，相关测试通过，并提供变更说明与验证证据" required disabled={disabled} /></label>
    <fieldset className="rounded-md border p-3" disabled={disabled}><legend className="px-1 text-[11px] font-medium">Blocked by · 等待这些任务完成</legend><div className="max-h-36 space-y-2 overflow-auto">{tasks.filter((candidate) => candidate.id !== task.id).map((candidate) => <label key={candidate.id} className="flex items-start gap-2 text-[11px]"><input type="checkbox" checked={config.blocked_by.includes(candidate.id)} onChange={(event) => patch({ blocked_by: event.target.checked ? [...config.blocked_by, candidate.id] : config.blocked_by.filter((id) => id !== candidate.id) })} /><span className="break-words">{candidate.title || "未命名任务"}</span></label>)}{tasks.length <= 1 && <p className="text-[11px] text-muted-foreground">暂无其他任务，可以直接执行。</p>}</div></fieldset>
    <label className="block text-[11px] font-medium">交付策略<select className="mt-1 h-9 w-full rounded-md border bg-card px-2 text-[12px]" value={config.review_policy} onChange={(event) => patch({ review_policy: event.target.value as "human" | "auto" })} disabled={disabled}><option value="human">提交结果后由我验收</option><option value="auto">Agent 提交有效结果后自动完成</option></select><span className="mt-1 block font-normal leading-5 text-muted-foreground">一轮回答结束只更新执行记录。只有明确提交结果后，才进入验收或自动完成。</span></label>
    <label className="flex items-start gap-2 rounded-md border p-3 text-[11px]"><input type="checkbox" className="mt-0.5" checked={Boolean(config.browser_enabled)} onChange={(event) => patch({ browser_enabled: event.target.checked })} disabled={disabled || browserLocked} /><span><strong className="font-medium">启用浏览器操作</strong><span className="mt-1 block leading-5 text-muted-foreground">通过独立 Chrome 窗口执行，需要 Node.js 18+ 和 Chrome。首次启动会下载固定版本的 Playwright MCP；工具输出与截图保留在会话中。</span>{browserLocked && <span className="mt-1 block text-muted-foreground">已有会话的浏览器设置已固定。如需更改，请创建新任务。</span>}</span></label>
    <details className="rounded-md border p-3"><summary className="flex cursor-pointer items-center justify-between text-[11px] font-medium">模型、权限与角色指令<ChevronDown className="h-3 w-3" /></summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="text-[11px]">模型<Input className="mt-1" value={config.model ?? ""} onChange={(event) => patch({ model: event.target.value || null })} placeholder="使用 Codex 默认模型" disabled={disabled} /></label>
      <label className="text-[11px]">推理强度<select className="mt-1 h-9 w-full rounded border bg-card px-2" value={config.reasoning_effort ?? ""} onChange={(event) => patch({ reasoning_effort: event.target.value || null })} disabled={disabled}><option value="">默认</option>{["low", "medium", "high", "xhigh"].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label className="text-[11px]">审批策略<select className="mt-1 h-9 w-full rounded border bg-card px-2" value={config.approval_policy ?? "on-request"} onChange={(event) => patch({ approval_policy: event.target.value })} disabled={disabled}><option value="on-request">按需请求审批</option><option value="untrusted">不可信操作需审批</option><option value="never">不请求提权审批</option></select></label>
      <label className="text-[11px]">沙箱<select className="mt-1 h-9 w-full rounded border bg-card px-2" value={config.sandbox_mode ?? "workspace-write"} onChange={(event) => patch({ sandbox_mode: event.target.value })} disabled={disabled}><option value="workspace-write">工作区可写</option><option value="read-only">只读</option></select></label>
      <label className="text-[11px] sm:col-span-2">角色指令<textarea className="mt-1 w-full rounded border p-2" rows={3} value={config.instructions ?? ""} onChange={(event) => patch({ instructions: event.target.value })} placeholder="本任务角色的额外约束；同时沿用项目 AGENTS.md 与 Codex 配置。" disabled={disabled} /></label>
    </div></details>
    <Button type="submit" disabled={disabled || !config.workspace.trim() || !config.prompt.trim() || !config.agent_id.trim() || !config.acceptance.trim()} className="w-full"><Play className="h-3.5 w-3.5" />{existing ? "重新委派并启动" : "委派并启动"}</Button>
    {disabled && existing && <p className="text-[10px] text-muted-foreground">执行中或等待验收时不能重新委派。先暂停任务，再修改设置。</p>}
  </form>;
}

function InteractionCard({ interaction, disabled, onRespond }: { interaction: TaskInteraction; disabled: boolean; onRespond: (response: unknown) => void }) {
  const payload = record(interaction.payload);
  const params = Object.keys(record(payload.params)).length ? record(payload.params) : payload;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [json, setJson] = useState("{}");
  const [error, setError] = useState<string>();
  const questions = Array.isArray(params.questions) ? params.questions.map(record) : [];
  const isInput = questions.length > 0 || ["task_input", "question"].includes(interaction.kind) || interaction.method === "task/question" || interaction.method.includes("requestUserInput");
  const isPermission = interaction.method.includes("permissions/requestApproval");
  const isElicitation = interaction.method.includes("elicitation");
  const isUrlElicitation = isElicitation && params.mode === "url";
  const label = isInput ? "需要你的回答" : isPermission ? "需要你的权限决定" : "需要你的批准";
  const questionText = typeof params.question === "string" ? params.question : typeof params.reason === "string" ? params.reason : typeof params.message === "string" ? params.message : "";
  return <section className="rounded-md border border-amber-300 bg-amber-50/70 p-3" aria-label={label}>
    <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-950"><ShieldCheck className="h-3.5 w-3.5" />{label}</h3>
    {questionText && <p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-5">{questionText}</p>}
    {isInput ? <div className="mt-3 space-y-3">
      {questions.length ? questions.map((question, index) => {
        const id = String(question.id ?? index);
        const options = Array.isArray(question.options) ? question.options.map(record) : [];
        return <fieldset key={id} disabled={disabled}><legend className="mb-1 text-[11px] font-medium">{String(question.question ?? question.header ?? "问题")}</legend><div className="space-y-1">{options.map((option) => <label key={String(option.label)} className="flex items-start gap-2 rounded border border-amber-200 bg-white/70 p-2 text-[11px]"><input type="radio" name={`${interaction.id}:${id}`} value={String(option.label)} checked={answers[id] === option.label} onChange={() => setAnswers((current) => ({ ...current, [id]: String(option.label) }))} /><span>{String(option.label)}{typeof option.description === "string" && <span className="block text-[10px] text-muted-foreground">{option.description}</span>}</span></label>)}<Input aria-label={`回答 ${String(question.header ?? question.question ?? index + 1)}`} value={answers[id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))} placeholder="输入回答" /></div></fieldset>;
      }) : <textarea aria-label="任务问题回答" className="w-full rounded border bg-white p-2 text-[12px]" rows={3} value={text} onChange={(event) => setText(event.target.value)} disabled={disabled} />}
      <Button size="sm" disabled={disabled || (questions.length ? questions.some((question, index) => !answers[String(question.id ?? index)]?.trim()) : !text.trim())} onClick={() => onRespond(questions.length ? { answers: Object.fromEntries(questions.map((question, index) => { const id = String(question.id ?? index); return [id, { answers: [answers[id]] }]; })) } : { text: text.trim() })}>提交回答并继续</Button>
    </div> : <div className="mt-2">
      <details className="mb-2 text-[10px]"><summary className="cursor-pointer text-muted-foreground">查看本次请求详情</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border bg-white p-2">{JSON.stringify(params, null, 2)}</pre></details>
      {typeof params.command === "string" && <pre className="my-2 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-2 text-[11px] text-slate-100">{params.command}</pre>}
      {isPermission && <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border bg-white p-2 text-[10px]">{JSON.stringify(params.permissions ?? params, null, 2)}</pre>}
      {isUrlElicitation && typeof params.url === "string" && /^https?:\/\//.test(params.url) && <button className="my-2 break-all text-left text-[11px] text-primary underline" onClick={() => void invoke("open_external_link", { target: params.url }).catch((reason) => setError(String(reason)))}>打开请求页面：{params.url}</button>}
      {isElicitation && !isUrlElicitation && <><p className="mb-1 text-[11px]">此工具请求表单信息。请根据字段要求填写 JSON：</p><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px]">{JSON.stringify(params.requestedSchema ?? {}, null, 2)}</pre><textarea aria-label="工具请求表单" className="my-2 w-full rounded border bg-white p-2 font-mono text-[11px]" rows={3} value={json} onChange={(event) => setJson(event.target.value)} /></>}
      {error && <p role="alert" className="my-2 text-[11px] text-red-700">{error}</p>}
      <div className="mt-3 flex gap-2"><Button size="sm" disabled={disabled} onClick={() => {
        if (isUrlElicitation) onRespond({ action: "accept", content: null });
        else if (isElicitation) { try { onRespond({ action: "accept", content: JSON.parse(json) }); } catch { setError("请输入有效的 JSON。"); } }
        else if (isPermission) onRespond({ permissions: params.permissions ?? {}, scope: "turn" });
        else onRespond({ decision: "accept" });
      }}>{isUrlElicitation ? "已完成页面操作" : "允许本次"}</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => onRespond(isElicitation ? { action: "decline", content: null } : isPermission ? { permissions: {}, scope: "turn" } : { decision: "decline" })}>拒绝</Button></div>
    </div>}
    <p className="mt-2 break-all text-[9px] text-muted-foreground">对应当前任务的这次请求；过期请求不会用于新的执行。</p>
  </section>;
}
