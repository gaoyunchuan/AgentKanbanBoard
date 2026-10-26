import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TodoTask } from "@/todo/types";
import type { WorkbenchApi } from "./api";
import type { TaskExecutionDetail, TaskInteraction, WorkTask } from "./types";
import { TaskExecutionPanel } from "./TaskExecutionPanel";

const task: TodoTask = { id: "task-a", title: "修复列表刷新", position: 0, status: "in_progress", pinned: false, processTracking: "", resultReview: "" };
const work = (patch: Partial<WorkTask> = {}): WorkTask => ({
  task_id: task.id, title: task.title, status: "running", execution_status: "running", revision: 3,
  current_run_id: "run-new", thread_id: "thread-a", continuation_count: 0, updated_at: "2026-10-26T00:00:00Z",
  config: { agent_id: "codex", delegated_by: "user", workspace: "/repo", prompt: "修复列表刷新", acceptance: "回归检查通过", review_policy: "human", blocked_by: [] }, ...patch
});
const detail = (managed: WorkTask, patch: Partial<TaskExecutionDetail> = {}): TaskExecutionDetail => ({ task: managed, runs: [], events: [], interactions: [], ...patch });
const apiFor = (value: TaskExecutionDetail): WorkbenchApi => ({
  load: vi.fn().mockResolvedValue({ tasks: [value.task] }), detail: vi.fn().mockResolvedValue(value),
  delegate: vi.fn().mockResolvedValue(undefined), action: vi.fn().mockResolvedValue(undefined),
  message: vi.fn().mockResolvedValue(undefined), respond: vi.fn().mockResolvedValue(undefined)
});
const interaction = (patch: Partial<TaskInteraction> = {}): TaskInteraction => ({
  id: "approval-new", task_id: task.id, run_id: "run-new", request_id: 7,
  kind: "approval", method: "item/commandExecution/requestApproval", payload: { command: "npm test" },
  status: "pending", created_at: "2026-10-26T00:00:01Z", ...patch
});

afterEach(cleanup);

describe("task execution workbench", () => {
  test("a successful completed turn does not expose task acceptance without a result submission", async () => {
    const managed = work();
    const api = apiFor(detail(managed, { events: [{ id: 1, task_id: task.id, run_id: "run-new", kind: "turn/completed", payload: { turn: { status: "completed" } }, created_at: "now" }] }));
    render(<TaskExecutionPanel task={task} tasks={[task]} work={managed} enabled api={api} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(api.detail).toHaveBeenCalledWith(task.id));
    expect(screen.queryByRole("button", { name: "验收通过" })).not.toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(api.action).not.toHaveBeenCalled();
  });

  test("approves only a current task/run request and hides stale approvals", async () => {
    const managed = work({ status: "waiting" });
    const api = apiFor(detail(managed, { interactions: [interaction({ id: "old", run_id: "run-old", payload: { command: "old command" } }), interaction()] }));
    render(<TaskExecutionPanel task={task} tasks={[task]} work={managed} enabled api={api} onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "允许本次" }));
    await waitFor(() => expect(api.respond).toHaveBeenCalledWith(task.id, "approval-new", "run-new", { decision: "accept" }));
    expect(screen.queryByText("old command")).not.toBeInTheDocument();
  });

  test("requires explicit feedback for rework and pins acceptance to the displayed task revision", async () => {
    const managed = work({ status: "review", current_run_id: null, result_summary: "修复已提交，测试通过" });
    const api = apiFor(detail(managed));
    render(<TaskExecutionPanel task={task} tasks={[task]} work={managed} enabled api={api} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "反馈并返工" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "返工反馈" }), { target: { value: "补充并发刷新回归" } });
    fireEvent.click(screen.getByRole("button", { name: "反馈并返工" }));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith(task.id, "rework", 3, "补充并发刷新回归"));
  });

  test("does not accept a submission while its producing run is still active", () => {
    const managed = work({ status: "review" });
    render(<TaskExecutionPanel task={task} tasks={[task]} work={managed} enabled api={apiFor(detail(managed))} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "验收通过" })).toBeDisabled();
  });

  test("paused tasks do not restart through an ordinary chat message", () => {
    const managed = work({ status: "paused", current_run_id: null });
    const api = apiFor(detail(managed));
    render(<TaskExecutionPanel task={task} tasks={[task]} work={managed} enabled api={api} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "发送给 Codex" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复执行" })).toBeEnabled();
    expect(api.message).not.toHaveBeenCalled();
  });

  test("browser preview never launches a real execution", () => {
    const api = apiFor(detail(work()));
    render(<TaskExecutionPanel task={task} tasks={[task]} enabled={false} api={api} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "委派并启动" })).toBeDisabled();
    expect(screen.getByText(/浏览器预览：/)).toBeInTheDocument();
    expect(api.delegate).not.toHaveBeenCalled();
    expect(api.detail).not.toHaveBeenCalled();
  });

  test("an image-only message sends a valid caption and the attached image to its current run", async () => {
    const managed = work();
    const api = apiFor(detail(managed));
    render(<TaskExecutionPanel task={task} tasks={[task]} work={managed} enabled api={api} onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加上下文" }));
    fireEvent.change(screen.getByLabelText("本地图片路径（每行一个）"), { target: { value: "/repo/screenshot.png" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.message).toHaveBeenCalledWith(task.id, "请查看附图。", "run-new", [{ type: "localImage", path: "/repo/screenshot.png" }]));
  });

  test("structured questions return an answers map bound to the exact interaction", async () => {
    const managed = work({ status: "waiting" });
    const api = apiFor(detail(managed, { interactions: [interaction({ id: "question", kind: "input", method: "item/tool/requestUserInput", payload: { questions: [{ id: "scope", header: "范围", question: "选择范围", options: [{ label: "当前项目", description: "只修改项目" }] }] } })] }));
    render(<TaskExecutionPanel task={task} tasks={[task]} work={managed} enabled api={api} onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /当前项目/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交回答并继续" }));
    await waitFor(() => expect(api.respond).toHaveBeenCalledWith(task.id, "question", "run-new", { answers: { scope: { answers: ["当前项目"] } } }));
  });

  test("business questions remain answerable after their producing turn yields", async () => {
    const managed = work({ status: "waiting", current_run_id: null, wait_reason: "question" });
    const api = apiFor(detail(managed, { interactions: [interaction({ id: "question", kind: "question", method: "task/question", payload: { question: "目标浏览器是哪个？" } })] }));
    render(<TaskExecutionPanel task={task} tasks={[task]} work={managed} enabled api={api} onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "任务问题回答" }), { target: { value: "Chrome" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答并继续" }));
    await waitFor(() => expect(api.respond).toHaveBeenCalledWith(task.id, "question", "run-new", { text: "Chrome" }));
  });

  test("browser automation is an explicit first-delegation option and is frozen for an existing thread", async () => {
    const api = apiFor(detail(work()));
    const { rerender } = render(<TaskExecutionPanel task={task} tasks={[task]} defaultWorkspace="/repo" enabled api={api} onClose={vi.fn()} onChanged={vi.fn()} />);
    const browser = screen.getByRole("checkbox", { name: /启用浏览器操作/ });
    expect(browser).not.toBeChecked();
    fireEvent.click(browser);
    fireEvent.change(screen.getByRole("textbox", { name: "验收要求" }), { target: { value: "浏览器验证通过" } });
    fireEvent.click(screen.getByRole("button", { name: "委派并启动" }));
    await waitFor(() => expect(api.delegate).toHaveBeenCalledWith(task.id, expect.objectContaining({ browser_enabled: true, review_policy: "human" })));
    const paused = work({ status: "paused", current_run_id: null });
    rerender(<TaskExecutionPanel task={task} tasks={[task]} work={paused} enabled api={apiFor(detail(paused))} onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "委派设置" }));
    expect(screen.getByRole("checkbox", { name: /启用浏览器操作/ })).toBeDisabled();
  });
});
