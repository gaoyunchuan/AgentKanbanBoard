import type { Project, ThreadComment, ThreadItem } from "./types";

export function sameThreadList(left: ThreadItem[], right: ThreadItem[]) {
  if (left.length !== right.length) return false;
  return left.every((thread, index) => sameThread(thread, right[index]));
}

export function sameProjectList(left: Project[], right: Project[]) {
  if (left.length !== right.length) return false;
  return left.every((project, index) => sameProject(project, right[index]));
}

function sameThread(left: ThreadItem, right: ThreadItem) {
  return (
    left.id === right.id &&
    left.codexSessionId === right.codexSessionId &&
    left.title === right.title &&
    left.preview === right.preview &&
    left.projectId === right.projectId &&
    left.cwd === right.cwd &&
    left.branch === right.branch &&
    left.boardStatus === right.boardStatus &&
    left.codexStatus === right.codexStatus &&
    left.subStatus === right.subStatus &&
    left.taskType === right.taskType &&
    left.module === right.module &&
    left.sprint === right.sprint &&
    left.updatedAt === right.updatedAt &&
    left.createdAt === right.createdAt &&
    left.lastSeenRunningAt === right.lastSeenRunningAt &&
    left.suspendedUntil === right.suspendedUntil &&
    left.archivedAt === right.archivedAt &&
    left.notes === right.notes &&
    sameCommentList(left.comments, right.comments)
  );
}

function sameProject(left: Project, right: Project) {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.path === right.path &&
    left.originUrl === right.originUrl &&
    left.active === right.active &&
    sameStringList(left.aliases, right.aliases)
  );
}

function sameCommentList(left: ThreadComment[], right: ThreadComment[]) {
  if (left.length !== right.length) return false;
  return left.every((comment, index) => sameComment(comment, right[index]));
}

function sameComment(left: ThreadComment, right: ThreadComment) {
  return (
    left.id === right.id &&
    left.threadId === right.threadId &&
    left.author === right.author &&
    left.body === right.body &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.editedAt === right.editedAt
  );
}

function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
