import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { BackendThreadTaskLink } from "@/types";
import { useThreadTaskLinks } from "./useThreadTaskLinks";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const backendLink = (threadId: string, taskId: string): BackendThreadTaskLink => ({
  thread_id: threadId,
  task_id: taskId,
  created_at: "2026-07-13T08:00:00Z",
  updated_at: "2026-07-13T08:00:00Z"
});

function associationInvokeMock(initial: BackendThreadTaskLink[]) {
  let links = [...initial];
  return vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === "load_thread_task_links") return Promise.resolve([...links]);
    if (command !== "update_thread_task_link") return Promise.resolve(null);
    const threadId = String(args?.threadId);
    const taskId = args?.taskId == null ? undefined : String(args.taskId);
    links = links.filter((item) => item.thread_id !== threadId);
    if (!taskId) return Promise.resolve(null);
    const next = backendLink(threadId, taskId);
    links.push(next);
    return Promise.resolve(next);
  });
}

test("同一 Thread 串行、不同 Thread 并行", async () => {
  const first = deferred<BackendThreadTaskLink | null>();
  const invokeCommand = vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === "load_thread_task_links") return Promise.resolve([]);
    if (args?.threadId === "a" && args.taskId === "one") return first.promise;
    return Promise.resolve(backendLink(String(args?.threadId), String(args?.taskId)));
  });
  const { result } = renderHook(() => useThreadTaskLinks({ enabled: true, invokeCommand }));

  act(() => {
    void result.current.assign("a", "one", "thread");
    void result.current.assign("a", "two", "thread");
    void result.current.assign("b", "three", "thread");
  });

  expect(invokeCommand).toHaveBeenCalledWith("update_thread_task_link", {
    threadId: "a",
    taskId: "one",
    origin: "thread"
  });
  expect(invokeCommand).toHaveBeenCalledWith("update_thread_task_link", {
    threadId: "b",
    taskId: "three",
    origin: "thread"
  });
  expect(invokeCommand).not.toHaveBeenCalledWith("update_thread_task_link", {
    threadId: "a",
    taskId: "two",
    origin: "thread"
  });

  first.resolve(backendLink("a", "one"));
  await waitFor(() =>
    expect(invokeCommand).toHaveBeenCalledWith("update_thread_task_link", {
      threadId: "a",
      taskId: "two",
      origin: "thread"
    })
  );
});

test("前序保存失败会取消同 Thread 后续操作并重载持久化状态", async () => {
  const invokeCommand = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("写入失败"))
    .mockResolvedValueOnce([backendLink("a", "persisted")]);
  const { result } = renderHook(() => useThreadTaskLinks({ enabled: true, invokeCommand }));

  await act(async () => {
    await result.current.loadLinks();
  });
  act(() => {
    void result.current.assign("a", "one", "thread");
    void result.current.assign("a", "two", "thread");
  });
  await waitFor(() =>
    expect(result.current.linksByThread.get("a")?.taskId).toBe("persisted")
  );
  expect(result.current.notice?.message).toContain("后续操作已取消");
});

test("失败后的强制重载也失败时仍释放 Thread 队列", async () => {
  const invokeCommand = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("写入失败"))
    .mockRejectedValueOnce(new Error("重载失败"))
    .mockResolvedValueOnce(backendLink("a", "three"));
  const { result } = renderHook(() => useThreadTaskLinks({ enabled: true, invokeCommand }));

  await act(async () => {
    await result.current.loadLinks();
  });
  act(() => {
    void result.current.assign("a", "one", "thread");
    void result.current.assign("a", "two", "thread");
  });
  await waitFor(() => expect(result.current.notice?.message).toContain("后续操作已取消"));
  act(() => {
    void result.current.assign("a", "three", "thread");
  });
  await waitFor(() =>
    expect(invokeCommand).toHaveBeenCalledWith("update_thread_task_link", {
      threadId: "a",
      taskId: "three",
      origin: "thread"
    })
  );
});

test("迁移与解除提供五秒撤销，恢复使用 restore 来源", async () => {
  vi.useFakeTimers();
  const invokeCommand = associationInvokeMock([backendLink("a", "old")]);
  const { result } = renderHook(() => useThreadTaskLinks({ enabled: true, invokeCommand }));
  await act(async () => {
    await result.current.loadLinks();
  });
  await act(async () => {
    await result.current.assign("a", "new", "task");
  });
  await act(async () => {
    await result.current.runNoticeAction();
  });
  expect(invokeCommand).toHaveBeenLastCalledWith("update_thread_task_link", {
    threadId: "a",
    taskId: "old",
    origin: "restore"
  });
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current.notice).toBeUndefined();
  vi.useRealTimers();
});

test("普通浏览器模式只更新本地 demo 状态，不调用 Tauri", async () => {
  const invokeCommand = vi.fn();
  const { result } = renderHook(() => useThreadTaskLinks({ enabled: false, invokeCommand }));
  await act(async () => {
    await result.current.loadLinks();
  });
  await act(async () => {
    await result.current.assign("demo-thread", "demo-task", "thread");
  });
  expect(result.current.linksByThread.get("demo-thread")?.taskId).toBe("demo-task");
  expect(invokeCommand).not.toHaveBeenCalled();
});

test("同一 Thread 的新操作会使旧撤销失效", async () => {
  const invokeCommand = associationInvokeMock([backendLink("a", "old")]);
  const { result } = renderHook(() => useThreadTaskLinks({ enabled: true, invokeCommand }));
  await act(async () => {
    await result.current.loadLinks();
  });
  await act(async () => {
    await result.current.assign("a", "new", "task");
  });
  expect(result.current.notice?.actionLabel).toBe("撤销");
  await act(async () => {
    await result.current.unlink("a");
  });
  expect(result.current.notice?.previousTaskId).not.toBe("old");
});

test("Task 快照成功后只清理本地失效关联", async () => {
  const invokeCommand = associationInvokeMock([
    backendLink("keep", "existing"),
    backendLink("remove", "deleted")
  ]);
  const { result } = renderHook(() => useThreadTaskLinks({ enabled: true, invokeCommand }));
  await act(async () => {
    await result.current.loadLinks();
  });
  act(() => result.current.reconcileTaskIds(new Set(["existing"])));
  expect([...result.current.linksByThread.keys()]).toEqual(["keep"]);
  expect(invokeCommand).toHaveBeenCalledTimes(1);
});

test("关联加载失败后暴露错误并允许强制重试", async () => {
  const invokeCommand = vi
    .fn()
    .mockRejectedValueOnce(new Error("读取失败"))
    .mockResolvedValueOnce([backendLink("thread", "task")]);
  const { result } = renderHook(() => useThreadTaskLinks({ enabled: true, invokeCommand }));

  await act(async () => {
    await expect(result.current.loadLinks()).rejects.toThrow("读取失败");
  });
  expect(result.current.loading).toBe(false);
  expect(result.current.loadError).toBe("关联加载失败");

  await act(async () => {
    await result.current.loadLinks(true);
  });
  expect(result.current.loadError).toBeUndefined();
  expect(result.current.linksByThread.get("thread")?.taskId).toBe("task");
});
