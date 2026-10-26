import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ExternalLink, LoaderCircle, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { record } from "./events";
import type { WorkbenchData } from "./types";

export function RuntimeSettings({ enabled, runtime, onChanged }: { enabled: boolean; runtime?: WorkbenchData["runtime"]; onChanged: () => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [executable, setExecutable] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [account, setAccount] = useState<Record<string, unknown>>();
  const [models, setModels] = useState<Record<string, unknown>[]>([]);
  const [login, setLogin] = useState<{ id?: string; url?: string }>();

  const loadAccount = async () => {
    const [accountResponse, modelResponse] = await Promise.all([
      invoke("workbench_rpc", { method: "account/read", params: {} }),
      invoke("workbench_rpc", { method: "model/list", params: {} })
    ]);
    setAccount(record(record(accountResponse).account));
    const list = record(modelResponse).data;
    setModels(Array.isArray(list) ? list.map(record) : []);
  };
  const run = async (operation: () => Promise<unknown>) => {
    if (!enabled || busy) return;
    setBusy(true); setError(undefined);
    try { await operation(); await onChanged(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return <section className="border-b bg-secondary/15">
    <button className="flex w-full items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted-foreground hover:bg-secondary/30" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span className="flex items-center gap-1.5"><Settings2 className="h-3.5 w-3.5" />Codex 连接与账户</span><span className="ml-auto text-[10px]">{!enabled ? "预览模式" : runtime?.connected ? "已连接" : "未连接"}</span><ChevronDown className="h-3.5 w-3.5" /></button>
    {open && <div className="space-y-3 px-3 pb-3">
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-[10px] text-muted-foreground">Codex 可执行文件<Input value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder={runtime?.executable || "留空使用已保存路径或 codex"} className="mt-1" aria-label="Codex 可执行文件" /></label><Button size="sm" disabled={!enabled || busy} onClick={() => void run(async () => { await invoke("workbench_connect", { executable: executable.trim() || null }); await loadAccount(); })}>{busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}连接</Button></div>
      {!enabled && <p className="text-[11px] text-amber-800">浏览器预览不会连接本机进程；请在桌面应用中配置。</p>}
      {(error || runtime?.last_error) && <p role="alert" className="break-all text-[11px] text-red-700">{error || runtime?.last_error}</p>}
      {runtime?.connected && <div className="flex flex-wrap items-center gap-2 text-[11px]"><span className="text-emerald-700">app-server 已连接</span><span>{account?.email ? String(account.email) : account?.type ? String(account.type) : "点击刷新读取账户"}</span>{Boolean(account?.planType) && <span className="text-muted-foreground">{String(account?.planType)}</span>}</div>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!enabled || busy} onClick={() => void run(async () => {
        const result = record(await invoke("workbench_rpc", { method: "account/login/start", params: { type: "chatgpt" } }));
        const url = typeof result.authUrl === "string" && /^https?:\/\//.test(result.authUrl) ? result.authUrl : undefined;
        setLogin({ id: typeof result.loginId === "string" ? result.loginId : undefined, url });
      })}>登录 ChatGPT</Button><Button size="sm" variant="ghost" disabled={!enabled || busy} onClick={() => void run(loadAccount)}>刷新账户与模型</Button>{login?.id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await invoke("workbench_rpc", { method: "account/login/cancel", params: { loginId: login.id } }); setLogin(undefined); })}>取消登录</Button>}</div>
      {login?.url && <button className="flex items-center gap-1 text-[11px] text-primary underline" onClick={() => void run(() => invoke("open_external_link", { target: login.url }))}><ExternalLink className="h-3 w-3" />打开安全登录页面，完成后刷新账户</button>}
      {models.length > 0 && <div><p className="mb-1 text-[10px] text-muted-foreground">当前账户可用模型</p><div className="flex flex-wrap gap-1.5">{models.map((model, index) => <span key={String(model.id ?? index)} className="rounded border bg-card px-2 py-1 text-[10px]" title={String(model.description ?? "")}>{String(model.model ?? model.id ?? model.displayName)}</span>)}</div></div>}
    </div>}
  </section>;
}
