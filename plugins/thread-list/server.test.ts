import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { migrateFromUiPreferences } from "./server.js";
import { defaultPreferences } from "./shared/preferences.js";

const PLUGIN_ID = "thread-list";
const LOCAL_OWNER = "usr_local_owner";
const ALICE = "usr_alice";
const BOB = "usr_bob";

function mine(bb: BbPluginApi, userId = LOCAL_OWNER) {
  return bb.storage.experimental_forUser(userId).kv;
}

function setup(options: {
  uiPreferences?: Record<string, { revision: number; value: unknown }>;
  uiPreferencesFail?: boolean;
} = {}) {
  return createFakePluginHost({
    pluginId: PLUGIN_ID,
    experimental_userIds: [LOCAL_OWNER, ALICE, BOB],
    sdk: {
      system: {
        uiPreferences: {
          list: async () => {
            if (options.uiPreferencesFail) throw new Error("offline");
            return { preferences: options.uiPreferences ?? {} };
          },
        },
      },
    },
  });
}

describe("thread-list preferences rpc", () => {
  it("lists defaults on a fresh install and round-trips a valid write", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(harness.behavior.callRpc("listPreferences", null)).resolves.toEqual({
      preferences: defaultPreferences(),
    });
    await expect(harness.behavior.callRpc("listPreferences", null)).resolves.toMatchObject({
      preferences: { showProviderIcons: true },
    });
    await harness.behavior.callRpc("setPreference", {
      key: "showProviderIcons",
      value: false,
    });
    await migrateFromUiPreferences(bb);
    await expect(harness.behavior.callRpc("listPreferences", null)).resolves.toMatchObject({
      preferences: { showProviderIcons: false },
    });

    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "organizationMode",
        value: "machine",
      }),
    ).resolves.toEqual({ key: "organizationMode", value: "machine" });
    await expect(mine(bb).get("preference:organizationMode")).resolves.toBe(
      "machine",
    );
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBeUndefined();
    const listed = (await harness.behavior.callRpc("listPreferences", null)) as {
      preferences: { organizationMode: string };
    };
    expect(listed.preferences.organizationMode).toBe("machine");
    expect(harness.realtimeSignals).toEqual([
      {
        channel: "preferences",
        payload: { key: "showProviderIcons", value: false },
        experimental_userId: LOCAL_OWNER,
      },
      {
        channel: "preferences",
        payload: { key: "organizationMode", value: "machine" },
        experimental_userId: LOCAL_OWNER,
      },
    ]);
  });

  it("rejects a value that fails the preference's schema and leaves storage alone", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "organizationMode",
        value: "sideways",
      }),
    ).rejects.toThrow(/Invalid value for organizationMode/);
    await expect(mine(bb).get("preference:organizationMode")).resolves.toBeUndefined();
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "hiddenGroups",
        value: ["project:a", "bogus"],
      }),
    ).rejects.toThrow(/Invalid value for hiddenGroups/);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "showProviderIcons",
        value: "false",
      }),
    ).rejects.toThrow(/Invalid value for showProviderIcons/);
  });

  it("dedupes hidden groups and resets to the default", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "hiddenGroups",
        value: ["threads", "project:a", "project:a", "machine:m"],
      }),
    ).resolves.toEqual({
      key: "hiddenGroups",
      value: ["threads", "project:a", "machine:m"],
    });
    await expect(
      harness.behavior.callRpc("resetPreference", { key: "hiddenGroups" }),
    ).resolves.toEqual({ key: "hiddenGroups", value: [] });
    await expect(mine(bb).get("preference:hiddenGroups")).resolves.toEqual([]);
  });

  it("defaults row actions to archive, migrates bare ids, dedupes them, and rejects malformed or too many keys", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const listed = (await harness.behavior.callRpc("listPreferences", null)) as {
      preferences: { rowActions: string[] };
    };
    expect(listed.preferences.rowActions).toEqual(["bb--core/archive"]);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["pin", "core/archive", "bb--core/pin"],
      }),
    ).resolves.toEqual({
      key: "rowActions",
      value: ["bb--core/pin", "bb--core/archive"],
    });
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["move", "push-notifications/level"],
      }),
    ).resolves.toEqual({
      key: "rowActions",
      value: ["thread-list/move", "push-notifications/level"],
    });
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["archive", "delete"],
      }),
    ).rejects.toThrow(/Invalid value for rowActions/);
    await expect(
      harness.behavior.callRpc("setPreference", {
        key: "rowActions",
        value: ["archive", "pin", "read", "rename"],
      }),
    ).rejects.toThrow(/at most 3 row actions/);
  });

  it("migrates stored bare ids and core/<id> keys and drops unknown ones instead of resetting the rest", async () => {
    const { bb, harness } = setup();
    await bb.storage.kv.set("preference:rowActions", [
      "pin",
      "futureAction",
      "move",
      "core/rename",
    ]);
    await plugin(bb);
    const listed = (await harness.behavior.callRpc("listPreferences", null)) as {
      preferences: { rowActions: string[] };
    };
    expect(listed.preferences.rowActions).toEqual([
      "bb--core/pin",
      "thread-list/move",
      "bb--core/rename",
    ]);
  });

  it("falls back to the default when a stored value no longer parses", async () => {
    const { bb, harness } = setup();
    await bb.storage.kv.set("preference:chronologicalSort", "by-vibes");
    await plugin(bb);
    const listed = (await harness.behavior.callRpc("listPreferences", null)) as {
      preferences: { chronologicalSort: string };
    };
    expect(listed.preferences.chronologicalSort).toBe("updated");
  });
});

describe("migration from bb's sidebar preferences", () => {
  it("copies non-default values once and never overwrites a value the plugin already has", async () => {
    const { bb } = setup({
      uiPreferences: {
        "sidebar.organizationMode": { revision: 3, value: "machine" },
        "sidebar.sectionOrder": { revision: 1, value: ["proj_a"] },
        "sidebar.chronologicalSort": { revision: 0, value: "updated" },
        "sidebar.hiddenGroups": { revision: 2, value: ["not-a-group"] },
      },
    });
    await bb.storage.kv.set("preference:sectionOrder", ["proj_mine"]);
    const first = await migrateFromUiPreferences(bb);
    expect(first.migrated).toEqual(["organizationMode"]);
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBe(
      "machine",
    );
    await expect(bb.storage.kv.get("preference:sectionOrder")).resolves.toEqual([
      "proj_mine",
    ]);
    await expect(bb.storage.kv.get("preference:chronologicalSort")).resolves.toBeUndefined();
    await expect(bb.storage.kv.get("preference:hiddenGroups")).resolves.toBeUndefined();

    await bb.storage.kv.delete("preference:organizationMode");
    const second = await migrateFromUiPreferences(bb);
    expect(second.migrated).toEqual([]);
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBeUndefined();
  });

  it("skips the migration without marking it done when bb cannot be read", async () => {
    const { bb } = setup({ uiPreferencesFail: true });
    expect((await migrateFromUiPreferences(bb)).migrated).toEqual([]);
    await expect(bb.storage.kv.get("migration:ui-preferences:v1")).resolves.toBeUndefined();
  });
});

describe("bb thread-list prefs", () => {
  it("names the CLI after the plugin id", async () => {
    const builtIn = setup();
    await plugin(builtIn.bb);
    expect(builtIn.harness.inspection.registrations.cli?.name).toBe(
      "thread-list",
    );

    const copy = createFakePluginHost({ pluginId: "my-sidebar" });
    await plugin(copy.bb);
    expect(copy.harness.inspection.registrations.cli?.name).toBe("my-sidebar");
  });

  it("lists, gets, sets, and resets through the CLI", async () => {
    const { bb, harness } = setup();
    await plugin(bb);

    const listed = await harness.behavior.runCli(["prefs", "list", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(defaultPreferences());

    const set = await harness.behavior.runCli([
      "prefs",
      "set",
      "manualSectionOrder",
      '["threads","pinned","sections"]',
    ]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toBe('manualSectionOrder = ["threads","pinned","sections"]');

    const bare = await harness.behavior.runCli(["prefs", "set", "organizationMode", "project"]);
    expect(bare.exitCode).toBe(0);

    const got = await harness.behavior.runCli(["prefs", "get", "organizationMode"]);
    expect(got.stdout).toBe('"project"');

    const iconsOn = await harness.behavior.runCli([
      "prefs", "set", "showProviderIcons", "true",
    ]);
    expect(iconsOn.exitCode).toBe(0);
    expect(iconsOn.stdout).toBe("showProviderIcons = true");
    await expect(mine(bb).get("preference:showProviderIcons")).resolves.toBe(true);
    const resetIcons = await harness.behavior.runCli([
      "prefs", "reset", "showProviderIcons", "--json",
    ]);
    expect(JSON.parse(resetIcons.stdout)).toEqual({
      key: "showProviderIcons",
      value: true,
    });

    const bad = await harness.behavior.runCli(["prefs", "set", "organizationMode", "nope"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toMatch(/Invalid value for organizationMode/);

    const unknown = await harness.behavior.runCli(["prefs", "get", "colour"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toMatch(/Unknown preference: colour/);

    const reset = await harness.behavior.runCli(["prefs", "reset", "organizationMode", "--json"]);
    expect(JSON.parse(reset.stdout)).toEqual({
      key: "organizationMode",
      value: "chronological",
    });
  });
});

it("validates lifecycle selection through CLI and RPC and broadcasts it", async () => {
  const { bb, harness } = setup();
  await plugin(bb);
  expect((await harness.behavior.runCli(["prefs", "set", "threadLifecycles", '["archived"]'])).exitCode).toBe(0);
  await expect(mine(bb).get("preference:threadLifecycles")).resolves.toEqual(["archived"]);
  for (const value of [[], ["archived", "archived"], ["deleted"]]) {
    await expect(harness.behavior.callRpc("setPreference", { key: "threadLifecycles", value })).rejects.toThrow(/Invalid value/);
  }
  await expect(mine(bb).get("preference:threadLifecycles")).resolves.toEqual(["archived"]);
  expect(harness.realtimeSignals).toContainEqual({
    channel: "preferences",
    payload: { key: "threadLifecycles", value: ["archived"] },
    experimental_userId: LOCAL_OWNER,
  });
});

describe("per-user sidebar preferences", () => {
  it("keeps two users' preferences apart and signals only the user who changed one", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await harness.behavior.callRpc(
      "setPreference",
      { key: "organizationMode", value: "machine" },
      { experimental_callerUserId: ALICE },
    );

    await expect(
      harness.behavior.callRpc("listPreferences", null, {
        experimental_callerUserId: ALICE,
      }),
    ).resolves.toMatchObject({ preferences: { organizationMode: "machine" } });
    await expect(
      harness.behavior.callRpc("listPreferences", null, {
        experimental_callerUserId: BOB,
      }),
    ).resolves.toMatchObject({
      preferences: { organizationMode: "chronological" },
    });
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBeUndefined();
    await expect(mine(bb, BOB).list()).resolves.toEqual([]);
    expect(harness.realtimeSignals).toEqual([
      {
        channel: "preferences",
        payload: { key: "organizationMode", value: "machine" },
        experimental_userId: ALICE,
      },
    ]);
  });

  it("reads earlier team-wide preferences until the user sets or resets their own", async () => {
    const { bb, harness } = setup();
    await bb.storage.kv.set("preference:organizationMode", "machine");
    await plugin(bb);
    const asAlice = { experimental_callerUserId: ALICE };
    const asBob = { experimental_callerUserId: BOB };

    await expect(
      harness.behavior.callRpc("listPreferences", null, asAlice),
    ).resolves.toMatchObject({ preferences: { organizationMode: "machine" } });
    await expect(
      harness.behavior.callRpc(
        "resetPreference",
        { key: "organizationMode" },
        asAlice,
      ),
    ).resolves.toEqual({ key: "organizationMode", value: "chronological" });
    await expect(
      harness.behavior.callRpc("listPreferences", null, asAlice),
    ).resolves.toMatchObject({
      preferences: { organizationMode: "chronological" },
    });
    await expect(
      harness.behavior.callRpc("listPreferences", null, asBob),
    ).resolves.toMatchObject({ preferences: { organizationMode: "machine" } });
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBe(
      "machine",
    );
  });

  it("refuses callers that are not a user", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("listPreferences", null, {
        experimental_caller: { kind: "plugin", pluginId: "other" },
      }),
    ).rejects.toThrow(/belong to a signed-in user/);
    const cli = await harness.behavior.runCli(["prefs", "list"], {
      experimental_callerUserId: undefined,
    });
    expect(cli.exitCode).not.toBe(0);
    expect(cli.stderr).toMatch(/belong to a signed-in user/);
  });

  it("changes the invoking user's preferences from the CLI", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const set = await harness.behavior.runCli(
      ["prefs", "set", "organizationMode", "project"],
      { experimental_callerUserId: BOB },
    );
    expect(set.exitCode).toBe(0);
    await expect(mine(bb, BOB).get("preference:organizationMode")).resolves.toBe(
      "project",
    );
    await expect(mine(bb, ALICE).get("preference:organizationMode")).resolves.toBeUndefined();
    expect(harness.realtimeSignals).toEqual([
      {
        channel: "preferences",
        payload: { key: "organizationMode", value: "project" },
        experimental_userId: BOB,
      },
    ]);
  });
});
