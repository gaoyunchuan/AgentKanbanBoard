import { useEffect } from "react";
import { ExternalLink, Link2, LoaderCircle, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ThreadItem } from "@/types";
import type { TodoTask } from "@/todo/types";
import { buildTaskAssociationOptions } from "./associationModel";
import { AssociationPicker } from "./AssociationPicker";
import type { ThreadTaskLink } from "./types";

type ThreadTaskAssociationPanelProps = {
  thread: ThreadItem;
  link?: ThreadTaskLink;
  tasks: TodoTask[];
  loading: boolean;
  saving: boolean;
  onEnsureTasks: () => Promise<void>;
  onAssign: (threadId: string, taskId: string) => Promise<void>;
  onUnlink: (threadId: string) => Promise<void>;
  onNavigateTask: (taskId: string) => void;
};

export function ThreadTaskAssociationPanel({
  thread,
  link,
  tasks,
  loading,
  saving,
  onEnsureTasks,
  onAssign,
  onUnlink,
  onNavigateTask
}: ThreadTaskAssociationPanelProps) {
  const linkedTask = link ? tasks.find((task) => task.id === link.taskId) : undefined;

  useEffect(() => {
    if (link && !linkedTask) void onEnsureTasks();
  }, [link, linkedTask, onEnsureTasks]);

  return (
    <section className="min-w-0 rounded-md border bg-card p-2" aria-label="关联 Task">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium">
          <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>关联 Task</span>
        </div>
        {(loading || saving) && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
            <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
            {saving ? "保存中" : "加载中"}
          </span>
        )}
      </div>

      {link && (
        <div className="mb-2 flex min-w-0 items-center gap-1 rounded bg-secondary/55 p-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 min-w-0 flex-1 justify-start px-2"
            aria-label={`打开 Task ${linkedTask?.title ?? link.taskId}`}
            onClick={() => onNavigateTask(link.taskId)}
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{linkedTask?.title ?? link.taskId}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={`解除 Task ${linkedTask?.title ?? link.taskId}`}
            disabled={saving}
            onClick={() => void onUnlink(thread.id)}
          >
            <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}

      <AssociationPicker
        label="选择未完成 Task"
        valueLabel={link ? "更换关联 Task" : undefined}
        getOptions={(query) => buildTaskAssociationOptions(tasks, link?.taskId, query)}
        onOpen={onEnsureTasks}
        onSelect={(taskId) => void onAssign(thread.id, taskId)}
      />
    </section>
  );
}
