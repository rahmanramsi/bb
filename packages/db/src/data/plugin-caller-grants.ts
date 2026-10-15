import { and, desc, eq } from "drizzle-orm";
import type { UserRole } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createPluginCallerGrantId } from "../ids.js";
import { pluginCallerGrants } from "../schema.js";

export interface PluginCallerGrantRow {
  id: string;
  pluginId: string;
  userId: string;
  maxRole: UserRole;
  purpose: string;
  createdAt: number;
  expiresAt: number | null;
}

export function createPluginCallerGrant(
  db: DbConnection,
  args: Omit<PluginCallerGrantRow, "id">,
): PluginCallerGrantRow {
  const row: PluginCallerGrantRow = {
    id: createPluginCallerGrantId(),
    ...args,
  };
  db.insert(pluginCallerGrants).values(row).run();
  return row;
}

export function getPluginCallerGrant(
  db: DbConnection,
  id: string,
): PluginCallerGrantRow | null {
  return (
    db
      .select()
      .from(pluginCallerGrants)
      .where(eq(pluginCallerGrants.id, id))
      .get() ?? null
  );
}

export function listPluginCallerGrantsForUser(
  db: DbConnection,
  userId: string,
): PluginCallerGrantRow[] {
  return db
    .select()
    .from(pluginCallerGrants)
    .where(eq(pluginCallerGrants.userId, userId))
    .orderBy(desc(pluginCallerGrants.createdAt), desc(pluginCallerGrants.id))
    .all();
}

export function deletePluginCallerGrant(
  db: DbConnection,
  args: { id: string } & ({ pluginId: string } | { userId: string }),
): boolean {
  return (
    db
      .delete(pluginCallerGrants)
      .where(
        and(
          eq(pluginCallerGrants.id, args.id),
          "pluginId" in args
            ? eq(pluginCallerGrants.pluginId, args.pluginId)
            : eq(pluginCallerGrants.userId, args.userId),
        ),
      )
      .run().changes > 0
  );
}

export function deletePluginCallerGrantsForPlugin(
  db: DbConnection,
  pluginId: string,
): void {
  db.delete(pluginCallerGrants)
    .where(eq(pluginCallerGrants.pluginId, pluginId))
    .run();
}

export function capPluginCallerGrantsForUserInTransaction(
  db: DbTransaction,
  args: { maxRole: UserRole; userId: string },
): number {
  if (args.maxRole === "admin") return 0;
  return db
    .update(pluginCallerGrants)
    .set({ maxRole: args.maxRole })
    .where(
      and(
        eq(pluginCallerGrants.userId, args.userId),
        eq(pluginCallerGrants.maxRole, "admin"),
      ),
    )
    .run().changes;
}
