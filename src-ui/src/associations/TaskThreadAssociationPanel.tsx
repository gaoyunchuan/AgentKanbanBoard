import { ExternalLink, Link2, LoaderCircle, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BoardStatus, ThreadItem } from "@/types";
import type { TodoTask } from "@/todo/types";
import { buildThreadAssociationOptions } from "./associationModel";
import { AssociationPicker } from "./AssociationPicker";
import type { ThreadTaskLink } from "./types";

const statusLabels: Record<BoardStatus, string> = {
  untriaged: "未分类",
  running: "运行中",
  review_pending: "待审核",
  reviewed: "已审核",
  suspended: "挂起",
  archived: "已归档"
};

type TaskThreadAssociationPanelProps = {
  task: TodoTask;
  threads: ThreadItem[];
  projectNames: Map<string, string>;
  linksByThread: Map<string, ThreadTaskLink>;
  savingThreadIds: Set<string>;
  onAssign: (threadId: string, taskId: string) => Promise<void>;
  onUnlink: (threadId: string) => Promise<void>;
  onOpenThread: (thread: ThreadItem) => void;
};

export function TaskThreadAssociationPanel({
  task,
  threads,
  projectNames,
  linksByThread,
  savingThreadIds,
  onAssign,
  onUnlink,
  onOpenThread
}: TaskThreadAssociationPanelProps) {
  const linkedThreads = threads.filter(
    (thread) => linksByThread.get(thread.id)?.taskId === task.id
  );

  return (
    <section className="min-w-0 rounded-md border bg-card p-2" aria-label="关联 Thread">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium">
          <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>关联 Thread</span>
          {linkedThreads.length > 0 && (
            <span className="text-[10px] font-normal text-muted-foreground">
              {linkedThreads.length}
            </span>
          )}
        </div>
      </div>

      {linkedThreads.length > 0 && (
        <div className="mb-2 space-y-1">
          {linkedThreads.map((thread) => {
            const saving = savingThreadIds.has(thread.id);
            return (
              <div
                key={thread.id}
                className="flex min-w-0 items-center gap-1 rounded bg-secondary/55 p-1"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 min-w-0 flex-1 justify-start px-2"
                  aria-label={`在 Codex 打开 Thread ${thread.title}`}
                  onClick={() => onOpenThread(thread)}
                >
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{thread.title}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {statusLabels[thread.boardStatus]}
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label={`解除 Thread ${thread.title}`}
                  disabled={saving}
                  onClick={() => void onUnlink(thread.id)}
                >
                  {saving ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <AssociationPicker
        label="关联 Thread"
        getOptions={(query) =>
          buildThreadAssociationOptions(
            threads,
            linksByThread,
            task.id,
            projectNames,
            query
          )
        }
        onSelect={(threadId) => void onAssign(threadId, task.id)}
      />
    </section>
  );
}
