import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BackendThreadTaskLink } from "@/types";
import type {
  AssociationIntent,
  AssociationNoticeState,
  ThreadTaskLink
} from "./types";
import { mapBackendThreadTaskLink } from "./types";

type InvokeCommand = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

type UseThreadTaskLinksOptions = {
  enabled: boolean;
  invokeCommand?: InvokeCommand;
};

type QueuedOperation = {
  intent: AssociationIntent;
  previousLink?: ThreadTaskLink;
  resolve: () => void;
};

const defaultInvoke: InvokeCommand = (command, args) => invoke(command, args);

const localRecord = (threadId: string, taskId: string): ThreadTaskLink => {
  const now = new Date().toISOString();
  return { threadId, taskId, createdAt: now, updatedAt: now };
};

export function useThreadTaskLinks({
  enabled,
  invokeCommand = defaultInvoke
}: UseThreadTaskLinksOptions) {
  const [linksByThread, setLinksByThread] = useState<Map<string, ThreadTaskLink>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [savingThreadIds, setSavingThreadIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<AssociationNoticeState>();
  const linksRef = useRef(linksByThread);
  const noticeRef = useRef(notice);
  const loadedRef = useRef(false);
  const loadPromiseRef = useRef<Promise<void>>();
  const queuesRef = useRef(new Map<string, QueuedOperation[]>());
  const runningRef = useRef(new Set<string>());
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const replaceLinks = useCallback((next: Map<string, ThreadTaskLink>) => {
    linksRef.current = next;
    setLinksByThread(next);
  }, []);

  const updateLinks = useCallback(
    (updater: (current: Map<string, ThreadTaskLink>) => Map<string, ThreadTaskLink>) => {
      replaceLinks(updater(linksRef.current));
    },
    [replaceLinks]
  );

  const clearNoticeTimer = useCallback(() => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = undefined;
  }, []);

  const dismissNotice = useCallback(() => {
    clearNoticeTimer();
    noticeRef.current = undefined;
    setNotice(undefined);
  }, [clearNoticeTimer]);

  const showNotice = useCallback(
    (next: AssociationNoticeState, expires = false) => {
      clearNoticeTimer();
      noticeRef.current = next;
      setNotice(next);
      if (expires) {
        noticeTimerRef.current = setTimeout(() => {
          noticeRef.current = undefined;
          setNotice(undefined);
          noticeTimerRef.current = undefined;
        }, 5000);
      }
    },
    [clearNoticeTimer]
  );

  useEffect(() => () => clearNoticeTimer(), [clearNoticeTimer]);

  const loadLinks = useCallback(
    async (force = false) => {
      if (!enabled) {
        loadedRef.current = true;
        return;
      }
      if (loadedRef.current && !force) return;
      if (loadPromiseRef.current) return loadPromiseRef.current;

      setLoading(true);
      setLoadError(undefined);
      const load = (async () => {
        const records = (await invokeCommand("load_thread_task_links")) as BackendThreadTaskLink[];
        replaceLinks(
          new Map(records.map((record) => {
            const link = mapBackendThreadTaskLink(record);
            return [link.threadId, link];
          }))
        );
        loadedRef.current = true;
      })()
        .catch((error) => {
          setLoadError("关联加载失败");
          throw error;
        })
        .finally(() => {
          loadPromiseRef.current = undefined;
          setLoading(false);
        });
      loadPromiseRef.current = load;
      return load;
    },
    [enabled, invokeCommand, replaceLinks]
  );

  const markSavingLater = useCallback((threadId: string) => {
    return setTimeout(() => {
      setSavingThreadIds((current) => new Set(current).add(threadId));
    }, 300);
  }, []);

  const clearSaving = useCallback((threadId: string, timer: ReturnType<typeof setTimeout>) => {
    clearTimeout(timer);
    setSavingThreadIds((current) => {
      if (!current.has(threadId)) return current;
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
  }, []);

  const persist = useCallback(
    async (intent: AssociationIntent): Promise<ThreadTaskLink | undefined> => {
      if (!enabled) {
        return intent.kind === "assign" && intent.taskId
          ? localRecord(intent.threadId, intent.taskId)
          : undefined;
      }
      const record = (await invokeCommand("update_thread_task_link", {
        threadId: intent.threadId,
        taskId: intent.taskId ?? null,
        origin: intent.origin
      })) as BackendThreadTaskLink | null;
      return record ? mapBackendThreadTaskLink(record) : undefined;
    },
    [enabled, invokeCommand]
  );

  const processQueue = useCallback(
    async (threadId: string) => {
      if (runningRef.current.has(threadId)) return;
      runningRef.current.add(threadId);
      const queue = queuesRef.current.get(threadId);
      if (!queue) {
        runningRef.current.delete(threadId);
        return;
      }

      while (queue.length > 0) {
        const operation = queue[0];
        const savingTimer = markSavingLater(threadId);
        try {
          const persisted = await persist(operation.intent);
          clearSaving(threadId, savingTimer);
          queue.shift();
          operation.resolve();

          if (queue.length === 0) {
            updateLinks((current) => {
              const next = new Map(current);
              if (persisted) next.set(threadId, persisted);
              else next.delete(threadId);
              return next;
            });
            if (operation.intent.origin !== "restore") {
              showNotice(
                {
                  message: operation.intent.kind === "unlink" ? "已解除关联" : "关联已保存",
                  actionLabel: "撤销",
                  threadId,
                  previousTaskId: operation.previousLink?.taskId
                },
                true
              );
            }
          }
        } catch {
          clearSaving(threadId, savingTimer);
          const hasFollowing = queue.length > 1;
          const cancelled = queue.splice(0);
          cancelled.forEach((item) => item.resolve());
          if (hasFollowing) {
            try {
              await loadLinks(true);
            } catch {
              // 重载失败时仍需释放该 Thread 队列，后续操作可以由用户重新发起。
            } finally {
              showNotice({ message: "后续操作已取消，请重新操作" });
            }
          } else {
            updateLinks((current) => {
              const next = new Map(current);
              if (operation.previousLink) next.set(threadId, operation.previousLink);
              else next.delete(threadId);
              return next;
            });
            showNotice({
              message: "关联保存失败，已恢复原状态",
              actionLabel: "重试",
              threadId,
              failedIntent: operation.intent
            });
          }
          break;
        }
      }

      queuesRef.current.delete(threadId);
      runningRef.current.delete(threadId);
    },
    [clearSaving, loadLinks, markSavingLater, persist, showNotice, updateLinks]
  );

  const enqueue = useCallback(
    (intent: AssociationIntent) => {
      const previousLink = linksRef.current.get(intent.threadId);
      if (
        noticeRef.current?.threadId === intent.threadId &&
        noticeRef.current.actionLabel === "撤销"
      ) {
        dismissNotice();
      }

      updateLinks((current) => {
        const next = new Map(current);
        if (intent.kind === "assign" && intent.taskId) {
          next.set(intent.threadId, localRecord(intent.threadId, intent.taskId));
        } else {
          next.delete(intent.threadId);
        }
        return next;
      });

      return new Promise<void>((resolve) => {
        const queue = queuesRef.current.get(intent.threadId) ?? [];
        queue.push({ intent, previousLink, resolve });
        queuesRef.current.set(intent.threadId, queue);
        void processQueue(intent.threadId);
      });
    },
    [dismissNotice, processQueue, updateLinks]
  );

  const assign = useCallback(
    (threadId: string, taskId: string, origin: "thread" | "task") =>
      enqueue({ kind: "assign", threadId, taskId, origin }),
    [enqueue]
  );

  const unlink = useCallback(
    (threadId: string) =>
      enqueue({ kind: "unlink", threadId, origin: "thread" }),
    [enqueue]
  );

  const runNoticeAction = useCallback(async () => {
    const current = noticeRef.current;
    if (!current?.actionLabel) return;
    dismissNotice();
    if (current.actionLabel === "撤销" && current.threadId) {
      const intent: AssociationIntent = current.previousTaskId
        ? {
            kind: "assign",
            threadId: current.threadId,
            taskId: current.previousTaskId,
            origin: "restore"
          }
        : { kind: "unlink", threadId: current.threadId, origin: "restore" };
      await enqueue(intent);
      return;
    }
    if (current.actionLabel === "重试" && current.failedIntent) {
      await enqueue(current.failedIntent);
    }
  }, [dismissNotice, enqueue]);

  const reconcileTaskIds = useCallback(
    (validIds: Set<string>) => {
      updateLinks((current) =>
        new Map([...current].filter(([, link]) => validIds.has(link.taskId)))
      );
    },
    [updateLinks]
  );

  return {
    linksByThread,
    loading,
    loadError,
    savingThreadIds,
    notice,
    loadLinks,
    assign,
    unlink,
    runNoticeAction,
    dismissNotice,
    reconcileTaskIds
  };
}
