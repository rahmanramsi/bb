import { and, eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { uiPreferenceDefaults, userSettings } from "../schema.js";

export interface StoredUiPreference {
  key: string;
  revision: number;
  valueJson: string;
}

export type ReplaceUiPreferenceResult =
  | { outcome: "updated"; revision: number }
  | { outcome: "conflict"; revision: number };

export function listStoredUiPreferences(
  db: DbConnection,
  userId: string,
): StoredUiPreference[] {
  return db
    .select({
      key: userSettings.key,
      revision: userSettings.revision,
      valueJson: userSettings.valueJson,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .all();
}

export function getStoredUserSetting(
  db: DbQueryConnection,
  args: { key: string; userId: string },
): StoredUiPreference | null {
  return (
    db
      .select({
        key: userSettings.key,
        revision: userSettings.revision,
        valueJson: userSettings.valueJson,
      })
      .from(userSettings)
      .where(
        and(
          eq(userSettings.userId, args.userId),
          eq(userSettings.key, args.key),
        ),
      )
      .get() ?? null
  );
}

export function listStoredUiPreferenceDefaults(
  db: DbConnection,
): { key: string; valueJson: string }[] {
  return db.select().from(uiPreferenceDefaults).all();
}

export function getStoredUiPreferenceDefault(
  db: DbConnection,
  key: string,
): string | undefined {
  return db
    .select({ valueJson: uiPreferenceDefaults.valueJson })
    .from(uiPreferenceDefaults)
    .where(eq(uiPreferenceDefaults.key, key))
    .get()?.valueJson;
}

function upsertStoredUserSetting(
  db: DbQueryConnection,
  args: { key: string; revision: number; userId: string; valueJson: string },
): void {
  const updatedAt = Date.now();
  db.insert(userSettings)
    .values({
      userId: args.userId,
      key: args.key,
      revision: args.revision,
      updatedAt,
      valueJson: args.valueJson,
    })
    .onConflictDoUpdate({
      target: [userSettings.userId, userSettings.key],
      set: { revision: args.revision, updatedAt, valueJson: args.valueJson },
    })
    .run();
}

export function replaceStoredUiPreference(
  db: DbConnection,
  args: {
    expectedRevision: number;
    key: string;
    userId: string;
    valueJson: string;
  },
): ReplaceUiPreferenceResult {
  return db.transaction((tx) => {
    const currentRevision = getStoredUserSetting(tx, args)?.revision ?? 0;
    if (currentRevision !== args.expectedRevision) {
      return { outcome: "conflict", revision: currentRevision };
    }
    const revision = currentRevision + 1;
    upsertStoredUserSetting(tx, {
      key: args.key,
      revision,
      userId: args.userId,
      valueJson: args.valueJson,
    });
    return { outcome: "updated", revision };
  });
}

export function overwriteStoredUiPreference(
  db: DbConnection,
  args: { key: string; userId: string; valueJson: string },
): { revision: number } {
  return db.transaction((tx) => {
    const revision = (getStoredUserSetting(tx, args)?.revision ?? 0) + 1;
    upsertStoredUserSetting(tx, {
      key: args.key,
      revision,
      userId: args.userId,
      valueJson: args.valueJson,
    });
    return { revision };
  });
}
