import { and, asc, eq, sql } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import {
  authUsers,
  pluginKv,
  pluginSettings,
  pluginUserKv,
  pluginUserSettings,
} from "../schema.js";
import { likePrefixPattern } from "./sql-like.js";

export interface PluginKvRow {
  pluginId: string;
  key: string;
  value: string;
  updatedAt: number;
}

export interface PluginSettingRow {
  pluginId: string;
  key: string;
  value: string;
  updatedAt: number;
}


export function getPluginKvValue(
  db: DbConnection,
  pluginId: string,
  key: string,
): string | undefined {
  return db
    .select({ value: pluginKv.value })
    .from(pluginKv)
    .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, key)))
    .get()?.value;
}

export function setPluginKvValue(
  db: DbConnection,
  pluginId: string,
  key: string,
  value: string,
): void {
  const updatedAt = Date.now();
  db.insert(pluginKv)
    .values({ pluginId, key, value, updatedAt })
    .onConflictDoUpdate({
      target: [pluginKv.pluginId, pluginKv.key],
      set: { value, updatedAt },
    })
    .run();
}

export function deletePluginKvValue(
  db: DbConnection,
  pluginId: string,
  key: string,
): boolean {
  const result = db
    .delete(pluginKv)
    .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, key)))
    .run();
  return result.changes > 0;
}

export function listPluginKvKeys(
  db: DbConnection,
  pluginId: string,
  prefix?: string,
): string[] {
  const conditions = [eq(pluginKv.pluginId, pluginId)];
  if (prefix !== undefined && prefix.length > 0) {
    conditions.push(
      sql`${pluginKv.key} LIKE ${likePrefixPattern(prefix)} ESCAPE '\\'`,
    );
  }
  return db
    .select({ key: pluginKv.key })
    .from(pluginKv)
    .where(and(...conditions))
    .orderBy(asc(pluginKv.key))
    .all()
    .map((row) => row.key);
}


export function getPluginSettingsValues(
  db: DbConnection,
  pluginId: string,
): Record<string, string> {
  const rows = db
    .select({ key: pluginSettings.key, value: pluginSettings.value })
    .from(pluginSettings)
    .where(eq(pluginSettings.pluginId, pluginId))
    .all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function setPluginSettingsValues(
  db: DbConnection,
  pluginId: string,
  values: Record<string, string | null>,
): void {
  const updatedAt = Date.now();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        tx.delete(pluginSettings)
          .where(
            and(
              eq(pluginSettings.pluginId, pluginId),
              eq(pluginSettings.key, key),
            ),
          )
          .run();
        continue;
      }
      tx.insert(pluginSettings)
        .values({ pluginId, key, value, updatedAt })
        .onConflictDoUpdate({
          target: [pluginSettings.pluginId, pluginSettings.key],
          set: { value, updatedAt },
        })
        .run();
    }
  });
}

export function deleteAllPluginSettings(
  db: DbConnection,
  pluginId: string,
): void {
  db.transaction((tx) => {
    tx.delete(pluginSettings)
      .where(eq(pluginSettings.pluginId, pluginId))
      .run();
    tx.delete(pluginUserSettings)
      .where(eq(pluginUserSettings.pluginId, pluginId))
      .run();
  });
}

export function pluginUserExists(db: DbConnection, userId: string): boolean {
  return (
    db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .get() !== undefined
  );
}

export function getPluginUserKvValue(
  db: DbConnection,
  args: { pluginId: string; userId: string; key: string },
): string | undefined {
  return db
    .select({ value: pluginUserKv.value })
    .from(pluginUserKv)
    .where(
      and(
        eq(pluginUserKv.pluginId, args.pluginId),
        eq(pluginUserKv.userId, args.userId),
        eq(pluginUserKv.key, args.key),
      ),
    )
    .get()?.value;
}

export function setPluginUserKvValue(
  db: DbConnection,
  args: { pluginId: string; userId: string; key: string; value: string },
): void {
  const updatedAt = Date.now();
  db.insert(pluginUserKv)
    .values({ ...args, updatedAt })
    .onConflictDoUpdate({
      target: [pluginUserKv.pluginId, pluginUserKv.userId, pluginUserKv.key],
      set: { value: args.value, updatedAt },
    })
    .run();
}

export function deletePluginUserKvValue(
  db: DbConnection,
  args: { pluginId: string; userId: string; key: string },
): boolean {
  const result = db
    .delete(pluginUserKv)
    .where(
      and(
        eq(pluginUserKv.pluginId, args.pluginId),
        eq(pluginUserKv.userId, args.userId),
        eq(pluginUserKv.key, args.key),
      ),
    )
    .run();
  return result.changes > 0;
}

export function listPluginUserKvKeys(
  db: DbConnection,
  args: { pluginId: string; userId: string; prefix?: string },
): string[] {
  const conditions = [
    eq(pluginUserKv.pluginId, args.pluginId),
    eq(pluginUserKv.userId, args.userId),
  ];
  if (args.prefix !== undefined && args.prefix.length > 0) {
    conditions.push(
      sql`${pluginUserKv.key} LIKE ${likePrefixPattern(args.prefix)} ESCAPE '\\'`,
    );
  }
  return db
    .select({ key: pluginUserKv.key })
    .from(pluginUserKv)
    .where(and(...conditions))
    .orderBy(asc(pluginUserKv.key))
    .all()
    .map((row) => row.key);
}

export function getPluginUserSettingsValues(
  db: DbConnection,
  args: { pluginId: string; userId: string },
): Record<string, string> {
  const rows = db
    .select({ key: pluginUserSettings.key, value: pluginUserSettings.value })
    .from(pluginUserSettings)
    .where(
      and(
        eq(pluginUserSettings.pluginId, args.pluginId),
        eq(pluginUserSettings.userId, args.userId),
      ),
    )
    .all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function setPluginUserSettingsValues(
  db: DbConnection,
  args: {
    pluginId: string;
    userId: string;
    values: Record<string, string | null>;
  },
): void {
  const { pluginId, userId } = args;
  const updatedAt = Date.now();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(args.values)) {
      if (value === null) {
        tx.delete(pluginUserSettings)
          .where(
            and(
              eq(pluginUserSettings.pluginId, pluginId),
              eq(pluginUserSettings.userId, userId),
              eq(pluginUserSettings.key, key),
            ),
          )
          .run();
        continue;
      }
      tx.insert(pluginUserSettings)
        .values({ pluginId, userId, key, value, updatedAt })
        .onConflictDoUpdate({
          target: [
            pluginUserSettings.pluginId,
            pluginUserSettings.userId,
            pluginUserSettings.key,
          ],
          set: { value, updatedAt },
        })
        .run();
    }
  });
}

export function listPluginKvRows(
  db: DbConnection,
  pluginId: string,
): PluginKvRow[] {
  return db
    .select()
    .from(pluginKv)
    .where(eq(pluginKv.pluginId, pluginId))
    .orderBy(asc(pluginKv.key))
    .all();
}

export function listPluginSettingRows(
  db: DbConnection,
  pluginId: string,
): PluginSettingRow[] {
  return db
    .select()
    .from(pluginSettings)
    .where(eq(pluginSettings.pluginId, pluginId))
    .orderBy(asc(pluginSettings.key))
    .all();
}
