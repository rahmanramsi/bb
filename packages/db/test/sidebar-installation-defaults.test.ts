import { describe, expect, it } from "vitest";
import { LOCAL_OWNER_USER_ID, PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  createConnection,
  migrate,
  createProject,
  createThread,
  upsertHost,
  noopNotifier,
} from "../src/index.js";
import {
  dropPluginEnabledFollowsDefaultColumn,
  dropIdleLifecycleIndexes,
  rewindThreadPruningWork,
  dropMarketplaceSourceGitSubdirectoryColumn,
  restoreLegacyPerUserSettingsTables,
  rewindMultiUser,
  dropQueuedMessageEditHeldUntilColumn,
} from "./helpers/rewind.js";

const SIDEBAR_INSTALLATION_DEFAULTS_MIGRATION_TIMESTAMP = 1790009314673;

it("leaves a fresh migrated database without an installation override", () => {
  const db = createConnection(":memory:");
  try {
    migrate(db);
    expect(
      db.$client.prepare("SELECT * FROM ui_preference_defaults").all(),
    ).toEqual([]);
    expect(db.$client.prepare("SELECT * FROM user_settings").all()).toEqual([]);
    db.$client.exec(
      `INSERT INTO user_settings VALUES ('${LOCAL_OWNER_USER_ID}', 'sidebar.chronologicalSort', '"alpha"', 1, 1)`,
    );
    migrate(db);
    expect(
      db.$client.prepare("SELECT * FROM ui_preference_defaults").all(),
    ).toEqual([]);
  } finally {
    db.$client.close();
  }
});

describe.each(["project", "thread", "preference"] as const)(
  "existing installation with %s",
  (kind) => {
    it.each([null, "chronological", "machine", "project"])(
      "keeps saved choice %s separate from the fallback",
      (choice) => {
        const db = createConnection(":memory:");
        try {
          migrate(db);
          if (kind === "thread") {
            createThread(db, noopNotifier, {
              projectId: PERSONAL_PROJECT_ID,
              providerId: "test-provider",
            });
          } else if (kind === "project") {
            const host = upsertHost(db, noopNotifier, {
              id: "host-sidebar",
              name: "Sidebar test",
            });
            createProject(db, noopNotifier, {
              name: "Existing project",
              source: {
                type: "local_path",
                hostId: host.id,
                path: "/tmp/sidebar-installation-defaults",
              },
            });
          }
          db.$client.exec("DROP TABLE ui_preference_defaults");
          dropIdleLifecycleIndexes(db);
          rewindThreadPruningWork(db);
          dropPluginEnabledFollowsDefaultColumn(db);
          dropQueuedMessageEditHeldUntilColumn(db);
          dropMarketplaceSourceGitSubdirectoryColumn(db);
          rewindMultiUser(db);
          db.$client
            .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
            .run(SIDEBAR_INSTALLATION_DEFAULTS_MIGRATION_TIMESTAMP);
          restoreLegacyPerUserSettingsTables(db);
          if (kind === "preference") {
            db.$client.exec(
              `INSERT INTO ui_preferences VALUES ('sidebar.chronologicalSort', '"alpha"', 1, 1)`,
            );
          }
          if (choice !== null) {
            db.$client
              .prepare(
                "INSERT INTO ui_preferences VALUES ('sidebar.organizationMode', ?, 4, 123)",
              )
              .run(JSON.stringify(choice));
          }
          const before = db.$client
            .prepare<
              [],
              {
                key: string;
                revision: number;
                updated_at: number;
                value_json: string;
              }
            >("SELECT * FROM ui_preferences ORDER BY key")
            .all()
            .map((row) => ({
              user_id: LOCAL_OWNER_USER_ID,
              key: row.key,
              value_json: row.value_json,
              revision: row.revision,
              updated_at: row.updated_at,
            }));
          const projects = db.$client.prepare("SELECT * FROM projects").all();
          const threads = db.$client
            .prepare<[], Record<string, unknown>>("SELECT * FROM threads")
            .all()
            .map(
              ({
                last_read_at: _lastReadAt,
                pinned_at: _pinnedAt,
                pin_sort_key: _pinSortKey,
                ...thread
              }) => ({
                ...thread,
                created_by_user_id: LOCAL_OWNER_USER_ID,
              }),
            );
          migrate(db);
          expect(
            db.$client.prepare("SELECT * FROM ui_preference_defaults").all(),
          ).toEqual([
            { key: "sidebar.organizationMode", value_json: '"project"' },
          ]);
          const userSettings = () =>
            db.$client
              .prepare(
                "SELECT user_id, key, value_json, revision, updated_at FROM user_settings ORDER BY key",
              )
              .all();
          expect(userSettings()).toEqual(before);
          expect(db.$client.prepare("SELECT * FROM projects").all()).toEqual(
            projects,
          );
          expect(db.$client.prepare("SELECT * FROM threads").all()).toEqual(
            threads,
          );
          migrate(db);
          expect(userSettings()).toEqual(before);
        } finally {
          db.$client.close();
        }
      },
    );
  },
);
