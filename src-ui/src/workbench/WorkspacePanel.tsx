import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, File, Folder, LoaderCircle, Play, Square, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { record } from "./events";
import type { WorkEvent, WorkTask } from "./types";

type DirectoryEntry = { fileName: string; isDirectory: boolean; isFile: boolean };
type CommandLog = { id: string; runId?: string | null; command: string; output: string; running: boolean; exitCode?: number; error?: string };
const joinPath = (directory: string, name: string) => `${directory.replace(/[\\/]+$/, "")}/${name}`;

export function commandTimeline(events: WorkEvent[]): CommandLog[] {
  const commands = new Map<string, CommandLog>();
  const decoders = new Map<string, TextDecoder>();
  for (const event of events) {
    const raw = record(event.payload);
    const method = typeof raw.method === "string" ? raw.method : event.kind;
    const params = Object.keys(record(raw.params)).length ? record(raw.params) : raw;
    const id = typeof params.processId === "string" ? params.processId : "";
    if (!id) continue;
    const current = commands.get(id) ?? { id, runId: event.run_id, command: "命令", output: "", running: true };
    if (method === "runtime/command/started") {
      commands.set(id, { ...current, command: Array.isArray(params.command) ? params.command.join(" ") : String(params.command ?? "命令"), running: true });
    } else if (method === "command/exec/outputDelta") {
      let delta = typeof params.delta === "string" ? params.delta : "";
      if (typeof params.deltaBase64 === "string") {
        try {
          const key = `${id}:${String(params.stream)}`;
          const decoder = decoders.get(key) ?? new TextDecoder();
          decoders.set(key, decoder);
          delta = decoder.decode(Uint8Array.from(atob(params.deltaBase64), (character) => character.charCodeAt(0)), { stream: true });
        } catch { delta = "\n[输出解码失败]\n"; }
      }
      commands.set(id, { ...current, output: current.output + delta });
    } else if (method === "runtime/command/completed") {
      const result = record(params.result);
      commands.set(id, { ...current, running: false, exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined, output: current.output || String(result.stdout ?? "") + String(result.stderr ?? ""), error: typeof params.error === "string" ? params.error : undefined });
    }
  }
  return [...commands.values()];
}

export function WorkspacePanel({ task, events, enabled }: { task?: WorkTask; events: WorkEvent[]; enabled: boolean }) {
  const [path, setPath] = useState(task?.config.workspace ?? "");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [file, setFile] = useState<{ path: string; text?: string; image?: string }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [command, setCommand] = useState("");
  const [executing, setExecuting] = useState(false);
  const [lastResult, setLastResult] = useState<string>();
  const commands = useMemo(() => commandTimeline(events), [events]);

  const loadDirectory = async (nextPath = path) => {
    if (!enabled || !task || loading) return;
    setLoading(true); setError(undefined);
    try {
      const result = record(await invoke("workbench_list_directory", { taskId: task.task_id, path: nextPath }));
      setEntries(Array.isArray(result.entries) ? result.entries as DirectoryEntry[] : []);
      setPath(nextPath);
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (task) void loadDirectory(task.config.workspace); }, [task?.task_id, task?.config.workspace, enabled]);

  const openFile = async (filePath: string) => {
    if (!task) return;
    setError(undefined); setLoading(true);
    try {
      const result = record(await invoke("workbench_read_file", { taskId: task.task_id, path: filePath }));
      if (typeof result.dataBase64 !== "string") throw new Error("文件读取没有返回有效数据。");
      if (result.dataBase64.length > 4_000_000) throw new Error("此文件过大，请使用终端按范围查看。");
      const extension = filePath.split(".").pop()?.toLowerCase();
      const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[extension ?? ""];
      if (mime) setFile({ path: filePath, image: `data:${mime};base64,${result.dataBase64}` });
      else {
        const bytes = Uint8Array.from(atob(result.dataBase64), (character) => character.charCodeAt(0));
        if (bytes.includes(0)) throw new Error("这是二进制文件，无法以文本预览。");
        setFile({ path: filePath, text: new TextDecoder().decode(bytes) });
      }
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  };
  const execute = async () => {
    if (!task || !enabled || !command.trim() || executing) return;
    setExecuting(true); setError(undefined); setLastResult(undefined);
    const input = command.trim(); setCommand("");
    try {
      const result = record(await invoke("workbench_execute_command", { taskId: task.task_id, command: input, timeoutMs: 120000 }));
      setLastResult(`退出码 ${String(result.exitCode ?? "未知")}\n${String(result.stdout ?? "")}${String(result.stderr ?? "")}`);
    } catch (reason) { setError(String(reason)); }
    finally { setExecuting(false); }
  };
  return <div className="space-y-4 p-4">
    {!task ? <p className="text-[12px] text-muted-foreground">先配置任务工作目录并委派，即可查看文件与执行命令。</p> : <>
      <section className="rounded-md border"><div className="border-b bg-secondary/30 p-3"><h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-medium"><Folder className="h-3.5 w-3.5" />工作区文件</h3><div className="flex gap-1"><Input aria-label="查看工作目录" value={path} onChange={(event) => setPath(event.target.value)} className="min-w-0 text-[11px]" /><Button size="sm" variant="outline" disabled={!enabled || loading} onClick={() => void loadDirectory()}>读取</Button><Button size="icon" variant="ghost" aria-label="上一级目录" disabled={!enabled || loading || path.replace(/[\\/]+$/, "") === task.config.workspace.replace(/[\\/]+$/, "")} onClick={() => void loadDirectory(path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, ""))}><ArrowUp className="h-3.5 w-3.5" /></Button></div></div>
      <div className="max-h-52 overflow-auto p-2">{entries.map((entry) => <button key={entry.fileName} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-secondary" onClick={() => entry.isDirectory ? void loadDirectory(joinPath(path, entry.fileName)) : void openFile(joinPath(path, entry.fileName))}>{entry.isDirectory ? <Folder className="h-3.5 w-3.5 shrink-0 text-primary" /> : <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}<span className="truncate">{entry.fileName}</span></button>)}{!entries.length && <p className="px-2 py-3 text-[11px] text-muted-foreground">{loading ? "正在读取目录…" : "目录为空，或尚未读取。"}</p>}</div>
      {file && <div className="border-t p-3"><p className="mb-2 break-all text-[10px] text-muted-foreground">{file.path}</p>{file.image ? <img src={file.image} alt={file.path.split(/[\\/]/).pop()} className="max-h-96 max-w-full object-contain" /> : <pre className="max-h-96 overflow-auto whitespace-pre rounded bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100">{file.text}</pre>}</div>}</section>
      <section className="rounded-md border"><div className="border-b bg-secondary/30 p-3"><h3 className="flex items-center gap-1.5 text-[12px] font-medium"><Terminal className="h-3.5 w-3.5" />工作区终端</h3><p className="mt-1 break-all text-[10px] text-muted-foreground">{task.config.workspace} · 使用任务沙箱与权限</p></div><div className="space-y-2 p-3">{commands.map((entry) => <div key={entry.id} className="rounded-md bg-slate-950 p-3 text-slate-100"><div className="flex items-start justify-between gap-2"><code className="break-all text-[11px]">$ {entry.command}</code>{entry.running && <button className="shrink-0 text-[10px] text-slate-300" aria-label="停止终端命令" onClick={() => void invoke("workbench_terminate_command", { taskId: task.task_id, runId: entry.runId ?? null, processId: entry.id }).catch((reason) => setError(String(reason)))}><Square className="h-3 w-3" /></button>}</div><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-5">{entry.output || (entry.running ? "等待输出…" : "无输出")}</pre>{entry.error && <p className="mt-2 text-[10px] text-red-300">{entry.error}</p>}{entry.exitCode !== undefined && <p className="mt-2 text-[10px] text-slate-400">退出码 {entry.exitCode}</p>}</div>)}{lastResult && !commands.length && <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-3 text-[11px] text-slate-100">{lastResult}</pre>}
      <form onSubmit={(event) => { event.preventDefault(); void execute(); }}><textarea aria-label="终端命令" value={command} onChange={(event) => setCommand(event.target.value)} rows={2} placeholder="例如：git status --short 或 npm test" className="w-full rounded border p-2 font-mono text-[11px]" disabled={!enabled || executing} /><div className="mt-2 flex justify-end"><Button size="sm" disabled={!enabled || executing || !command.trim()}>{executing ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}执行命令</Button></div></form></div></section>
    </>}
    {error && <p role="alert" className="break-all rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-800">{error}</p>}
  </div>;
}
