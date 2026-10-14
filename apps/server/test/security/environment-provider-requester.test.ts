import { LOCAL_OWNER_USER_ID, type RoleCeiling } from "@bb/domain";
import type { PluginEnvironmentProviderRequester } from "@get-bb/plugin-sdk/environment-provider";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { invokePluginInline } from "../../src/services/plugins/plugin-hook-registry.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { clearAllThreadProvisionSchedules } from "../../src/services/threads/thread-startup-store.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PLUGIN_ID = "sandbox";
const PROVIDER_ID = "requester-probe";

afterEach(() => {
  clearAllThreadProvisionSchedules();
  setPluginEnvironmentProviderBridge(undefined);
});

function installRequesterProbe(): (PluginEnvironmentProviderRequester | null)[] {
  const requesters: (PluginEnvironmentProviderRequester | null)[] = [];
  const record = {
    pluginId: PLUGIN_ID,
    provider: validatePluginEnvironmentProviderDeclaration({
      id: PROVIDER_ID,
      displayName: "Requester probe",
      description: "Records who asked for the environment.",
      icon: "Folder",
      create: async (context) => {
        requesters.push(context.experimental_requester);
        return { status: "failed", message: "probe only" };
      },
      remove: async () => ({ status: "removed" }),
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentCompositions: () => [],
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
  return requesters;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function signUp(
  harness: TestAppHarness,
  body: Record<string, string>,
): Promise<{ cookie: string; id: string }> {
  const response = await harness.app.request("/api/v1/auth/sign-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const { user } = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await response.json());
  return { cookie: cookieHeader(response), id: user.id };
}

async function bootstrapTeam(harness: TestAppHarness) {
  const admin = await signUp(harness, {
    email: "alice@example.test",
    name: "Alice",
    password: "correct horse battery",
  });
  const invite = await harness.app.request("/api/v1/auth/invites", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ role: "member" }),
  });
  const { token } = z.object({ token: z.string() }).parse(await invite.json());
  const member = await signUp(harness, {
    email: "bob@example.test",
    inviteToken: token,
    name: "Bob",
    password: "bob long enough password",
  });
  return { admin, member };
}

async function createProbeThread(
  harness: TestAppHarness,
  hostId: string,
  creator: { userId: string; roleCeiling: RoleCeiling | null },
) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/${hostId}`,
  });
  return createThreadFromRequest(harness.deps, {
    createdByRoleCeiling: creator.roleCeiling,
    createdByUserId: creator.userId,
    environment: {
      type: "provider",
      environmentProviderId: PROVIDER_ID,
      machine: { type: "existing", hostId: host.id },
      inputs: null,
    },
    input: textInput("Set up a workspace"),
    origin: "app",
    projectId: project.id,
    providerId: "codex",
    model: "requested-model",
    startedOnBehalfOf: null,
  });
}

describe("environment provider create receives the requesting user", () => {
  it("passes the local owner as an admin in local mode", async () => {
    await withTestHarness(async (harness) => {
      const requesters = installRequesterProbe();
      await createProbeThread(harness, "host-requester-local", {
        userId: LOCAL_OWNER_USER_ID,
        roleCeiling: null,
      });

      await expect
        .poll(() => requesters)
        .toEqual([{ userId: LOCAL_OWNER_USER_ID, role: "admin" }]);
    });
  });

  it("passes each creator with their own role in multi-user mode", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin, member } = await bootstrapTeam(harness);
      const requesters = installRequesterProbe();

      await createProbeThread(harness, "host-requester-member", {
        userId: member.id,
        roleCeiling: null,
      });
      await expect
        .poll(() => requesters)
        .toEqual([{ userId: member.id, role: "member" }]);

      await createProbeThread(harness, "host-requester-admin", {
        userId: admin.id,
        roleCeiling: null,
      });
      await expect
        .poll(() => requesters)
        .toEqual([
          { userId: member.id, role: "member" },
          { userId: admin.id, role: "admin" },
        ]);
    });
  });

  it("reports an admin acting through a member-capped credential as a member", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin } = await bootstrapTeam(harness);
      const requesters = installRequesterProbe();

      await createProbeThread(harness, "host-requester-capped", {
        userId: admin.id,
        roleCeiling: "member",
      });

      await expect
        .poll(() => requesters)
        .toEqual([{ userId: admin.id, role: "member" }]);
    });
  });

  it("reads the creator's role when each environment is created", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { member } = await bootstrapTeam(harness);
      const requesters = installRequesterProbe();
      harness.deps.userAuth.updateUserRole(member.id, "admin");
      await createProbeThread(harness, "host-requester-promoted", {
        userId: member.id,
        roleCeiling: null,
      });
      await expect.poll(() => requesters.length).toBe(1);

      harness.deps.userAuth.updateUserRole(member.id, "member");
      await createProbeThread(harness, "host-requester-demoted", {
        userId: member.id,
        roleCeiling: null,
      });

      await expect
        .poll(() => requesters)
        .toEqual([
          { userId: member.id, role: "admin" },
          { userId: member.id, role: "member" },
        ]);
    });
  });
});
