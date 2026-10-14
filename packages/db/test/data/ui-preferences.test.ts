import { LOCAL_OWNER_USER_ID } from "@bb/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listStoredUiPreferences,
  overwriteStoredUiPreference,
  replaceStoredUiPreference,
  type DbConnection,
} from "../../src/index.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

describe("ui preferences data", () => {
  let db: DbConnection;

  beforeEach(() => {
    db = createMigratedConnection();
  });

  afterEach(() => {
    db.$client.close();
  });

  it("creates a row at revision 1 only when the expected revision is 0", () => {
    expect(listStoredUiPreferences(db, LOCAL_OWNER_USER_ID)).toEqual([]);
    expect(
      replaceStoredUiPreference(db, {
        userId: LOCAL_OWNER_USER_ID,
        expectedRevision: 3,
        key: "sidebar.organizationMode",
        valueJson: '"machine"',
      }),
    ).toEqual({ outcome: "conflict", revision: 0 });
    expect(
      replaceStoredUiPreference(db, {
        userId: LOCAL_OWNER_USER_ID,
        expectedRevision: 0,
        key: "sidebar.organizationMode",
        valueJson: '"machine"',
      }),
    ).toEqual({ outcome: "updated", revision: 1 });
    expect(listStoredUiPreferences(db, LOCAL_OWNER_USER_ID)).toEqual([
      {
        key: "sidebar.organizationMode",
        revision: 1,
        valueJson: '"machine"',
      },
    ]);
  });

  it("rejects stale writes and keeps the current value", () => {
    replaceStoredUiPreference(db, {
      userId: LOCAL_OWNER_USER_ID,
      expectedRevision: 0,
      key: "sidebar.hiddenFooterItems",
      valueJson: '["prj_1"]',
    });
    replaceStoredUiPreference(db, {
      userId: LOCAL_OWNER_USER_ID,
      expectedRevision: 1,
      key: "sidebar.hiddenFooterItems",
      valueJson: '["prj_1","prj_2"]',
    });
    expect(
      replaceStoredUiPreference(db, {
        userId: LOCAL_OWNER_USER_ID,
        expectedRevision: 1,
        key: "sidebar.hiddenFooterItems",
        valueJson: "[]",
      }),
    ).toEqual({ outcome: "conflict", revision: 2 });
    expect(listStoredUiPreferences(db, LOCAL_OWNER_USER_ID)).toEqual([
      {
        key: "sidebar.hiddenFooterItems",
        revision: 2,
        valueJson: '["prj_1","prj_2"]',
      },
    ]);
  });

  it("overwrites without a revision check and still advances the revision", () => {
    expect(
      overwriteStoredUiPreference(db, {
        userId: LOCAL_OWNER_USER_ID,
        key: "sidebar.chronologicalSort",
        valueJson: '"alpha"',
      }),
    ).toEqual({ revision: 1 });
    replaceStoredUiPreference(db, {
      userId: LOCAL_OWNER_USER_ID,
      expectedRevision: 1,
      key: "sidebar.chronologicalSort",
      valueJson: '"created"',
    });
    expect(
      overwriteStoredUiPreference(db, {
        userId: LOCAL_OWNER_USER_ID,
        key: "sidebar.chronologicalSort",
        valueJson: '"updated"',
      }),
    ).toEqual({ revision: 3 });
    expect(listStoredUiPreferences(db, LOCAL_OWNER_USER_ID)).toEqual([
      {
        key: "sidebar.chronologicalSort",
        revision: 3,
        valueJson: '"updated"',
      },
    ]);
  });
});
