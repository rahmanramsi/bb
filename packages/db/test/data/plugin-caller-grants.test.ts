import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authUsers,
  createPluginCallerGrant,
  deletePluginCallerGrant,
  deletePluginCallerGrantsForPlugin,
  getPluginCallerGrant,
  listPluginCallerGrantsForUser,
  type DbConnection,
} from "../../src/index.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function insertUser(db: DbConnection, id: string): void {
  const now = new Date(1);
  db.insert(authUsers)
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      role: "member",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("plugin caller grants", () => {
  let db: DbConnection;

  beforeEach(() => {
    db = createMigratedConnection();
    insertUser(db, "usr_a");
    insertUser(db, "usr_b");
  });

  afterEach(() => db.$client.close());

  function grant(pluginId: string, userId: string, createdAt: number) {
    return createPluginCallerGrant(db, {
      pluginId,
      userId,
      maxRole: "member",
      purpose: `${pluginId} for ${userId}`,
      createdAt,
      expiresAt: null,
    });
  }

  it("lists only one user's grants, newest first", () => {
    const older = grant("automations", "usr_a", 1);
    const newer = grant("docs", "usr_a", 2);
    grant("automations", "usr_b", 3);

    expect(listPluginCallerGrantsForUser(db, "usr_a")).toEqual([newer, older]);
    expect(getPluginCallerGrant(db, older.id)).toEqual(older);
  });

  it("deletes a grant only for its own plugin or its own user", () => {
    const owned = grant("automations", "usr_a", 1);

    expect(
      deletePluginCallerGrant(db, { id: owned.id, pluginId: "docs" }),
    ).toBe(false);
    expect(deletePluginCallerGrant(db, { id: owned.id, userId: "usr_b" })).toBe(
      false,
    );
    expect(getPluginCallerGrant(db, owned.id)).not.toBeNull();
    expect(deletePluginCallerGrant(db, { id: owned.id, userId: "usr_a" })).toBe(
      true,
    );
    expect(getPluginCallerGrant(db, owned.id)).toBeNull();
  });

  it("drops grants when their user or plugin is removed", () => {
    const removedUser = grant("automations", "usr_a", 1);
    const removedPlugin = grant("docs", "usr_b", 2);
    const kept = grant("automations", "usr_b", 3);

    db.delete(authUsers).where(eq(authUsers.id, "usr_a")).run();
    deletePluginCallerGrantsForPlugin(db, "docs");

    expect(getPluginCallerGrant(db, removedUser.id)).toBeNull();
    expect(getPluginCallerGrant(db, removedPlugin.id)).toBeNull();
    expect(getPluginCallerGrant(db, kept.id)).toEqual(kept);
  });
});
