import type { DbConnection } from "../../src/index.js";

export function dropPluginEnabledFollowsDefaultColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugins)")
    .all();
  if (columns.some((column) => column.name === "enabled_follows_default")) {
    db.$client.exec("ALTER TABLE plugins DROP COLUMN enabled_follows_default");
  }
}

export function rewindThreadPruningWork(db: DbConnection): void {
  db.$client.exec(`
    DROP TABLE IF EXISTS thread_pruning_work;
    DELETE FROM __drizzle_migrations WHERE created_at >= 1791399370294;
  `);
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(thread_pruning_cursors)")
    .all();
  if (columns.some((column) => column.name === "work_revision"))
    db.$client.exec(
      "ALTER TABLE thread_pruning_cursors DROP COLUMN work_revision",
    );
}

export function dropIdleLifecycleIndexes(db: DbConnection): void {
  for (const name of [
    "hosts_pending_provider_idx",
    "threads_deleted_cleanup_idx",
  ]) {
    db.$client.exec(`DROP INDEX IF EXISTS ${name}`);
  }
}

export function dropQueuedMessageEditHeldUntilColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(queued_thread_messages)")
    .all();
  if (columns.some((column) => column.name === "edit_held_until")) {
    db.$client.exec(
      "ALTER TABLE queued_thread_messages DROP COLUMN edit_held_until",
    );
  }
}

export function dropMarketplaceSourceGitSubdirectoryColumn(
  db: DbConnection,
): void {
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugin_marketplaces)")
    .all();
  if (columns.some((column) => column.name === "source_git_subdirectory")) {
    db.$client.exec(
      "ALTER TABLE plugin_marketplaces DROP COLUMN source_git_subdirectory",
    );
  }
}

function columnNames(db: DbConnection, table: string): string[] {
  return db.$client
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

const LEGACY_PER_USER_STATE_DROP_MIGRATION_WHEN = 1791948352440;
const LEGACY_PER_USER_SETTINGS_TABLES = [
  {
    createdByMigrationWhen: 1781917615702,
    name: "app_theme",
    ddl: `CREATE TABLE app_theme (
      id text PRIMARY KEY NOT NULL,
      theme_id text NOT NULL,
      updated_at integer NOT NULL,
      favicon_color text DEFAULT 'default' NOT NULL
    )`,
  },
  {
    createdByMigrationWhen: 1788908496395,
    name: "ui_preferences",
    ddl: `CREATE TABLE ui_preferences (
      key text PRIMARY KEY NOT NULL,
      value_json text NOT NULL,
      revision integer NOT NULL,
      updated_at integer NOT NULL
    )`,
  },
] as const;

function isMigrationApplied(db: DbConnection, when: number): boolean {
  return (
    db.$client
      .prepare<
        [number],
        { found: number }
      >("SELECT 1 AS found FROM __drizzle_migrations WHERE created_at = ?")
      .get(when) !== undefined
  );
}

export function createLegacyUiPreferencesTable(db: DbConnection): void {
  const table = LEGACY_PER_USER_SETTINGS_TABLES.find(
    (candidate) => candidate.name === "ui_preferences",
  );
  if (table !== undefined) {
    db.$client.exec(table.ddl);
  }
}

export function restoreLegacyPerUserSettingsTables(db: DbConnection): void {
  if (isMigrationApplied(db, LEGACY_PER_USER_STATE_DROP_MIGRATION_WHEN)) {
    return;
  }
  for (const table of LEGACY_PER_USER_SETTINGS_TABLES) {
    const exists =
      db.$client
        .prepare<
          [string],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table.name) !== undefined;
    const created = isMigrationApplied(db, table.createdByMigrationWhen);
    if (!exists && created) {
      db.$client.exec(table.ddl);
    }
    if (exists && !created) {
      db.$client.exec(`DROP TABLE ${table.name}`);
    }
  }
}

function restoreLegacyThreadPerUserColumns(db: DbConnection): void {
  const threadColumns = columnNames(db, "threads");
  for (const [column, type] of [
    ["pinned_at", "integer"],
    ["pin_sort_key", "text"],
    ["last_read_at", "integer"],
  ] as const) {
    if (!threadColumns.includes(column)) {
      db.$client.exec(`ALTER TABLE threads ADD ${column} ${type}`);
    }
  }
  db.$client.exec(
    'CREATE INDEX IF NOT EXISTS threads_pin_sort_idx ON threads (archived_at, deleted_at, pin_sort_key, id) WHERE "threads"."pinned_at" IS NOT NULL',
  );
}

export function rewindMultiUser(db: DbConnection): void {
  restoreLegacyThreadPerUserColumns(db);
  db.$client.exec(`
    DROP TABLE IF EXISTS plugin_caller_grants;
    DROP TABLE IF EXISTS plugin_user_settings;
    DROP TABLE IF EXISTS plugin_user_kv;
    DROP TABLE IF EXISTS turn_request_authors;
    DROP TABLE IF EXISTS thread_user_state;
    DROP TABLE IF EXISTS user_settings;
    DROP TABLE IF EXISTS session;
    DROP TABLE IF EXISTS account;
    DROP TABLE IF EXISTS verification;
  `);
  for (const [table, column] of [
    ["user", "role"],
    ["threads", "created_by_user_id"],
    ["prompt_history_entries", "user_id"],
    ["queued_thread_messages", "author_grant_id"],
    ["queued_thread_messages", "author_role_ceiling"],
    ["queued_thread_messages", "author_user_id"],
    ["pending_interactions", "resolved_by_user_id"],
  ] as const) {
    const columns = db.$client
      .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
      .all();
    if (columns.some((existing) => existing.name === column)) {
      db.$client.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
}
