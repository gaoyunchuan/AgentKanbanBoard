import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { record } from "./events";
import type { TaskInteraction } from "./types";
export function InteractionCard({ interaction, disabled, onRespond }: { interaction: TaskInteraction; disabled: boolean; onRespond: (response: unknown) => void }) {
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
