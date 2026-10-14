import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ProjectVisibility } from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  authUsers,
  environments,
  projectMembers,
  projects,
  projectSources,
} from "../schema.js";

export type ProjectAccessScope =
  | { kind: "unrestricted" }
  | { kind: "user"; userId: string };

export const UNRESTRICTED_PROJECT_ACCESS: ProjectAccessScope = {
  kind: "unrestricted",
};

export interface ProjectAccessRow {
  id: string;
  kind: "standard" | "personal";
  ownerUserId: string | null;
  visibility: ProjectVisibility;
}

export interface ProjectMemberRow {
  addedAt: number;
  addedByUserId: string | null;
  email: string;
  name: string;
  userId: string;
}

export interface ProjectMembershipArgs {
  projectId: string;
  userId: string;
}

export interface AddProjectMemberArgs extends ProjectMembershipArgs {
  addedByUserId: string | null;
}

export function projectVisibleToScopeCondition(
  scope: ProjectAccessScope,
): SQL | undefined {
  if (scope.kind === "unrestricted") {
    return undefined;
  }
  return or(
    eq(projects.visibility, "public"),
    eq(projects.ownerUserId, scope.userId),
    sql`exists (select 1 from ${projectMembers} where ${projectMembers.projectId} = ${projects.id} and ${projectMembers.userId} = ${scope.userId})`,
  );
}

export function accessibleProjectIdCondition(
  projectIdColumn: AnySQLiteColumn | SQL,
  scope: ProjectAccessScope,
): SQL | undefined {
  if (scope.kind === "unrestricted") {
    return undefined;
  }
  return sql`${projectIdColumn} in (select "access_project"."id" from "projects" as "access_project" where "access_project"."visibility" = 'public' or "access_project"."owner_user_id" = ${scope.userId} union select "access_member"."project_id" from "project_members" as "access_member" where "access_member"."user_id" = ${scope.userId})`;
}

export function isProjectMember(
  db: DbQueryConnection,
  args: ProjectMembershipArgs,
): boolean {
  return (
    db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, args.projectId),
          eq(projectMembers.userId, args.userId),
        ),
      )
      .get() !== undefined
  );
}

export function canScopeViewProject(
  db: DbQueryConnection,
  project: ProjectAccessRow,
  scope: ProjectAccessScope,
): boolean {
  if (scope.kind === "unrestricted" || project.visibility === "public") {
    return true;
  }
  if (project.ownerUserId === scope.userId) {
    return true;
  }
  return isProjectMember(db, { projectId: project.id, userId: scope.userId });
}

export function listProjectMembers(
  db: DbQueryConnection,
  projectId: string,
): ProjectMemberRow[] {
  return db
    .select({
      userId: projectMembers.userId,
      name: authUsers.name,
      email: authUsers.email,
      addedAt: projectMembers.createdAt,
      addedByUserId: projectMembers.addedByUserId,
    })
    .from(projectMembers)
    .innerJoin(authUsers, eq(authUsers.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.createdAt), asc(projectMembers.userId))
    .all();
}

export function listProjectMemberUserIds(
  db: DbQueryConnection,
  projectId: string,
): string[] {
  return db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
    .all()
    .map((row) => row.userId);
}

export function addProjectMember(
  db: DbConnection,
  args: AddProjectMemberArgs,
): boolean {
  const inserted = db
    .insert(projectMembers)
    .values({
      projectId: args.projectId,
      userId: args.userId,
      addedByUserId: args.addedByUserId,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .returning({ userId: projectMembers.userId })
    .get();
  return inserted !== undefined;
}

export function removeProjectMember(
  db: DbConnection,
  args: ProjectMembershipArgs,
): boolean {
  const deleted = db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, args.projectId),
        eq(projectMembers.userId, args.userId),
      ),
    )
    .returning({ userId: projectMembers.userId })
    .get();
  return deleted !== undefined;
}

export function listProjectIdsOwnedByUser(
  db: DbQueryConnection,
  userId: string,
): string[] {
  return db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.ownerUserId, userId))
    .all()
    .map((row) => row.id);
}

export function listProjectIdsWithMember(
  db: DbQueryConnection,
  userId: string,
): string[] {
  return db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId))
    .all()
    .map((row) => row.projectId);
}

export function listInaccessibleProjectPathsOnHost(
  db: DbQueryConnection,
  args: { hostId: string; scope: ProjectAccessScope },
): string[] {
  const accessible = accessibleProjectIdCondition(projects.id, args.scope);
  if (accessible === undefined) {
    return [];
  }
  const hidden = sql`not (${accessible})`;
  const sourcePaths = db
    .select({ path: projectSources.path })
    .from(projectSources)
    .innerJoin(projects, eq(projects.id, projectSources.projectId))
    .where(and(eq(projectSources.hostId, args.hostId), hidden))
    .all();
  const environmentPaths = db
    .select({ path: environments.path })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(environments.hostId, args.hostId), hidden))
    .all();
  return [...sourcePaths, ...environmentPaths].flatMap((row) =>
    row.path === null ? [] : [row.path],
  );
}

export interface AuthUserIdentityRow {
  email: string;
  id: string;
  name: string;
}

export function getAuthUserIdentity(
  db: DbQueryConnection,
  userId: string,
): AuthUserIdentityRow | null {
  return (
    db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .get() ?? null
  );
}
