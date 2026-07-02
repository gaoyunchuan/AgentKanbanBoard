import { sameThreadList } from "./boardDataEquality";
import type { ThreadItem } from "./types";

export function mergeThreadRefresh(current: ThreadItem[], incoming: ThreadItem[]) {
  const previousById = new Map(current.map((thread) => [thread.id, thread]));
  const merged = incoming.map((thread) => {
    const previous = previousById.get(thread.id);
    if (!previous) return thread;

    const comments =
      thread.comments.length === 0 && previous.comments.length > 0 ? previous.comments : thread.comments;
    const candidate = comments === thread.comments ? thread : { ...thread, comments };

    return sameThreadList([previous], [candidate]) ? previous : candidate;
  });

  return sameThreadList(current, merged) ? current : merged;
}
