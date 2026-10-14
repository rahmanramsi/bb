import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it } from "vitest";
import { LOCAL_OWNER_USER_ID, PERSONAL_PROJECT_ID } from "@bb/domain";
import { createConnection, migrate, type DbConnection } from "../src/index.js";

function migrateBeforeMultiUser(db: DbConnection): void {
  const migrations = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  const multiUserIndex = migrations.findIndex((migration) =>
    migration.sql.some((statement) =>
      statement.includes("CREATE TABLE `thread_user_state`"),
    ),
  );
  expect(multiUserIndex).toBeGreaterThan(0);
  db.$client.exec(`
    CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);
    CREATE TEMP TABLE bb_migration_existing_installation (existing INTEGER NOT NULL);
    INSERT INTO bb_migration_existing_installation (existing) VALUES (0);
    CREATE TEMP TABLE bb_migration_local_host (id TEXT PRIMARY KEY);
  `);
  db.$client.pragma("foreign_keys = OFF");
  for (const migration of migrations.slice(0, multiUserIndex)) {
    for (const statement of migration.sql) db.$client.exec(statement);
    db.$client
      .prepare(
        'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
      )
      .run(migration.hash, migration.folderMillis);
  }
  db.$client.pragma("foreign_keys = ON");
}

function seedSingleUserData(db: DbConnection): void {
  db.$client.exec(`
    INSERT OR IGNORE INTO projects (id, name, kind, created_at, updated_at)
      VALUES ('${PERSONAL_PROJECT_ID}', 'Personal', 'personal', 1, 1);
    INSERT INTO threads (id, project_id, provider_id, status, last_read_at, pinned_at, pin_sort_key, latest_attention_at, created_at, updated_at)
      VALUES
        ('thr_read', '${PERSONAL_PROJECT_ID}', 'codex', 'idle', 500, NULL, NULL, 1, 1, 1),
        ('thr_pinned', '${PERSONAL_PROJECT_ID}', 'codex', 'idle', 600, 700, 'a0', 1, 1, 1),
        ('thr_untouched', '${PERSONAL_PROJECT_ID}', 'codex', 'idle', NULL, NULL, NULL, 1, 1, 1);
    INSERT INTO ui_preferences (key, value_json, revision, updated_at)
      VALUES
        ('sidebar.organizationMode', '"project"', 3, 40),
        ('sidebar.hiddenGroups', '["project:proj_a"]', 1, 50);
    INSERT INTO app_theme (id, theme_id, favicon_color, updated_at)
      VALUES ('current', 'nord', 'blue', 60);
    INSERT INTO prompt_history_entries (id, project_id, thread_id, scope, request_sequence, input, created_at)
      VALUES ('ph_1', '${PERSONAL_PROJECT_ID}', 'thr_read', 'thread', 1, '[]', 1);
    INSERT INTO queued_thread_messages (id, system_notice, thread_id, content, sender_thread_id, model, reasoning_level, permission_mode, service_tier, sort_key, created_at, updated_at)
      VALUES
        ('qm_user', NULL, 'thr_read', '[]', NULL, 'm', 'medium', 'auto', 'default', 'a0', 1, 1),
        ('qm_agent', NULL, 'thr_read', '[]', 'thr_pinned', 'm', 'medium', 'auto', 'default', 'a1', 1, 1),
        ('qm_notice', '{"kind":"k","subject":"s"}', 'thr_read', '[]', NULL, 'm', 'medium', 'auto', 'default', 'a2', 1, 1);
    INSERT INTO pending_interactions (id, thread_id, status, payload, created_at, updated_at, resolved_at)
      VALUES
        ('pi_resolved', 'thr_read', 'resolved', '{}', 1, 2, 2),
        ('pi_pending', 'thr_read', 'pending', '{}', 1, 1, NULL),
        ('pi_interrupted', 'thr_read', 'interrupted', '{}', 1, 2, 2);
  `);
}

function all(db: DbConnection, query: string): unknown[] {
  return db.$client.prepare(query).all();
}

it("backfills single-user state onto the local owner", () => {
  const db = createConnection(":memory:");
  try {
    migrateBeforeMultiUser(db);
    seedSingleUserData(db);
    migrate(db);

    expect(
      all(
        db,
        "SELECT id, role, emailVerified FROM user WHERE id = 'usr_local_owner'",
      ),
    ).toEqual([{ id: LOCAL_OWNER_USER_ID, role: "admin", emailVerified: 1 }]);
    expect(
      all(
        db,
        "SELECT thread_id, user_id, last_read_at, pinned_at, pin_sort_key FROM thread_user_state ORDER BY thread_id",
      ),
    ).toEqual([
      {
        thread_id: "thr_pinned",
        user_id: LOCAL_OWNER_USER_ID,
        last_read_at: 600,
        pinned_at: 700,
        pin_sort_key: "a0",
      },
      {
        thread_id: "thr_read",
        user_id: LOCAL_OWNER_USER_ID,
        last_read_at: 500,
        pinned_at: null,
        pin_sort_key: null,
      },
      {
        thread_id: "thr_untouched",
        user_id: LOCAL_OWNER_USER_ID,
        last_read_at: null,
        pinned_at: null,
        pin_sort_key: null,
      },
    ]);
    for (const column of ["last_read_at", "pinned_at", "pin_sort_key"]) {
      expect(
        all(db, "SELECT name FROM pragma_table_info('threads')"),
      ).not.toContainEqual({ name: column });
    }
    for (const table of ["ui_preferences", "app_theme"]) {
      expect(
        all(db, `SELECT name FROM sqlite_master WHERE name = '${table}'`),
      ).toEqual([]);
    }
    expect(
      all(
        db,
        "SELECT user_id, key, value_json, revision, updated_at FROM user_settings ORDER BY key",
      ),
    ).toEqual([
      {
        user_id: LOCAL_OWNER_USER_ID,
        key: "appearance",
        value_json: JSON.stringify({ themeId: "nord", faviconColor: "blue" }),
        revision: 1,
        updated_at: 60,
      },
      {
        user_id: LOCAL_OWNER_USER_ID,
        key: "sidebar.hiddenGroups",
        value_json: '["project:proj_a"]',
        revision: 1,
        updated_at: 50,
      },
      {
        user_id: LOCAL_OWNER_USER_ID,
        key: "sidebar.organizationMode",
        value_json: '"project"',
        revision: 3,
        updated_at: 40,
      },
    ]);
    expect(all(db, "SELECT DISTINCT created_by_user_id FROM threads")).toEqual([
      { created_by_user_id: LOCAL_OWNER_USER_ID },
    ]);
    expect(all(db, "SELECT user_id FROM prompt_history_entries")).toEqual([
      { user_id: LOCAL_OWNER_USER_ID },
    ]);
    expect(
      all(
        db,
        "SELECT id, author_user_id FROM queued_thread_messages ORDER BY id",
      ),
    ).toEqual([
      { id: "qm_agent", author_user_id: null },
      { id: "qm_notice", author_user_id: null },
      { id: "qm_user", author_user_id: LOCAL_OWNER_USER_ID },
    ]);
    expect(
      all(
        db,
        "SELECT id, resolved_by_user_id FROM pending_interactions ORDER BY id",
      ),
    ).toEqual([
      { id: "pi_interrupted", resolved_by_user_id: null },
      { id: "pi_pending", resolved_by_user_id: null },
      { id: "pi_resolved", resolved_by_user_id: LOCAL_OWNER_USER_ID },
    ]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.$client.close();
  }
});

it("creates the local owner on a fresh database and keeps it on re-run", () => {
  const db = createConnection(":memory:");
  try {
    migrate(db);
    migrate(db);
    expect(all(db, "SELECT id, role FROM user")).toEqual([
      { id: LOCAL_OWNER_USER_ID, role: "admin" },
    ]);
    expect(all(db, "SELECT count(*) AS count FROM user_settings")).toEqual([
      { count: 0 },
    ]);
  } finally {
    db.$client.close();
  }
});

it("detaches attribution instead of blocking user deletion", () => {
  const db = createConnection(":memory:");
  try {
    migrateBeforeMultiUser(db);
    seedSingleUserData(db);
    migrate(db);
    db.$client.exec("DELETE FROM user WHERE id = 'usr_local_owner'");
    expect(all(db, "SELECT count(*) AS count FROM thread_user_state")).toEqual([
      { count: 0 },
    ]);
    expect(all(db, "SELECT count(*) AS count FROM user_settings")).toEqual([
      { count: 0 },
    ]);
    expect(
      all(
        db,
        "SELECT count(*) AS count FROM threads WHERE created_by_user_id IS NOT NULL",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      all(
        db,
        "SELECT count(*) AS count FROM pending_interactions WHERE resolved_by_user_id IS NOT NULL",
      ),
    ).toEqual([{ count: 0 }]);
  } finally {
    db.$client.close();
  }
});
