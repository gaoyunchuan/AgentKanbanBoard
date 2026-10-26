import type { TodoTask } from "./types";

const editableKeys = [
  "parentId", "position", "title", "status", "pinned", "startDate",
  "expectedEndDate", "actualEndDate", "processTracking", "resultReview"
] as const;

type EditableKey = typeof editableKeys[number];
export type TodoEdit = {
  id: string;
  before?: TodoTask;
  after?: TodoTask;
  fields: EditableKey[];
};

/** Capture user intent, rather than using an old full snapshot as a replacement. */
export function todoEdits(before: TodoTask[], after: TodoTask[]): TodoEdit[] {
  const old = new Map(before.map((task) => [task.id, task]));
  const next = new Map(after.map((task) => [task.id, task]));
  return [...new Set([...old.keys(), ...next.keys()])].flatMap((id) => {
    const previous = old.get(id);
    const current = next.get(id);
    const fields = editableKeys.filter((key) => previous?.[key] !== current?.[key]);
    return !previous || !current || fields.length
      ? [{ id, before: previous, after: current, fields }]
      : [];
  });
}

/**
 * Send only affected rows. Unchanged fields use the latest acknowledged values;
 * changed fields retain their original expected value for backend CAS checks.
 */
export function todoEditPayload(edits: TodoEdit[], acknowledged: TodoTask[]) {
  const current = new Map(acknowledged.map((task) => [task.id, task]));
  const before: TodoTask[] = [];
  const after: TodoTask[] = [];
  for (const edit of edits) {
    if (!edit.before) {
      if (edit.after) after.push(edit.after);
      continue;
    }
    if (!edit.after) {
      before.push(edit.before);
      continue;
    }
    const serverTask = current.get(edit.id);
    if (!serverTask) throw new Error(`任务“${edit.before.title || edit.id}”已被删除，请重新加载后处理本地修改。`);
    const expected = { ...serverTask };
    const desired = { ...serverTask };
    for (const field of edit.fields) {
      Object.assign(expected, { [field]: edit.before[field] });
      Object.assign(desired, { [field]: edit.after[field] });
    }
    before.push(expected);
    after.push(desired);
  }
  return { before, after };
}

/** Merge background changes without overwriting text currently being edited. */
export function mergeTodoSnapshot(base: TodoTask[], local: TodoTask[], remote: TodoTask[]): TodoTask[] {
  const baseline = new Map(base.map((task) => [task.id, task]));
  const localMap = new Map(local.map((task) => [task.id, task]));
  const remoteMap = new Map(remote.map((task) => [task.id, task]));
  const result: TodoTask[] = [];
  for (const serverTask of remote) {
    const previous = baseline.get(serverTask.id);
    const draft = localMap.get(serverTask.id);
    // A known local deletion remains pending; new server-created children survive.
    if (previous && !draft) continue;
    if (!draft || !previous) {
      result.push(draft && !previous ? { ...serverTask, ...draft } : serverTask);
      continue;
    }
    const merged = { ...serverTask };
    for (const field of editableKeys) {
      if (draft[field] !== previous[field]) Object.assign(merged, { [field]: draft[field] });
    }
    result.push(merged);
  }
  for (const draft of local) {
    if (!remoteMap.has(draft.id) && !baseline.has(draft.id)) result.push(draft);
  }
  return result;
}
