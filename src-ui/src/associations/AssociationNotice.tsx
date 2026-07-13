import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssociationNoticeState } from "./types";

type AssociationNoticeProps = {
  notice?: AssociationNoticeState;
  onAction: () => void | Promise<void>;
  onDismiss: () => void;
};

export function AssociationNotice({
  notice,
  onAction,
  onDismiss
}: AssociationNoticeProps) {
  if (!notice) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 flex w-[min(420px,calc(100%-24px))] -translate-x-1/2 items-center gap-2 rounded-md border bg-card px-3 py-2 text-[12px] shadow-lg"
    >
      <span className="min-w-0 flex-1">{notice.message}</span>
      {notice.actionLabel && (
        <Button type="button" variant="ghost" size="sm" onClick={() => void onAction()}>
          {notice.actionLabel}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        aria-label="关闭提示"
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
