import { unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  PluginContextStaleError,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { createAutomationService } from "./service.js";
import { sweepDueAutomations } from "./sweep.js";
import {
  automationListResponseSchema,
  automationsOverviewResponseSchema,
  automationDetailResponseSchema,
  automationResponseSchema,
  automationRunListResponseSchema,
  automationRunRpcResponseSchema,
} from "./rpc-types.js";

function storedScriptPathPattern(automationId: string): RegExp {
  const suffix = join(sep, "scripts", automationId, "script.sh");
  return new RegExp(`${suffix.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`);
}

const PROJECT_ID = "proj_test";
const MISSING_PROJECT_ID = "proj_missing";
const DELETED_PROJECT_ID = "proj_deleted";
const THREAD_ID = "thr_target";
const SECTION_ID = "sec_reviews";

const rpcMethods = [
  "automations_overview",
  "automations_list",
  "automations_get",
  "automations_create",
  "automations_adopt",
  "automations_create_script",
  "automations_update",
  "automations_update_script",
  "automations_delete",
  "automations_pause",
  "automations_pause_script",
  "automations_resume",
  "automations_resume_script",
  "automations_run",
  "automations_run_script",
  "automations_runs",
].sort();

function project(projectId = PROJECT_ID) {
  return {
    id: projectId,
    kind: "standard" as const,
    name: "Test Project",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    sources: [
      {
        id: `psrc_${projectId}`,
        projectId,
        type: "local_path" as const,
        hostId: "host_fake",
        path: "/test/project",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

async function bootAutomationsPlugin(
  declaredPermissionModes: Array<"accept-edits" | "auto" | "full"> = [
    "accept-edits",
    "auto",
    "full",
  ],
  routedPermissionModes?: Array<"accept-edits" | "auto" | "full">,
): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: "automations",
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_fake" }) },
      projects: {
        async get({ projectId }) {
          if (projectId === PROJECT_ID) return project(projectId);
          throw new Error("Project not found");
        },
        async list() {
          return [project()];
        },
      },
      threadSections: {
        async list() {
          return [
            {
              id: SECTION_ID,
              name: "Reviews",
              createdAt: 1,
              updatedAt: 1,
            },
          ];
        },
      },
      hosts: {
        async list() {
          return [{ id: "host_test", status: "connected" }];
        },
      },
      providers: {
        async list(routing) {
          const permissionModes =
            routing?.environmentId === "env_routed" &&
            routedPermissionModes !== undefined
              ? routedPermissionModes
              : declaredPermissionModes;
          return [
            { id: "codex", capabilities: { permissionModes } },
            {
              id: "claude",
              capabilities: { permissionModes: ["auto", "full"] },
            },
          ] as never;
        },
      },
      threads: {
        async get({ threadId }) {
          return {
            id: threadId,
            archivedAt: null,
            deletedAt: null,
            sectionId: threadId === THREAD_ID ? SECTION_ID : null,
            status: "idle",
          };
        },
        async send() {
          return { ok: true };
        },
        async spawn() {
          return {
            id: "thr_spawned",
            archivedAt: null,
            deletedAt: null,
            status: "idle",
          };
        },
      },
    },
  });
  await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
  return host;
}

function agentExecution(targetThreadId?: string) {
  return {
    mode: "agent",
    prompt: "summarize the inbox",
    providerId: "codex",
    model: "gpt-5",
    permissionMode: "accept-edits",
    environment: { type: "project-default" },
    ...(targetThreadId ? { targetThreadId } : {}),
  };
}

function oneShotTrigger() {
  return { triggerType: "once", runAt: Date.now() + 60_000 };
}

async function createAgentAutomation(
  harness: FakePluginHost["harness"],
  options: {
    name?: string;
    trigger?:
      | ReturnType<typeof oneShotTrigger>
      | { triggerType: "schedule"; cron: string; timezone: string };
    targetThreadId?: string;
  } = {},
) {
  return automationDetailResponseSchema.parse(
    await harness.callRpc("automations_create", {
      projectId: PROJECT_ID,
      name: options.name ?? "Agent automation",
      enabled: true,
      trigger: options.trigger ?? oneShotTrigger(),
      execution: agentExecution(options.targetThreadId),
      origin: "human",
    }),
  );
}

function signalKinds(host: FakePluginHost) {
  return host.harness.realtimeSignals
    .filter((signal) => signal.channel === "automations")
    .map((signal) => signal.payload)
    .filter(
      (payload): payload is { projectId: string; kind: string } =>
        typeof payload === "object" &&
        payload !== null &&
        "projectId" in payload &&
        "kind" in payload,
    )
    .map((payload) => payload.kind);
}

describe("automations server plugin harness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("boots through server.ts and registers rpc, cli, thread events, and sweep service", async () => {
    const { harness } = await bootAutomationsPlugin();

    expect([...harness.registrations.rpcMethods].sort()).toEqual(rpcMethods);
    expect(harness.registrations.cli?.name).toBe("automation");
    expect(
      harness.registrations.services.map((service) => service.name),
    ).toEqual(["automation-sweep"]);
    expect(harness.registrations.threadEventHandlers).toMatchObject({
      "thread.idle": 1,
      "thread.failed": 1,
      "thread.deleted": 1,
    });
    expect(harness.registrations.settingsDescriptors).toEqual({});

    await harness.dispose();
  });

  it("round-trips create, list, get, and delete over RPC and rejects unavailable projects", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;

    const created = await createAgentAutomation(harness, {
      name: "RPC agent",
      targetThreadId: THREAD_ID,
    });
    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );
    expect(listed.map((automation) => automation.id)).toContain(created.id);
    const overview = automationsOverviewResponseSchema.parse(
      await harness.callRpc("automations_overview"),
    );
    expect(overview.automations).toContainEqual(
      expect.objectContaining({
        automation: expect.objectContaining({ id: created.id }),
        project: { id: PROJECT_ID, name: "Test Project" },
      }),
    );

    const found = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );
    expect(found).toMatchObject({
      id: created.id,
      name: "RPC agent",
      execution: expect.objectContaining({ mode: "agent" }),
    });

    await expect(
      harness.callRpc("automations_create", {
        projectId: MISSING_PROJECT_ID,
        name: "Missing project",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: agentExecution(),
        origin: "human",
      }),
    ).rejects.toThrow(`Project ${MISSING_PROJECT_ID} is not available`);

    await expect(
      harness.callRpc("automations_create", {
        projectId: DELETED_PROJECT_ID,
        name: "Deleted project",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: agentExecution(),
        origin: "human",
      }),
    ).rejects.toThrow(`Project ${DELETED_PROJECT_ID} is not available`);

    await expect(
      harness.callRpc("automations_delete", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toHaveLength(0);
    expect(signalKinds(host)).toContain("automations-changed");

    await harness.dispose();
  });

  it("creates a script automation through CLI and lists it through both CLI and RPC", async () => {
    const { harness } = await bootAutomationsPlugin();
    const runAt = new Date(Date.now() + 60_000).toISOString();

    const createdResult = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "CLI script",
      "--at",
      runAt,
      "--script",
      "echo ok",
      "--interpreter",
      "bash",
      "--json",
    ]);
    expect(createdResult.exitCode).toBe(0);
    const created = automationDetailResponseSchema.parse(
      JSON.parse(createdResult.stdout ?? ""),
    );
    expect(created).toMatchObject({
      name: "CLI script",
      execution: expect.objectContaining({ mode: "script" }),
    });

    const cliList = await harness.runCli([
      "list",
      "--project",
      PROJECT_ID,
      "--json",
    ]);
    expect(cliList.exitCode).toBe(0);
    expect(
      automationListResponseSchema
        .parse(JSON.parse(cliList.stdout ?? ""))
        .map((automation) => automation.id),
    ).toEqual([created.id]);
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      )[0]?.id,
    ).toBe(created.id);
    const editable = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );
    expect(editable.execution).toMatchObject({
      mode: "script",
      script: "echo ok",
      resolvedWorkingDirectory: "/test/project",
    });
    expect(editable.execution).not.toHaveProperty("scriptFile");

    const agentUpdateResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "triage the inbox",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
      "--reasoning",
      "ultra",
      "--service-tier",
      "fast",
      "--permission-mode",
      "accept-edits",
      "--target-thread",
      THREAD_ID,
      "--json",
    ]);
    expect(agentUpdateResult.exitCode).toBe(0);
    const agentUpdated = automationDetailResponseSchema.parse(
      JSON.parse(agentUpdateResult.stdout ?? ""),
    );
    expect(agentUpdated.execution).toEqual({
      mode: "agent",
      prompt: "triage the inbox",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "ultra",
      serviceTier: "fast",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
      targetThreadId: THREAD_ID,
    });

    const scriptUpdateResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--script",
      "echo updated",
      "--interpreter",
      "bash",
      "--timeout",
      "12000",
      "--env-json",
      '{"CHANNEL":"qa"}',
      "--json",
    ]);
    expect(scriptUpdateResult.exitCode).toBe(0);
    const scriptUpdated = automationDetailResponseSchema.parse(
      JSON.parse(scriptUpdateResult.stdout ?? ""),
    );
    expect(scriptUpdated.execution).toEqual({
      mode: "script",
      scriptFile: "script.sh",
      storedScriptPath: expect.stringMatching(
        storedScriptPathPattern(created.id),
      ),
      interpreter: "bash",
      workingDirectory: { type: "project" },
      resolvedWorkingDirectory: "/test/project",
      timeoutMs: 12_000,
      env: { CHANNEL: "qa" },
    });
    const updatedEditable = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );
    expect(updatedEditable.execution).toEqual({
      mode: "script",
      script: "echo updated",
      storedScriptPath: expect.stringMatching(
        storedScriptPathPattern(created.id),
      ),
      interpreter: "bash",
      workingDirectory: { type: "project" },
      resolvedWorkingDirectory: "/test/project",
      timeoutMs: 12_000,
      env: { CHANNEL: "qa" },
    });

    const errorResult = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "No execution",
      "--in",
      "1h",
    ]);
    expect(errorResult.exitCode).toBe(1);
    expect(errorResult.stderr).toContain("Provide an execution mode");

    await harness.dispose();
  });

  it("accepts a bare millisecond timeout and a duration with a unit", async () => {
    const { harness } = await bootAutomationsPlugin();

    const bare = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Bare timeout",
      "--in",
      "1h",
      "--script",
      "echo ok",
      "--timeout",
      "5000",
      "--json",
    ]);
    expect(bare.exitCode, bare.stderr).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(bare.stdout ?? ""))
        .execution,
    ).toMatchObject({ mode: "script", timeoutMs: 5_000 });

    const withUnit = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Unit timeout",
      "--in",
      "1h",
      "--script",
      "echo ok",
      "--timeout",
      "90s",
      "--json",
    ]);
    expect(withUnit.exitCode, withUnit.stderr).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(withUnit.stdout ?? ""))
        .execution,
    ).toMatchObject({ mode: "script", timeoutMs: 90_000 });

    const tooLong = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Too long",
      "--in",
      "1h",
      "--script",
      "echo ok",
      "--timeout",
      "20m",
    ]);
    expect(tooLong.exitCode).toBe(1);
    expect(tooLong.stderr).toContain("invalid value '20m' for --timeout");

    await harness.dispose();
  });

  it("prints help for the whole CLI and for one command with exit 0", async () => {
    const { harness } = await bootAutomationsPlugin();

    const topLevel = await harness.runCli(["--help"]);
    expect(topLevel.exitCode, topLevel.stderr).toBe(0);
    expect(topLevel.stdout).toContain("bb automation list");
    expect(topLevel.stdout).toContain("bb automation delete");

    const perCommand = await harness.runCli(["runs", "--help"]);
    expect(perCommand.exitCode, perCommand.stderr).toBe(0);
    expect(perCommand.stdout).toContain("bb automation runs <automationId>");
    expect(perCommand.stdout).toContain("--limit <1-200>");

    const bare = await harness.runCli([]);
    expect(bare.exitCode, bare.stderr).toBe(0);
    expect(bare.stdout).toContain("bb automation <command> [options]");

    await harness.dispose();
  });

  it("rejects a positional argument to list", async () => {
    const { harness } = await bootAutomationsPlugin();

    const strayArgument = await harness.runCli([
      "list",
      "--project",
      PROJECT_ID,
      "auto_123",
    ]);
    expect(strayArgument.exitCode).toBe(1);
    expect(strayArgument.stderr).toContain("unexpected argument 'auto_123'");

    await harness.dispose();
  });

  it("reports every missing value once and names the thread's project", async () => {
    const { harness } = await bootAutomationsPlugin();

    const missingBoth = await harness.runCli(["show"]);
    expect(missingBoth.exitCode).toBe(1);
    expect(missingBoth.stderr).toContain(
      "missing required arguments: <automationId>",
    );

    const missingName = await harness.runCli(["create", "--script", "echo ok"]);
    expect(missingName.exitCode).toBe(1);
    expect(missingName.stderr).toContain("missing required options: --name");

    const noContext = await harness.runCli(["list"]);
    expect(noContext.exitCode).toBe(1);
    expect(noContext.stderr).toContain("missing required option --project");
    expect(noContext.stderr).toContain("bb project list");

    const withContext = await harness.runCli(["list"], {
      projectId: PROJECT_ID,
    });
    expect(withContext.exitCode).toBe(1);
    expect(withContext.stderr).toContain(
      `missing required option --project (This thread's project is ${PROJECT_ID}; re-run with --project ${PROJECT_ID})`,
    );

    const envelope = await harness.runCli(["list", "--json"], {
      projectId: PROJECT_ID,
    });
    expect(envelope.exitCode).toBe(1);
    expect(JSON.parse(envelope.stdout ?? "")).toEqual({
      ok: false,
      error: {
        code: "missing_required",
        message: "missing required option --project",
        hint: `This thread's project is ${PROJECT_ID}; re-run with --project ${PROJECT_ID}`,
      },
    });

    await harness.dispose();
  });

  it("keeps a valid script row canonical when its stored file is missing", async () => {
    const { harness } = await bootAutomationsPlugin();
    const createdResult = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Missing script file",
      "--in",
      "1h",
      "--script",
      "echo ok",
      "--json",
    ]);
    const created = automationDetailResponseSchema.parse(
      JSON.parse(createdResult.stdout ?? ""),
    );
    if (
      created.execution.mode !== "script" ||
      created.execution.storedScriptPath === undefined
    ) {
      throw new Error("Expected a stored script fixture");
    }
    await unlink(created.execution.storedScriptPath);

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );
    expect(listed).toContainEqual(
      expect.objectContaining({ id: created.id, name: "Missing script file" }),
    );
    expect(listed[0]).not.toHaveProperty("problem");
    await expect(
      harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    ).rejects.toThrow("Script file was not found");

    await harness.dispose();
  });

  it.each([
    {
      supported: ["accept-edits", "auto", "full"] as const,
      expected: "auto",
    },
    {
      supported: ["accept-edits", "full"] as const,
      expected: "full",
    },
  ])(
    "defaults agent automations to $expected for provider capabilities",
    async ({ supported, expected }) => {
      const { harness } = await bootAutomationsPlugin([...supported]);
      const result = await harness.runCli([
        "create",
        "--project",
        PROJECT_ID,
        "--name",
        `CLI agent ${expected}`,
        "--at",
        new Date(Date.now() + 60_000).toISOString(),
        "--prompt",
        "Summarize the inbox",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      const automation = automationDetailResponseSchema.parse(
        JSON.parse(result.stdout ?? ""),
      );
      expect(automation.execution).toMatchObject({
        mode: "agent",
        permissionMode: expected,
      });
      await harness.dispose();
    },
  );

  it("rejects an explicit mode the automation provider does not support", async () => {
    const { harness } = await bootAutomationsPlugin(["accept-edits", "full"]);
    const result = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Unsupported auto",
      "--at",
      new Date(Date.now() + 60_000).toISOString(),
      "--prompt",
      "Summarize the inbox",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
      "--permission-mode",
      "auto",
    ]);

    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.stderr).toContain(
      "Permission mode auto is not supported by provider codex",
    );
    await harness.dispose();
  });

  it("updates agent execution in place through the CLI without resetting omitted fields", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness, {
      name: "Keep this identity",
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    });

    const environmentUpdate = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "use the new workspace",
      "--permission-mode",
      "auto",
      "--environment",
      "/tmp/design-doctrine",
      "--json",
    ]);
    expect(environmentUpdate.exitCode).toBe(0);
    const environmentTargeted = automationDetailResponseSchema.parse(
      JSON.parse(environmentUpdate.stdout ?? ""),
    );
    expect(environmentTargeted).toMatchObject({
      id: created.id,
      name: "Keep this identity",
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      execution: {
        mode: "agent",
        prompt: "use the new workspace",
        providerId: "codex",
        model: "gpt-5",
        permissionMode: "auto",
        environment: {
          type: "host",
          hostId: "host_test",
          workspace: { type: "unmanaged", path: "/tmp/design-doctrine" },
        },
      },
    });
    expect(environmentTargeted.execution).not.toHaveProperty("targetThreadId");

    const threadTargetUpdate = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--target-thread",
      THREAD_ID,
      "--json",
    ]);
    expect(threadTargetUpdate.exitCode).toBe(0);
    const threadTargeted = automationDetailResponseSchema.parse(
      JSON.parse(threadTargetUpdate.stdout ?? ""),
    );
    expect(threadTargeted.execution).toMatchObject({
      mode: "agent",
      targetThreadId: THREAD_ID,
      environment: {
        type: "host",
        hostId: "host_test",
        workspace: { type: "unmanaged", path: "/tmp/design-doctrine" },
      },
    });

    const worktreeUpdate = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--new-environment",
      "worktree",
      "--base-branch",
      "release",
      "--json",
    ]);
    expect(worktreeUpdate.exitCode).toBe(0);
    const worktreeTargeted = automationDetailResponseSchema.parse(
      JSON.parse(worktreeUpdate.stdout ?? ""),
    );
    expect(worktreeTargeted.execution).toMatchObject({
      mode: "agent",
      providerId: "codex",
      model: "gpt-5",
      prompt: "use the new workspace",
      permissionMode: "auto",
      environment: {
        type: "host",
        hostId: "host_test",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "named", name: "release" },
        },
      },
    });
    expect(worktreeTargeted.execution).not.toHaveProperty("targetThreadId");
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toHaveLength(1);

    await harness.dispose();
  });

  it("accepts a long prompt and keeps the automation readable afterwards", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness);
    const longPrompt = "review every open pull request carefully. ".repeat(250);
    expect(longPrompt.length).toBeGreaterThan(8_000);

    const update = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      longPrompt,
      "--json",
    ]);
    expect(update.exitCode).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(update.stdout ?? ""))
        .execution,
    ).toMatchObject({ mode: "agent", prompt: longPrompt });

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );
    expect(listed).toHaveLength(1);
    expect(automationResponseSchema.parse(listed[0]).execution).toMatchObject({
      prompt: longPrompt,
    });

    const shown = await harness.runCli([
      "show",
      created.id,
      "--project",
      PROJECT_ID,
      "--json",
    ]);
    expect(shown.exitCode).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(shown.stdout ?? ""))
        .execution,
    ).toMatchObject({ prompt: longPrompt });

    const repaired = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: { prompt: "short again" },
      }),
    );
    expect(repaired.execution).toMatchObject({ prompt: "short again" });

    await harness.dispose();
  });

  it("does not persist a CLI create rejected by execution validation", async () => {
    const { harness } = await bootAutomationsPlugin();

    const result = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Invalid empty prompt",
      "--in",
      "1h",
      "--prompt",
      "",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
    ]);

    expect(result.exitCode).toBe(1);
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toHaveLength(0);

    await harness.dispose();
  });

  it("lists degraded rows and repairs a desktop v0.40.0 failed create", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    await createAgentAutomation(harness, { name: "Hidden legacy row" });
    await createAgentAutomation(harness, { name: "Invalid stored row" });
    const healthy = await createAgentAutomation(harness, { name: "Healthy" });
    const database = host.bb.storage.database();
    database
      .prepare("UPDATE automations SET execution = ? WHERE name = ?")
      .run(
        JSON.stringify({ ...agentExecution(), prompt: "" }),
        "Hidden legacy row",
      );
    database
      .prepare("UPDATE automations SET execution = ? WHERE name = ?")
      .run("not json", "Invalid stored row");

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );
    const repairTarget = listed.find(
      (item) => "problem" in item && item.problem === "missing-agent-prompt",
    );
    const invalidTarget = listed.find(
      (item) => "problem" in item && item.problem === "invalid-stored-data",
    );
    expect(repairTarget).toMatchObject({
      name: "Hidden legacy row",
      projectId: PROJECT_ID,
      execution: expect.objectContaining({
        mode: "agent",
        prompt: "",
        providerId: "codex",
        model: "gpt-5",
      }),
    });
    expect(invalidTarget).toMatchObject({ name: "Invalid stored row" });
    expect(listed).toContainEqual(expect.objectContaining({ id: healthy.id }));
    expect(
      automationsOverviewResponseSchema.parse(
        await harness.callRpc("automations_overview"),
      ).automations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ automation: repairTarget }),
        expect.objectContaining({ automation: invalidTarget }),
      ]),
    );

    const cliList = await harness.runCli(["list", "--project", PROJECT_ID]);
    expect(cliList).toMatchObject({ exitCode: 0 });
    expect(cliList.stdout).toContain("Prompt required");
    expect(cliList.stdout).toContain("Invalid data");
    const repairRow = cliList.stdout
      ?.split("\n")
      .find((line) => line.includes("Hidden legacy row"));
    expect(repairRow).toContain("yes");
    expect(repairRow).toContain("once at");
    expect(repairRow).toContain("human");

    if (
      repairTarget === undefined ||
      !("execution" in repairTarget) ||
      invalidTarget === undefined ||
      "execution" in invalidTarget
    ) {
      throw new Error("Expected degraded automation descriptors");
    }
    expect(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: repairTarget.id,
      }),
    ).toEqual(repairTarget);
    expect(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: invalidTarget.id,
      }),
    ).toEqual(invalidTarget);
    const cliShow = await harness.runCli([
      "show",
      repairTarget.id,
      "--project",
      PROJECT_ID,
    ]);
    expect(cliShow).toMatchObject({ exitCode: 0 });
    expect(cliShow.stdout).toContain("Status:    Prompt required");
    expect(cliShow.stdout).toContain("Enabled:   yes");
    expect(cliShow.stdout).toContain("Schedule:  once at");
    expect(cliShow.stdout?.endsWith("\n\n")).toBe(true);
    const rejectedLifecycleWrites = [
      ["automations_run", repairTarget.id, "it can run"],
      ["automations_pause", repairTarget.id, "it can be paused"],
      ["automations_resume", repairTarget.id, "it can be resumed"],
    ] as const;
    for (const [method, automationId, operation] of rejectedLifecycleWrites) {
      await expect(
        harness.callRpc(method, { projectId: PROJECT_ID, automationId }),
      ).rejects.toThrow(
        `Automation "Hidden legacy row" requires a prompt before ${operation}. Edit it and add a prompt first.`,
      );
    }
    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: repairTarget.id,
        name: "Must not be persisted",
      }),
    ).rejects.toThrow(
      'Automation "Hidden legacy row" requires a prompt before other fields can be updated. Edit it and add a prompt first.',
    );
    await expect(
      harness.callRpc("automations_pause", {
        projectId: PROJECT_ID,
        automationId: invalidTarget.id,
      }),
    ).rejects.toThrow(
      'Automation "Invalid stored row" has invalid stored data and cannot be paused. Delete it and recreate it.',
    );
    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: invalidTarget.id,
        name: "Must not be persisted either",
      }),
    ).rejects.toThrow(
      'Automation "Invalid stored row" has invalid stored data and cannot be updated. Delete it and recreate it.',
    );
    expect(
      database
        .prepare("SELECT name, enabled FROM automations WHERE id = ?")
        .get(repairTarget.id),
    ).toEqual({ name: "Hidden legacy row", enabled: 1 });

    const update = await harness.runCli([
      "update",
      repairTarget.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "repaired prompt",
    ]);
    expect(update.exitCode).toBe(0);
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: repairTarget.id,
          execution: expect.objectContaining({ prompt: "repaired prompt" }),
        }),
        invalidTarget,
        expect.objectContaining({ id: healthy.id }),
      ]),
    );
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", {
          projectId: MISSING_PROJECT_ID,
        }),
      ),
    ).toEqual([]);

    await harness.dispose();
  });

  it("preserves valid rows after rejected full and partial updates", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const full = await createAgentAutomation(harness, { name: "Full" });
    const partial = await createAgentAutomation(harness, { name: "Partial" });

    const fullResult = await harness.runCli([
      "update",
      full.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
    ]);
    expect(fullResult.exitCode).toBe(1);

    const service = createAutomationService({
      bb: host.bb as never,
      db: host.bb.storage.database(),
      pluginDataDir: "/tmp/bb-automations-test",
      serverUrl: "http://127.0.0.1:38886",
    });
    await expect(
      service.update(
        {
          projectId: PROJECT_ID,
          automationId: partial.id,
          agent: { prompt: "" },
        } as never,
        {},
      ),
    ).rejects.toThrow();

    for (const automationId of [full.id, partial.id]) {
      const unchanged = automationDetailResponseSchema.parse(
        await harness.callRpc("automations_get", {
          projectId: PROJECT_ID,
          automationId,
        }),
      );
      expect(unchanged.execution).toMatchObject({
        mode: "agent",
        prompt: "summarize the inbox",
      });
    }

    await harness.dispose();
  });

  it("rejects conflicting targets and invalid permission modes before updating", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness);

    const conflictingTargets = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--target-thread",
      THREAD_ID,
      "--environment",
      "/tmp/design-doctrine",
    ]);
    expect(conflictingTargets.exitCode).toBe(1);
    expect(conflictingTargets.stderr).toContain(
      "Cannot combine target options",
    );

    const invalidPermissionMode = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--permission-mode",
      "write",
    ]);
    expect(invalidPermissionMode.exitCode).toBe(1);
    expect(invalidPermissionMode.stderr).toContain(
      "invalid value 'write' for --permission-mode. Expected one of: accept-edits, auto, full",
    );

    await harness.dispose();
  });

  it("patches agent execution through RPC while preserving its environment", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness);

    const updated = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: {
          prompt: "updated by RPC",
          providerId: "claude",
          model: "claude-opus-5",
          reasoningLevel: "ultra",
          serviceTier: "fast",
          permissionMode: "full",
          target: { type: "target-thread", threadId: THREAD_ID },
        },
      }),
    );
    expect(updated).toMatchObject({
      id: created.id,
      execution: {
        mode: "agent",
        prompt: "updated by RPC",
        providerId: "claude",
        model: "claude-opus-5",
        reasoningLevel: "ultra",
        serviceTier: "fast",
        permissionMode: "full",
        environment: { type: "project-default" },
        targetThreadId: THREAD_ID,
      },
    });

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: { permissionMode: "write" },
      }),
    ).rejects.toThrow();

    await harness.dispose();
  });

  it("rejects unsupported partial permission updates through RPC and CLI", async () => {
    const { harness } = await bootAutomationsPlugin(["accept-edits", "full"]);
    const created = await createAgentAutomation(harness);

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        execution: {
          ...agentExecution(),
          permissionMode: "auto",
        },
      }),
    ).rejects.toThrow(
      "Permission mode auto is not supported by provider codex.",
    );

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: { permissionMode: "auto" },
      }),
    ).rejects.toThrow(
      "Permission mode auto is not supported by provider codex.",
    );

    const cliResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--permission-mode",
      "auto",
    ]);
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stderr).toContain(
      "Permission mode auto is not supported by provider codex.",
    );

    const unchanged = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );
    expect(unchanged.execution).toMatchObject({
      mode: "agent",
      permissionMode: "accept-edits",
    });

    await harness.dispose();
  });

  it("validates permission updates against the automation target environment", async () => {
    const { harness } = await bootAutomationsPlugin(["accept-edits"], ["full"]);
    const created = await createAgentAutomation(harness);

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: {
          permissionMode: "full",
          target: {
            type: "environment",
            environment: {
              type: "reuse",
              environmentId: "env_routed",
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      execution: {
        mode: "agent",
        permissionMode: "full",
        environment: { type: "reuse", environmentId: "env_routed" },
      },
    });

    await harness.dispose();
  });

  it("dedupes manual runs through RPC idempotency keys", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAgentAutomation(harness);

    const first = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
        idempotencyKey: "same-key",
      }),
    );
    const second = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
        idempotencyKey: "same-key",
      }),
    );
    expect(second.run.id).toBe(first.run.id);
    expect(
      automationRunListResponseSchema.parse(
        await harness.callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId: automation.id,
        }),
      ).runs,
    ).toHaveLength(1);

    await harness.dispose();
  });

  it("settles a run orphaned by a restart when the replacement plugin starts", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const automation = await createAgentAutomation(harness);
    const started = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );
    expect(started.run.status).toBe("running");

    const reloaded = await harness.reload(
      plugin as unknown as Parameters<typeof harness.reload>[0],
    );
    const service = reloaded.harness.runService("automation-sweep");
    await vi.waitFor(async () => {
      const runs = automationRunListResponseSchema.parse(
        await reloaded.harness.callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId: automation.id,
        }),
      ).runs;
      expect(runs[0]).toMatchObject({
        id: started.run.id,
        status: "succeeded",
      });
    });
    service.controller.abort();
    await service.done;
    const next = automationRunRpcResponseSchema.parse(
      await reloaded.harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );
    expect(next.run.id).not.toBe(started.run.id);
    expect(next.run.status).toBe("running");

    await reloaded.harness.dispose();
  });

  it("discovers a late-enrolled server host before dispatching a project script", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const source = project();
    source.sources[0]!.path = dirname(host.bb.storage.database().name);
    harness.sdk.stub("projects.get", async () => source);
    const created = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Late enrollment",
      "--in",
      "1m",
      "--script",
      "printf 'late enrollment OK'",
      "--interpreter",
      "sh",
      "--working-directory",
      "project",
      "--json",
    ]);
    expect(created.exitCode).toBe(0);
    const automation = automationDetailResponseSchema.parse(
      JSON.parse(created.stdout!),
    );
    let primaryHostId: string | null = null;
    harness.sdk.stub("system.config", () => ({ primaryHostId }));
    const initialCalls = harness.sdk.callsTo("system.config").length;
    const service = harness.runService("automation-sweep");
    try {
      await vi.waitFor(() =>
        expect(harness.sdk.callsTo("system.config")).toHaveLength(
          initialCalls + 1,
        ),
      );
      primaryHostId = "host_fake";
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () => {
        const { runs } = automationRunListResponseSchema.parse(
          await harness.callRpc("automations_runs", {
            projectId: PROJECT_ID,
            automationId: automation.id,
          }),
        );
        expect(runs[0]).toMatchObject({
          status: "succeeded",
          output: expect.stringMatching(/(?:^|\n)late enrollment OK$/),
          exitCode: 0,
          error: null,
        });
      });
      const calls = harness.sdk.callsTo("system.config").length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.sdk.callsTo("system.config")).toHaveLength(calls);
    } finally {
      service.controller.abort();
      await service.done;
      await harness.dispose();
    }
  });

  it("dispatches a due agent automation from one sweep tick and closes it from thread.idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const automation = await createAgentAutomation(harness, {
      name: "Sweep",
      trigger: { triggerType: "schedule", cron: "* * * * *", timezone: "UTC" },
    });

    vi.setSystemTime(new Date("2026-01-01T00:01:05.000Z"));
    const service = harness.runService("automation-sweep");
    await vi.waitFor(() =>
      expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1),
    );
    service.controller.abort();
    await service.done;

    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      prompt: `[bb automation due:${automation.id}]\n\nsummarize the inbox`,
      title: "Sweep",
      origin: "plugin",
      originPluginId: "automations",
    });
    const runningRuns = automationRunListResponseSchema.parse(
      await harness.callRpc("automations_runs", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    ).runs;
    expect(runningRuns).toHaveLength(1);
    expect(runningRuns[0]).toMatchObject({
      automationId: automation.id,
      status: "running",
      threadId: "thr_spawned",
      trigger: "schedule",
    });

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_spawned", projectId: PROJECT_ID }),
      lastAssistantText: null,
    });
    const closedRuns = automationRunListResponseSchema.parse(
      await harness.callRpc("automations_runs", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    ).runs;
    expect(closedRuns[0]).toMatchObject({
      status: "succeeded",
      threadId: "thr_spawned",
    });
    expect(signalKinds(host)).toEqual(
      expect.arrayContaining([
        "automations-changed",
        "automation-runs-changed",
      ]),
    );

    await harness.dispose();
  });

  it("disables automations targeting a deleted thread", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAgentAutomation(harness, {
      name: "Thread target",
      targetThreadId: THREAD_ID,
    });

    await harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        deletedAt: Date.now(),
      }),
    });

    const disabled = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );
    expect(disabled).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastError: "target thread deleted",
    });

    await harness.dispose();
  });

  it("dispose aborts the sweep service and poisons stale bb handles", async () => {
    const { bb, harness } = await bootAutomationsPlugin();
    const service = harness.runService("automation-sweep");

    await harness.dispose();
    await service.done;
    await expect(bb.storage.kv.get("after-dispose")).rejects.toThrow(
      PluginContextStaleError,
    );
  });
  describe("script automations require an admin", () => {
    const MEMBER = { experimental_callerRole: "member" } as const;

    function scriptExecution() {
      return { mode: "script", script: "env", interpreter: "bash" };
    }

    async function createScriptAutomationAsAdmin(
      harness: FakePluginHost["harness"],
    ) {
      const result = await harness.runCli([
        "create",
        "--project",
        PROJECT_ID,
        "--name",
        "Admin script",
        "--in",
        "1h",
        "--script",
        "echo ok",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      return automationDetailResponseSchema.parse(
        JSON.parse(result.stdout ?? ""),
      );
    }

    it("refuses member RPC create, update, and run of script automations", async () => {
      const { harness } = await bootAutomationsPlugin();
      const agent = await createAgentAutomation(harness);
      const script = await createScriptAutomationAsAdmin(harness);

      await expect(
        harness.callRpc(
          "automations_create",
          {
            projectId: PROJECT_ID,
            name: "Member script",
            enabled: true,
            trigger: oneShotTrigger(),
            execution: scriptExecution(),
            origin: "human",
          },
          MEMBER,
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Script automations require an admin"),
      });
      await expect(
        harness.callRpc(
          "automations_update",
          {
            projectId: PROJECT_ID,
            automationId: agent.id,
            execution: scriptExecution(),
          },
          MEMBER,
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Script automations require an admin"),
      });
      await expect(
        harness.callRpc(
          "automations_update",
          {
            projectId: PROJECT_ID,
            automationId: script.id,
            script: { workingDirectory: { type: "automation-storage" } },
          },
          MEMBER,
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Script automations require an admin"),
      });
      await expect(
        harness.callRpc(
          "automations_update",
          { projectId: PROJECT_ID, automationId: script.id, name: "Renamed" },
          MEMBER,
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Script automations require an admin"),
      });
      await expect(
        harness.callRpc(
          "automations_run",
          { projectId: PROJECT_ID, automationId: script.id },
          MEMBER,
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Script automations require an admin"),
      });
      for (const method of [
        "automations_create_script",
        "automations_update_script",
        "automations_run_script",
      ] as const) {
        await expect(
          harness.callRpc(
            method,
            { projectId: PROJECT_ID, automationId: script.id },
            MEMBER,
          ),
        ).rejects.toThrow("requires a server admin");
      }

      const listed = automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      );
      expect(listed.map((automation) => automation.name).sort()).toEqual([
        "Admin script",
        "Agent automation",
      ]);
      expect(
        automationRunListResponseSchema.parse(
          await harness.callRpc("automations_runs", {
            projectId: PROJECT_ID,
            automationId: script.id,
          }),
        ).runs,
      ).toHaveLength(0);

      await harness.dispose();
    });

    it("keeps agent automations available to member RPC callers", async () => {
      const { harness } = await bootAutomationsPlugin();
      const created = automationDetailResponseSchema.parse(
        await harness.callRpc(
          "automations_create",
          {
            projectId: PROJECT_ID,
            name: "Member agent",
            enabled: true,
            trigger: oneShotTrigger(),
            execution: agentExecution(),
            origin: "human",
          },
          MEMBER,
        ),
      );
      await expect(
        harness.callRpc(
          "automations_update",
          {
            projectId: PROJECT_ID,
            automationId: created.id,
            agent: { prompt: "updated by member" },
          },
          MEMBER,
        ),
      ).resolves.toMatchObject({
        execution: { mode: "agent", prompt: "updated by member" },
      });
      await expect(
        harness.callRpc(
          "automations_run",
          { projectId: PROJECT_ID, automationId: created.id },
          MEMBER,
        ),
      ).resolves.toMatchObject({ run: { status: "running" } });

      await harness.dispose();
    });

    it("lets admins create, update, and run script automations through the script RPC methods", async () => {
      const { harness } = await bootAutomationsPlugin();
      const agent = await createAgentAutomation(harness);

      const created = automationDetailResponseSchema.parse(
        await harness.callRpc("automations_create_script", {
          projectId: PROJECT_ID,
          name: "Admin RPC script",
          enabled: true,
          trigger: oneShotTrigger(),
          execution: scriptExecution(),
          origin: "human",
        }),
      );
      expect(created.execution).toMatchObject({ mode: "script" });
      await expect(
        harness.callRpc("automations_update_script", {
          projectId: PROJECT_ID,
          automationId: agent.id,
          execution: scriptExecution(),
        }),
      ).resolves.toMatchObject({ execution: { mode: "script" } });
      await expect(
        harness.callRpc("automations_update_script", {
          projectId: PROJECT_ID,
          automationId: created.id,
          name: "Renamed admin script",
        }),
      ).resolves.toMatchObject({ name: "Renamed admin script" });
      await expect(
        harness.callRpc("automations_run_script", {
          projectId: PROJECT_ID,
          automationId: created.id,
        }),
      ).resolves.toMatchObject({ run: { status: "running" } });
      await vi.waitFor(async () => {
        const runs = automationRunListResponseSchema.parse(
          await harness.callRpc("automations_runs", {
            projectId: PROJECT_ID,
            automationId: created.id,
          }),
        ).runs;
        expect(runs[0]?.status).not.toBe("running");
      });

      await harness.dispose();
    });

    it("refuses member CLI create, update, and run of script automations", async () => {
      const { harness } = await bootAutomationsPlugin();
      const agent = await createAgentAutomation(harness);
      const script = await createScriptAutomationAsAdmin(harness);

      const attempts = [
        [
          "create",
          "--project",
          PROJECT_ID,
          "--name",
          "Member script",
          "--in",
          "1h",
          "--script",
          "env",
        ],
        [
          "create",
          "--project",
          PROJECT_ID,
          "--name",
          "Member file script",
          "--in",
          "1h",
          "--script-file",
          "/etc/hosts",
        ],
        ["update", agent.id, "--project", PROJECT_ID, "--script", "env"],
        ["update", script.id, "--project", PROJECT_ID, "--name", "Renamed"],
        ["run", script.id, "--project", PROJECT_ID],
      ];
      for (const argv of attempts) {
        const result = await harness.runCli(argv, MEMBER);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("requires a server admin");
      }
      const refusedJson = await harness.runCli(
        ["run", script.id, "--project", PROJECT_ID, "--json"],
        MEMBER,
      );
      expect(refusedJson.exitCode).toBe(1);
      expect(JSON.parse(refusedJson.stdout ?? "")).toMatchObject({
        ok: false,
        error: { code: "admin_required" },
      });

      const listed = automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      );
      expect(listed.map((automation) => automation.name).sort()).toEqual([
        "Admin script",
        "Agent automation",
      ]);

      const help = await harness.runCli(["create", "--help"], MEMBER);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("--script");

      await harness.dispose();
    });

    it("keeps agent automations available to member CLI callers", async () => {
      const { harness } = await bootAutomationsPlugin();
      const created = await harness.runCli(
        [
          "create",
          "--project",
          PROJECT_ID,
          "--name",
          "Member agent",
          "--in",
          "1h",
          "--prompt",
          "summarize",
          "--provider",
          "codex",
          "--model",
          "gpt-5",
          "--json",
        ],
        MEMBER,
      );
      expect(created.exitCode).toBe(0);
      const automation = automationDetailResponseSchema.parse(
        JSON.parse(created.stdout ?? ""),
      );
      const updated = await harness.runCli(
        [
          "update",
          automation.id,
          "--project",
          PROJECT_ID,
          "--prompt",
          "updated",
        ],
        MEMBER,
      );
      expect(updated.exitCode).toBe(0);
      const run = await harness.runCli(
        ["run", automation.id, "--project", PROJECT_ID],
        MEMBER,
      );
      expect(run.exitCode).toBe(0);

      await harness.dispose();
    });

    it("refuses member pause and resume of script automations and leaves the schedule unchanged", async () => {
      const { harness } = await bootAutomationsPlugin();
      const pausedScript = await createScriptAutomationAsAdmin(harness);
      const paused = await harness.runCli([
        "pause",
        pausedScript.id,
        "--project",
        PROJECT_ID,
      ]);
      expect(paused.exitCode).toBe(0);
      const activeScript = await createScriptAutomationAsAdmin(harness);
      const readAutomation = async (automationId: string) =>
        automationDetailResponseSchema.parse(
          await harness.callRpc("automations_get", {
            projectId: PROJECT_ID,
            automationId,
          }),
        );
      const pausedBefore = await readAutomation(pausedScript.id);
      const activeBefore = await readAutomation(activeScript.id);
      expect(pausedBefore).toMatchObject({ enabled: false, nextRunAt: null });
      expect(activeBefore.enabled).toBe(true);

      await expect(
        harness.callRpc(
          "automations_resume",
          { projectId: PROJECT_ID, automationId: pausedScript.id },
          MEMBER,
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Script automations require an admin"),
      });
      await expect(
        harness.callRpc(
          "automations_pause",
          { projectId: PROJECT_ID, automationId: activeScript.id },
          MEMBER,
        ),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Script automations require an admin"),
      });
      for (const [method, automationId] of [
        ["automations_resume_script", pausedScript.id],
        ["automations_pause_script", activeScript.id],
      ] as const) {
        await expect(
          harness.callRpc(
            method,
            { projectId: PROJECT_ID, automationId },
            MEMBER,
          ),
        ).rejects.toThrow("requires a server admin");
      }
      for (const argv of [
        ["resume", pausedScript.id, "--project", PROJECT_ID],
        ["pause", activeScript.id, "--project", PROJECT_ID],
      ]) {
        const result = await harness.runCli(argv, MEMBER);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("requires a server admin");
      }

      const pausedAfter = await readAutomation(pausedScript.id);
      expect(pausedAfter.enabled).toBe(false);
      expect(pausedAfter.nextRunAt).toBe(pausedBefore.nextRunAt);
      const activeAfter = await readAutomation(activeScript.id);
      expect(activeAfter.enabled).toBe(true);
      expect(activeAfter.nextRunAt).toBe(activeBefore.nextRunAt);
      for (const automationId of [pausedScript.id, activeScript.id]) {
        expect(
          automationRunListResponseSchema.parse(
            await harness.callRpc("automations_runs", {
              projectId: PROJECT_ID,
              automationId,
            }),
          ).runs,
        ).toHaveLength(0);
      }

      for (const command of ["pause", "resume"]) {
        const help = await harness.runCli([command, "--help"], MEMBER);
        expect(help.exitCode).toBe(0);
        expect(help.stdout).toContain("--project");
      }

      await harness.dispose();
    });

    it("lets admins pause and resume script automations over RPC and CLI", async () => {
      const { harness } = await bootAutomationsPlugin();
      const script = await createScriptAutomationAsAdmin(harness);
      const target = { projectId: PROJECT_ID, automationId: script.id };

      await expect(
        harness.callRpc("automations_pause_script", target),
      ).resolves.toMatchObject({ enabled: false, nextRunAt: null });
      const resumed = automationResponseSchema.parse(
        await harness.callRpc("automations_resume_script", target),
      );
      expect(resumed.enabled).toBe(true);
      expect(resumed.nextRunAt).toBe(script.nextRunAt);

      const pausedCli = await harness.runCli([
        "pause",
        script.id,
        "--project",
        PROJECT_ID,
      ]);
      expect(pausedCli.exitCode).toBe(0);
      const resumedCli = await harness.runCli([
        "resume",
        script.id,
        "--project",
        PROJECT_ID,
        "--json",
      ]);
      expect(resumedCli.exitCode).toBe(0);
      expect(
        automationResponseSchema.parse(JSON.parse(resumedCli.stdout ?? ""))
          .enabled,
      ).toBe(true);

      await harness.dispose();
    });

    it("keeps pause and resume of agent automations available to members", async () => {
      const { harness } = await bootAutomationsPlugin();
      const agent = await createAgentAutomation(harness);
      const target = { projectId: PROJECT_ID, automationId: agent.id };

      await expect(
        harness.callRpc("automations_pause", target, MEMBER),
      ).resolves.toMatchObject({ enabled: false });
      await expect(
        harness.callRpc("automations_resume", target, MEMBER),
      ).resolves.toMatchObject({ enabled: true });
      for (const command of ["pause", "resume"]) {
        const result = await harness.runCli(
          [command, agent.id, "--project", PROJECT_ID],
          MEMBER,
        );
        expect(result.exitCode).toBe(0);
      }

      await harness.dispose();
    });
  });
});

describe("automations run as the person who saved them", () => {
  const MEMBER_CALLER = {
    kind: "client",
    userId: "usr_member",
    role: "member",
    roleCeiling: null,
    effectiveRole: "member",
  } as const;
  const ADMIN_CALLER = {
    kind: "client",
    userId: "usr_admin",
    role: "admin",
    roleCeiling: null,
    effectiveRole: "admin",
  } as const;

  async function createAs(
    harness: FakePluginHost["harness"],
    caller:
      | typeof MEMBER_CALLER
      | typeof ADMIN_CALLER
      | { readonly kind: "system" },
    name = "Nightly triage",
  ) {
    return automationDetailResponseSchema.parse(
      await harness.callRpc(
        "automations_create",
        {
          projectId: PROJECT_ID,
          name,
          enabled: true,
          trigger: oneShotTrigger(),
          execution: agentExecution(),
          origin: "human",
        },
        { experimental_caller: caller },
      ),
    );
  }

  async function runNow(
    harness: FakePluginHost["harness"],
    automationId: string,
  ) {
    const started = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId,
      }),
    );
    let settled: unknown;
    await vi.waitFor(async () => {
      const { runs } = automationRunListResponseSchema.parse(
        await harness.callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId,
        }),
      );
      const run = runs.find((entry) => entry.id === started.run.id);
      expect(run?.threadId ?? run?.error ?? null).not.toBeNull();
      settled = run;
    });
    return settled;
  }

  it("records the creator's grant and spawns scheduled and manual runs through it", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const automation = await createAs(harness, MEMBER_CALLER);

    expect(automation.runsAsCreator).toBe(true);
    const [grant] = harness.experimental_callerGrants;
    expect(harness.experimental_callerGrants).toEqual([
      expect.objectContaining({
        pluginId: "automations",
        userId: "usr_member",
        maxRole: "member",
        purpose: 'Automation "Nightly triage"',
        expiresAt: null,
      }),
    ]);

    await sweepDueAutomations(host.bb as never, host.bb.storage.database(), {
      pluginDataDir: "/tmp/bb-automations-grant-test",
      serverUrl: "http://127.0.0.1:38886",
      serverHostId: "host_fake",
      now: Date.now() + 120_000,
    });
    const manual = await createAs(harness, MEMBER_CALLER, "Manual triage");
    const manualGrant = harness.experimental_callerGrants[1];
    await runNow(harness, manual.id);

    const spawns = harness.sdk.calls.filter(
      (call) => call.path === "threads.spawn",
    );
    expect(spawns).toHaveLength(2);
    expect(spawns).toEqual([
      expect.objectContaining({
        experimental_grantId: grant!.grantId,
        experimental_caller: expect.objectContaining({ userId: "usr_member" }),
      }),
      expect.objectContaining({
        experimental_grantId: manualGrant!.grantId,
        experimental_caller: expect.objectContaining({ userId: "usr_member" }),
      }),
    ]);
    await harness.dispose();
  });

  async function updateAs(
    harness: FakePluginHost["harness"],
    caller:
      | typeof MEMBER_CALLER
      | typeof ADMIN_CALLER
      | { readonly kind: "system" },
    input: Record<string, unknown>,
  ) {
    return automationDetailResponseSchema.parse(
      await harness.callRpc(
        "automations_update",
        { projectId: PROJECT_ID, ...input },
        { experimental_caller: caller },
      ),
    );
  }

  async function adoptAs(
    harness: FakePluginHost["harness"],
    caller: typeof MEMBER_CALLER | typeof ADMIN_CALLER,
    automationId: string,
    expectedRevision: number,
  ) {
    return automationDetailResponseSchema.parse(
      await harness.callRpc(
        "automations_adopt",
        { projectId: PROJECT_ID, automationId, expectedRevision },
        { experimental_caller: caller },
      ),
    );
  }

  async function readAutomation(
    harness: FakePluginHost["harness"],
    automationId: string,
  ) {
    return automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId,
      }),
    );
  }

  function spawnsThrough(harness: FakePluginHost["harness"]) {
    return harness.sdk.calls
      .filter((call) => call.path === "threads.spawn")
      .map((call) => ({
        grantId: call.experimental_grantId,
        userId:
          call.experimental_caller?.kind === "client"
            ? call.experimental_caller.userId
            : null,
        prompt: (call.args[0] as { prompt?: string }).prompt,
      }));
  }

  it("keeps the member's grant when an admin renames or reschedules it, so the run stays the member's", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAs(harness, MEMBER_CALLER);
    const [memberGrant] = harness.experimental_callerGrants;
    expect(automation).toMatchObject({
      runsAsCreator: true,
      runsAsUserId: "usr_member",
      executionRevision: 1,
    });

    const renamed = await updateAs(harness, ADMIN_CALLER, {
      automationId: automation.id,
      name: "Renamed by admin",
      trigger: {
        triggerType: "schedule",
        cron: "0 9 * * *",
        timezone: "UTC",
      },
    });
    const unchanged = await updateAs(harness, ADMIN_CALLER, {
      automationId: automation.id,
      agent: {
        prompt: "summarize the inbox",
        providerId: "codex",
        model: "gpt-5",
        permissionMode: "accept-edits",
      },
    });

    expect(harness.experimental_callerGrants).toEqual([memberGrant]);
    for (const saved of [renamed, unchanged]) {
      expect(saved).toMatchObject({
        name: "Renamed by admin",
        runsAsUserId: "usr_member",
        executionRevision: 1,
      });
    }
    await runNow(harness, automation.id);
    expect(spawnsThrough(harness)).toEqual([
      {
        grantId: memberGrant!.grantId,
        userId: "usr_member",
        prompt: expect.stringContaining("summarize the inbox"),
      },
    ]);
    expect(memberGrant).toMatchObject({ maxRole: "member" });
    await harness.dispose();
  });

  it("refuses an admin's execution change to a member's automation unless the admin adopts it", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAs(harness, MEMBER_CALLER);
    const [memberGrant] = harness.experimental_callerGrants;

    for (const change of [
      { agent: { prompt: "summarize the outbox" } },
      { agent: { model: "gpt-5-pro" } },
      { agent: { permissionMode: "full" } },
      { agent: { target: { type: "target-thread", threadId: THREAD_ID } } },
      {
        execution: { ...agentExecution(), prompt: "summarize the outbox" },
      },
    ]) {
      await expect(
        updateAs(harness, ADMIN_CALLER, {
          automationId: automation.id,
          name: "Sneaky rename",
          ...change,
        }),
      ).rejects.toThrow("automation_adoption_required");
    }

    expect(harness.experimental_callerGrants).toEqual([memberGrant]);
    expect(await readAutomation(harness, automation.id)).toMatchObject({
      name: "Nightly triage",
      runsAsUserId: "usr_member",
      executionRevision: 1,
      execution: { prompt: "summarize the inbox", model: "gpt-5" },
    });

    await expect(
      updateAs(harness, ADMIN_CALLER, {
        automationId: automation.id,
        agent: { prompt: "summarize the outbox" },
        adopt: { expectedRevision: 2 },
      }),
    ).rejects.toThrow("automation_revision_stale");
    expect(harness.experimental_callerGrants).toEqual([memberGrant]);

    const adopted = await updateAs(harness, ADMIN_CALLER, {
      automationId: automation.id,
      agent: { prompt: "summarize the outbox" },
      adopt: { expectedRevision: 1 },
    });
    expect(adopted).toMatchObject({
      runsAsUserId: "usr_admin",
      executionRevision: 2,
      execution: { prompt: "summarize the outbox" },
    });
    expect(harness.experimental_callerGrants).toEqual([
      expect.objectContaining({ userId: "usr_admin", maxRole: "admin" }),
    ]);
    await harness.dispose();
  });

  it("adopts only the execution revision the adopter saw", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAs(harness, MEMBER_CALLER);
    const [memberGrant] = harness.experimental_callerGrants;

    await expect(
      adoptAs(harness, ADMIN_CALLER, automation.id, 7),
    ).rejects.toThrow("automation_revision_stale");
    expect(harness.experimental_callerGrants).toEqual([memberGrant]);

    const shown = await readAutomation(harness, automation.id);
    await updateAs(harness, MEMBER_CALLER, {
      automationId: automation.id,
      agent: { prompt: "delete every branch" },
    });
    const [memberRegrant] = harness.experimental_callerGrants;
    await expect(
      adoptAs(harness, ADMIN_CALLER, automation.id, shown.executionRevision),
    ).rejects.toThrow("automation_revision_stale");
    expect(harness.experimental_callerGrants).toEqual([memberRegrant]);
    expect(memberRegrant).toMatchObject({ userId: "usr_member" });

    const current = await readAutomation(harness, automation.id);
    const adopted = await adoptAs(
      harness,
      ADMIN_CALLER,
      automation.id,
      current.executionRevision,
    );
    expect(adopted).toMatchObject({
      runsAsUserId: "usr_admin",
      executionRevision: current.executionRevision,
      execution: { prompt: "delete every branch" },
    });
    const [adminGrant] = harness.experimental_callerGrants;
    expect(harness.experimental_callerGrants).toEqual([
      expect.objectContaining({
        userId: "usr_admin",
        maxRole: "admin",
        purpose: 'Automation "Nightly triage"',
      }),
    ]);
    await runNow(harness, automation.id);
    expect(spawnsThrough(harness)).toEqual([
      {
        grantId: adminGrant!.grantId,
        userId: "usr_admin",
        prompt: expect.stringContaining("delete every branch"),
      },
    ]);
    await harness.dispose();
  });

  it("fails an adoption when a member edit lands while the adopter's grant is being created", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const automation = await createAs(harness, MEMBER_CALLER);
    const sdk = host.bb.sdk;
    const revoked: string[] = [];
    const racing = createAutomationService({
      bb: {
        log: host.bb.log,
        realtime: host.bb.realtime,
        sdk: {
          system: sdk.system,
          projects: sdk.projects,
          providers: sdk.providers,
          threads: sdk.threads,
          experimental_asGrant: (grantId) => sdk.experimental_asGrant(grantId),
          async experimental_createCallerGrant() {
            await updateAs(harness, MEMBER_CALLER, {
              automationId: automation.id,
              agent: { prompt: "exfiltrate secrets" },
            });
            return { grantId: "grant_admin_race" };
          },
          async experimental_revokeCallerGrant(grantId) {
            revoked.push(grantId);
          },
        },
      },
      db: host.bb.storage.database(),
      pluginDataDir: "/tmp/bb-automations-adopt-race",
      serverUrl: "http://127.0.0.1:38886",
    });

    await expect(
      racing.adopt(
        {
          projectId: PROJECT_ID,
          automationId: automation.id,
          expectedRevision: 1,
        },
        { experimental_caller: ADMIN_CALLER },
      ),
    ).rejects.toThrow("automation_revision_stale");
    expect(revoked).toEqual(["grant_admin_race"]);
    expect(harness.experimental_callerGrants).toEqual([
      expect.objectContaining({ userId: "usr_member" }),
    ]);
    expect(await readAutomation(harness, automation.id)).toMatchObject({
      runsAsUserId: "usr_member",
      executionRevision: 2,
      execution: { prompt: "exfiltrate secrets" },
    });
    await harness.dispose();
  });

  it("re-grants the owner's own execution changes without adoption", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAs(harness, MEMBER_CALLER);
    const [firstGrant] = harness.experimental_callerGrants;

    const updated = await updateAs(harness, MEMBER_CALLER, {
      automationId: automation.id,
      agent: { prompt: "summarize the outbox" },
    });

    expect(updated).toMatchObject({
      runsAsUserId: "usr_member",
      executionRevision: 2,
    });
    expect(harness.experimental_callerGrants).toEqual([
      expect.objectContaining({ userId: "usr_member", maxRole: "member" }),
    ]);
    expect(harness.experimental_callerGrants[0]!.grantId).not.toBe(
      firstGrant!.grantId,
    );
    await harness.dispose();
  });

  it("keeps local mode's owner editing without adoption", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAgentAutomation(harness);
    const result = await harness.runCli([
      "update",
      automation.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "summarize the outbox",
      "--json",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(result.stdout!)),
    ).toMatchObject({
      runsAsUserId: "usr_local_owner",
      executionRevision: 2,
      execution: { prompt: "summarize the outbox" },
    });
    expect(harness.experimental_callerGrants).toEqual([
      expect.objectContaining({ userId: "usr_local_owner" }),
    ]);
    await harness.dispose();
  });

  it("revokes the person's grant when a plugin or bb changes the execution, and keeps it for a rename", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAs(harness, MEMBER_CALLER);
    const [memberGrant] = harness.experimental_callerGrants;

    await updateAs(
      harness,
      { kind: "system" },
      {
        automationId: automation.id,
        name: "Renamed",
      },
    );
    expect(harness.experimental_callerGrants).toEqual([memberGrant]);

    const changed = await updateAs(
      harness,
      { kind: "system" },
      {
        automationId: automation.id,
        agent: { prompt: "summarize the outbox" },
      },
    );
    expect(changed).toMatchObject({
      runsAsCreator: false,
      runsAsUserId: null,
      executionRevision: 2,
    });
    expect(harness.experimental_callerGrants).toEqual([]);

    await expect(
      updateAs(harness, MEMBER_CALLER, {
        automationId: automation.id,
        agent: { prompt: "summarize the inbox" },
      }),
    ).rejects.toThrow("automation_adoption_required");

    await harness.callRpc("automations_delete", {
      projectId: PROJECT_ID,
      automationId: automation.id,
    });
    expect(harness.experimental_callerGrants).toEqual([]);
    await harness.dispose();
  });

  it("shows who an automation runs as and adopts it from the CLI", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAs(harness, MEMBER_CALLER);
    const asAdmin = { experimental_caller: ADMIN_CALLER } as const;

    const shown = await harness.runCli(
      ["show", automation.id, "--project", PROJECT_ID],
      asAdmin,
    );
    expect(shown.stdout).toContain("Runs as:   usr_member");
    expect(shown.stdout).toContain("Revision:  1");

    const refused = await harness.runCli(
      [
        "update",
        automation.id,
        "--project",
        PROJECT_ID,
        "--prompt",
        "summarize the outbox",
      ],
      asAdmin,
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("automation_adoption_required");

    const preview = await harness.runCli(
      ["adopt", automation.id, "--project", PROJECT_ID],
      asAdmin,
    );
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("summarize the inbox");
    expect(preview.stdout).toContain("will run as you");
    expect(preview.stdout).toContain("--revision 1");
    expect(harness.experimental_callerGrants).toEqual([
      expect.objectContaining({ userId: "usr_member" }),
    ]);

    const adopted = await harness.runCli(
      ["adopt", automation.id, "--project", PROJECT_ID, "--revision", "1"],
      asAdmin,
    );
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain("Runs as:   you (usr_admin)");
    expect(harness.experimental_callerGrants).toEqual([
      expect.objectContaining({ userId: "usr_admin" }),
    ]);

    const updated = await harness.runCli(
      [
        "update",
        automation.id,
        "--project",
        PROJECT_ID,
        "--prompt",
        "summarize the outbox",
        "--adopt-revision",
        "1",
      ],
      asAdmin,
    );
    expect(updated.exitCode, updated.stderr).toBe(0);
    await harness.dispose();
  });

  it("fails a run whose grant was revoked instead of running without the person", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAs(harness, MEMBER_CALLER);
    harness.experimental_revokeCallerGrant(
      harness.experimental_callerGrants[0]!.grantId,
    );

    expect(await runNow(harness, automation.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("does not exist or was revoked"),
    });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    await harness.dispose();
  });

  it("keeps running an automation without a grant as the plugin and says so", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAs(harness, { kind: "system" });

    expect(automation.runsAsCreator).toBe(false);
    expect(harness.experimental_callerGrants).toEqual([]);
    await runNow(harness, automation.id);
    const [spawn] = harness.sdk.calls.filter(
      (call) => call.path === "threads.spawn",
    );
    expect(spawn).toBeDefined();
    expect(spawn).not.toHaveProperty("experimental_caller");

    const shown = await harness.runCli([
      "show",
      automation.id,
      "--project",
      PROJECT_ID,
    ]);
    expect(shown.stdout).toContain(
      "Note:      Runs without a user identity until someone adopts it",
    );

    const renamed = await harness.runCli([
      "update",
      automation.id,
      "--project",
      PROJECT_ID,
      "--name",
      "Re-saved",
      "--json",
    ]);
    expect(renamed.exitCode).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(renamed.stdout!))
        .runsAsCreator,
    ).toBe(false);

    const adopted = await harness.runCli([
      "adopt",
      automation.id,
      "--project",
      PROJECT_ID,
      "--revision",
      "1",
      "--json",
    ]);
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(adopted.stdout!)),
    ).toMatchObject({ runsAsCreator: true, runsAsUserId: "usr_local_owner" });
    await harness.dispose();
  });
});
