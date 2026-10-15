import path from "node:path";
import {
  canScopeViewProject,
  getEnvironment,
  getProject,
  getThread,
  listInaccessibleProjectPathsOnHost,
  UNRESTRICTED_PROJECT_ACCESS,
  type DbConnection,
  type ProjectAccessRow,
  type ProjectAccessScope,
} from "@bb/db";
import { ApiError } from "../../errors.js";
import type { RealtimeProjectAccessResolver } from "../../ws/hub.js";
import type { RequestPrincipal } from "../user-auth.js";

export function projectAccessScopeFor(
  principal: RequestPrincipal,
): ProjectAccessScope {
  if (principal.kind !== "user" || principal.role === "admin") {
    return UNRESTRICTED_PROJECT_ACCESS;
  }
  return { kind: "user", userId: principal.userId };
}

export function canViewProject(
  db: DbConnection,
  project: ProjectAccessRow,
  principal: RequestPrincipal,
): boolean {
  return canScopeViewProject(db, project, projectAccessScopeFor(principal));
}

export function canManageProject(
  project: Pick<ProjectAccessRow, "ownerUserId">,
  principal: RequestPrincipal,
): boolean {
  if (principal.kind !== "user" || principal.role === "admin") {
    return true;
  }
  return project.ownerUserId === principal.userId;
}

function throwProjectNotFound(): never {
  throw new ApiError(404, "project_not_found", "Project not found");
}

export function canViewProjectId(
  db: DbConnection,
  projectId: string,
  principal: RequestPrincipal,
): boolean {
  if (projectAccessScopeFor(principal).kind === "unrestricted") {
    return true;
  }
  const project = getProject(db, projectId);
  return project === null || canViewProject(db, project, principal);
}

export function assertCanViewProjectId(
  db: DbConnection,
  projectId: string,
  principal: RequestPrincipal,
): void {
  if (!canViewProjectId(db, projectId, principal)) {
    throwProjectNotFound();
  }
}

export function assertCanManageProject(
  db: DbConnection,
  project: ProjectAccessRow,
  principal: RequestPrincipal,
): void {
  if (!canViewProject(db, project, principal)) {
    throwProjectNotFound();
  }
  if (!canManageProject(project, principal)) {
    throw new ApiError(
      403,
      "project_manage_forbidden",
      "Only the project owner or an admin can change this project's access",
    );
  }
}

export function canViewThreadId(
  db: DbConnection,
  threadId: string,
  principal: RequestPrincipal,
): boolean {
  if (projectAccessScopeFor(principal).kind === "unrestricted") {
    return true;
  }
  const thread = getThread(db, threadId);
  if (thread === null) {
    return true;
  }
  const project = getProject(db, thread.projectId);
  return project === null || canViewProject(db, project, principal);
}

export function assertCanViewThreadId(
  db: DbConnection,
  threadId: string,
  principal: RequestPrincipal,
): void {
  if (!canViewThreadId(db, threadId, principal)) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
}

export function assertCanViewEnvironmentId(
  db: DbConnection,
  environmentId: string,
  principal: RequestPrincipal,
): void {
  if (projectAccessScopeFor(principal).kind === "unrestricted") {
    return;
  }
  const environment = getEnvironment(db, environmentId);
  if (environment === null) {
    return;
  }
  const project = getProject(db, environment.projectId);
  if (project !== null && !canViewProject(db, project, principal)) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
}

function normalizedHostPath(value: string): string {
  const windows = path.win32.isAbsolute(value) && !path.posix.isAbsolute(value);
  const normalized = windows
    ? path.win32.normalize(value).replaceAll("\\", "/").toLowerCase()
    : path.posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

function isHostPathWithin(target: string, root: string): boolean {
  const normalizedTarget = normalizedHostPath(target);
  const normalizedRoot = normalizedHostPath(root);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(
      normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`,
    )
  );
}

export function resolveHostTargetPath(
  rootPath: string | undefined,
  targetPath: string,
): string {
  if (
    rootPath === undefined ||
    path.posix.isAbsolute(targetPath) ||
    path.win32.isAbsolute(targetPath)
  ) {
    return targetPath;
  }
  return path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)
    ? path.win32.join(rootPath, targetPath)
    : path.posix.join(rootPath, targetPath);
}

function hiddenHostRootsFor(
  db: DbConnection,
  principal: RequestPrincipal,
  hostId: string,
): string[] {
  const scope = projectAccessScopeFor(principal);
  return scope.kind === "unrestricted"
    ? []
    : listInaccessibleProjectPathsOnHost(db, { hostId, scope });
}

export function assertHostPathsVisible(
  db: DbConnection,
  principal: RequestPrincipal,
  hostId: string,
  targetPaths: readonly string[],
): void {
  const hiddenRoots = hiddenHostRootsFor(db, principal, hostId);
  for (const target of targetPaths) {
    if (hiddenRoots.some((root) => isHostPathWithin(target, root))) {
      throw new ApiError(404, "ENOENT", "No such file or directory", false);
    }
  }
}

export function filterVisibleHostPaths<T>(
  db: DbConnection,
  principal: RequestPrincipal,
  hostId: string,
  entries: readonly T[],
  pathFor: (entry: T) => string,
): T[] {
  const hiddenRoots = hiddenHostRootsFor(db, principal, hostId);
  if (hiddenRoots.length === 0) {
    return [...entries];
  }
  return entries.filter(
    (entry) =>
      !hiddenRoots.some((root) => isHostPathWithin(pathFor(entry), root)),
  );
}

export function createRealtimeProjectAccessResolver(
  db: DbConnection,
): RealtimeProjectAccessResolver {
  return {
    projectIdFor(target) {
      switch (target.kind) {
        case "project":
          return target.id;
        case "thread":
          return getThread(db, target.id)?.projectId ?? null;
        case "environment":
          return getEnvironment(db, target.id)?.projectId ?? null;
      }
    },
    canView(projectId, scope) {
      const project = getProject(db, projectId);
      return project === null || canScopeViewProject(db, project, scope);
    },
  };
}
