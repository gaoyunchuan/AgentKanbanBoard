import { Fragment } from "react";
import { MarkdownText } from "./markdownLinks";
import type { TodoTask } from "./types";

type SummaryGroup = {
  label: "过程跟踪" | "结果复盘";
  lines: string[];
};

function nonEmptyLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function TodoCollapsedExtensionSummary({
  task,
  onOpenLink
}: {
  task: TodoTask;
  onOpenLink: (url: string) => void;
}) {
  // 已批准固定过程跟踪在前，便于先了解执行脉络再阅读结果复盘。
  const groups: SummaryGroup[] = [
    { label: "过程跟踪", lines: nonEmptyLines(task.processTracking) },
    { label: "结果复盘", lines: nonEmptyLines(task.resultReview) }
  ].filter((group) => group.lines.length > 0) as SummaryGroup[];

  if (groups.length === 0) return null;

  return (
    <div
      role="note"
      aria-label={`${task.title || "未命名任务"}的折叠摘要`}
      className="min-w-0 truncate px-1.5 pb-0.5 text-[10px] leading-4 text-muted-foreground"
    >
      {groups.map((group, groupIndex) => (
        <Fragment key={group.label}>
          {groupIndex > 0 && " ｜ "}
          <span className="font-medium">{group.label}：</span>
          {group.lines.map((line, lineIndex) => (
            <Fragment key={`${lineIndex}-${line}`}>
              {lineIndex > 0 && " · "}
              <MarkdownText
                value={line}
                onOpenLink={onOpenLink}
                className="whitespace-nowrap break-normal"
              />
            </Fragment>
          ))}
        </Fragment>
      ))}
    </div>
  );
}
