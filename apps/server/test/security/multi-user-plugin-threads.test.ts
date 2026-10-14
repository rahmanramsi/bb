import { eq } from "drizzle-orm";
import {
  authUsers,
  getThread,
  listQueuedThreadMessages,
  threads,
} from "@bb/db";
import { LOCAL_OWNER_USER_ID } from "@bb/domain";
import { MACHINE_AUTH_SYSTEM_USER_ID } from "../../src/services/machine-auth.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import { readJson } from "../helpers/json.js";
import { availableModelFixture } from "../helpers/available-models.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
} from "../helpers/host-rpc.js";
import { seedThreadFixture, seedThreadRuntimeState } from "../helpers/seed.js";
import {
  startTestServer,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface Member {
  cookie: string;
  id: string;
}

type Caller = Member | "service";

interface CreatedThread {
  createdByUserId: string | null;
  id: string;
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
): Promise<Member> {
  const response = await harness.app.request("/api/v1/auth/sign-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const { user } = (await response.json()) as { user: { id: string } };
  return { cookie: cookieHeader(response), id: user.id };
}

async function bootstrapTeam(
  harness: TestAppHarness,
): Promise<{ alice: Member; bob: Member }> {
  const alice = await signUp(harness, {
    email: "alice@example.test",
    name: "Alice",
    password: "correct horse battery",
  });
  const invite = await harness.app.request("/api/v1/auth/invites", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: alice.cookie },
    body: JSON.stringify({ role: "member" }),
  });
  expect(invite.status).toBe(201);
  const { token } = (await invite.json()) as { token: string };
  const bob = await signUp(harness, {
    email: "bob@example.test",
    inviteToken: token,
    name: "Bob",
    password: "another long password",
  });
  return { alice, bob };
}

async function createThread(
  harness: TestAppHarness,
  caller: Caller,
  fixture: ReturnType<typeof seedThreadFixture>,
  extra: Record<string, unknown> = {},
): Promise<CreatedThread> {
  const response = await harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(caller === "service"
        ? { authorization: `Bearer ${harness.deps.userAuth.serviceToken}` }
        : { cookie: caller.cookie }),
    },
    body: JSON.stringify({
      origin: caller === "service" ? "plugin" : "app",
      ...(caller === "service" ? { originPluginId: "workflows" } : {}),
      projectId: fixture.project.id,
      providerId: "codex",
      input: [{ type: "text", text: "Do the work", mentions: [] }],
      sendAt: Date.now() + 600_000,
      environment: { type: "reuse", environmentId: fixture.environment.id },
      ...extra,
    }),
  });
  expect(response.status).toBe(201);
  return (await readJson(response)) as CreatedThread;
}

async function shellUserId(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedThreadFixture>,
  threadId: string,
): Promise<string | null> {
  const thread = getThread(harness.db, threadId);
  if (thread === null) throw new Error("thread not found");
  const [queued] = listQueuedThreadMessages(harness.db, threadId);
  if (queued === undefined) throw new Error("first message not queued");
  const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
    authorRoleCeiling: null,
    authorUserId: queued.authorUserId,
    environment: {
      hostId: fixture.host.id,
      id: fixture.environment.id,
      path: fixture.environment.path,
      status: fixture.environment.status,
    },
    model: "test-model",
    thread,
  });
  const credential = config.contributedEnv.find(
    (entry) => entry.name === "BB_TOKEN",
  );
  if (credential === undefined) return null;
  if (typeof credential.value !== "string")
    throw new Error("shell credential is not a string");
  const principal = await harness.deps.userAuth.resolvePrincipal(
    new Headers({ authorization: `Bearer ${credential.value}` }),
  );
  return principal?.userId ?? null;
}

async function shellToken(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedThreadFixture>,
  threadId: string,
  authorUserId: string | null,
): Promise<string | null> {
  const thread = getThread(harness.db, threadId);
  if (thread === null) throw new Error("thread not found");
  const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
    authorRoleCeiling: null,
    authorUserId,
    environment: {
      hostId: fixture.host.id,
      id: fixture.environment.id,
      path: fixture.environment.path,
      status: fixture.environment.status,
    },
    model: "test-model",
    thread,
  });
  const credential = config.contributedEnv.find(
    (entry) => entry.name === "BB_TOKEN",
  );
  if (credential === undefined) return null;
  if (typeof credential.value !== "string")
    throw new Error("shell credential is not a string");
  return credential.value;
}

async function listUsersStatus(
  harness: TestAppHarness,
  token: string,
): Promise<number> {
  const response = await harness.app.request("/api/v1/users", {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.status;
}

async function setRole(
  harness: TestAppHarness,
  admin: Member,
  userId: string,
  role: "admin" | "member",
): Promise<void> {
  const response = await harness.app.request(`/api/v1/users/${userId}/role`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ role }),
  });
  expect(response.status).toBe(200);
}

describe("plugin-created threads in multi mode", () => {
  it("attributes a service-token child thread to its parent's human creator and issues their token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const origin = await createThread(harness, bob, fixture);
      expect(origin.createdByUserId).toBe(bob.id);

      const child = await createThread(harness, "service", fixture, {
        parentThreadId: origin.id,
      });
      const worker = await createThread(harness, "service", fixture, {
        lifecycleOwnerThreadId: origin.id,
        visibility: "hidden",
      });

      for (const thread of [child, worker]) {
        expect(thread.createdByUserId).toBe(bob.id);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
          { authorUserId: LOCAL_OWNER_USER_ID },
        ]);
        expect(await shellUserId(harness, fixture, thread.id)).toBe(bob.id);
      }
    });
  });

  it("issues the human creator's token when a plugin sends into their thread", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const origin = await createThread(harness, bob, fixture);
      const servicePrincipal = await harness.deps.userAuth.resolvePrincipal(
        new Headers({
          authorization: `Bearer ${harness.deps.userAuth.serviceToken}`,
        }),
      );
      expect(servicePrincipal).toMatchObject({
        kind: "machine",
        userId: LOCAL_OWNER_USER_ID,
      });
      const thread = getThread(harness.db, origin.id);
      if (thread === null) throw new Error("thread not found");
      const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
        authorRoleCeiling: null,
        authorUserId: servicePrincipal?.userId ?? null,
        environment: {
          hostId: fixture.host.id,
          id: fixture.environment.id,
          path: fixture.environment.path,
          status: fixture.environment.status,
        },
        model: "test-model",
        thread,
      });
      const credential = config.contributedEnv.find(
        (entry) => entry.name === "BB_TOKEN",
      );
      if (typeof credential?.value !== "string")
        throw new Error("no shell credential");
      expect(
        await harness.deps.userAuth.resolvePrincipal(
          new Headers({ authorization: `Bearer ${credential.value}` }),
        ),
      ).toMatchObject({ userId: bob.id, role: "member" });
    });
  });

  it("leaves service-token threads without a human parent unattributed and tokenless", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const root = await createThread(harness, "service", fixture);
      expect(root.createdByUserId).toBe(LOCAL_OWNER_USER_ID);
      expect(await shellUserId(harness, fixture, root.id)).toBeNull();

      const child = await createThread(harness, "service", fixture, {
        parentThreadId: root.id,
      });
      expect(child.createdByUserId).toBe(LOCAL_OWNER_USER_ID);
      expect(await shellUserId(harness, fixture, child.id)).toBeNull();
    });
  });

  it("never lets a member inherit another user's identity through a parent thread", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const adminOrigin = await createThread(harness, alice, fixture);
      expect(adminOrigin.createdByUserId).toBe(alice.id);

      const memberChild = await createThread(harness, bob, fixture, {
        parentThreadId: adminOrigin.id,
      });
      const memberWorker = await createThread(harness, bob, fixture, {
        lifecycleOwnerThreadId: adminOrigin.id,
      });
      for (const thread of [memberChild, memberWorker]) {
        expect(thread.createdByUserId).toBe(bob.id);
        expect(await shellUserId(harness, fixture, thread.id)).toBe(bob.id);
      }
    });
  });

  it("keeps local mode attribution and shell environment unchanged", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const now = new Date();
      harness.db
        .insert(authUsers)
        .values({
          id: "usr_former_member",
          name: "Former member",
          email: "former@example.test",
          emailVerified: true,
          role: "member",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      harness.db
        .update(threads)
        .set({ createdByUserId: "usr_former_member" })
        .where(eq(threads.id, fixture.thread.id))
        .run();

      const child = await createThread(harness, "service", fixture, {
        parentThreadId: fixture.thread.id,
      });
      expect(child.createdByUserId).toBe(LOCAL_OWNER_USER_ID);
      expect(await shellUserId(harness, fixture, child.id)).toBeNull();
    });
  });
});

describe("BB_TOKEN containment for turns no user sent", () => {
  it("issues no token for system-authored turns in an admin-created thread", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const adminThread = await createThread(harness, alice, fixture);
      expect(adminThread.createdByUserId).toBe(alice.id);
      for (const systemAuthor of [
        LOCAL_OWNER_USER_ID,
        MACHINE_AUTH_SYSTEM_USER_ID,
        null,
      ]) {
        expect(
          await shellToken(harness, fixture, adminThread.id, systemAuthor),
        ).toBeNull();
      }
    });
  });

  it("issues no token for service-spawned threads under an admin parent", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const adminThread = await createThread(harness, alice, fixture);
      const child = await createThread(harness, "service", fixture, {
        parentThreadId: adminThread.id,
      });
      const worker = await createThread(harness, "service", fixture, {
        lifecycleOwnerThreadId: adminThread.id,
        visibility: "hidden",
      });
      for (const thread of [child, worker]) {
        expect(thread.createdByUserId).toBe(alice.id);
        expect(await shellUserId(harness, fixture, thread.id)).toBeNull();
      }
    });
  });

  it("issues a member-capped token for system-authored turns in a member's thread", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const memberThread = await createThread(harness, bob, fixture);
      const child = await createThread(harness, "service", fixture, {
        parentThreadId: memberThread.id,
      });
      expect(child.createdByUserId).toBe(bob.id);
      expect(await shellUserId(harness, fixture, child.id)).toBe(bob.id);
      const token = await shellToken(
        harness,
        fixture,
        memberThread.id,
        LOCAL_OWNER_USER_ID,
      );
      if (token === null) throw new Error("no shell credential");
      expect(
        await harness.deps.userAuth.resolvePrincipal(
          new Headers({ authorization: `Bearer ${token}` }),
        ),
      ).toMatchObject({ kind: "user", userId: bob.id, role: "member" });
    });
  });

  it("keeps an inferred token at member after its user is promoted, unlike a direct token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const memberThread = await createThread(harness, bob, fixture);
      const inferred = await shellToken(
        harness,
        fixture,
        memberThread.id,
        LOCAL_OWNER_USER_ID,
      );
      const direct = await shellToken(
        harness,
        fixture,
        memberThread.id,
        bob.id,
      );
      if (inferred === null || direct === null)
        throw new Error("no shell credential");
      expect(await listUsersStatus(harness, inferred)).toBe(403);
      expect(await listUsersStatus(harness, direct)).toBe(403);

      await setRole(harness, alice, bob.id, "admin");

      expect(await listUsersStatus(harness, inferred)).toBe(403);
      const credential = await harness.deps.userAuth.authenticate(
        new Headers({ authorization: `Bearer ${inferred}` }),
      );
      expect(credential?.principal).toMatchObject({
        userId: bob.id,
        role: "member",
      });
      expect(await credential?.isActive()).toBe(true);
      expect(await listUsersStatus(harness, direct)).toBe(200);
      expect(
        await shellToken(
          harness,
          fixture,
          memberThread.id,
          LOCAL_OWNER_USER_ID,
        ),
      ).toBeNull();
    });
  });

  it("issues no token when the inferred creator was removed", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const memberThread = await createThread(harness, bob, fixture);
      const removed = await harness.app.request(`/api/v1/users/${bob.id}`, {
        method: "DELETE",
        headers: { cookie: alice.cookie },
      });
      expect(removed.status).toBeLessThan(300);
      expect(
        await shellToken(
          harness,
          fixture,
          memberThread.id,
          LOCAL_OWNER_USER_ID,
        ),
      ).toBeNull();
    });
  });

  it("keeps the admin token for a turn an admin sends directly", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      const adminThread = await createThread(harness, alice, fixture);
      const token = await shellToken(
        harness,
        fixture,
        adminThread.id,
        alice.id,
      );
      if (token === null) throw new Error("no shell credential");
      expect(
        await harness.deps.userAuth.resolvePrincipal(
          new Headers({ authorization: `Bearer ${token}` }),
        ),
      ).toMatchObject({ kind: "user", userId: alice.id, role: "admin" });
      expect(await listUsersStatus(harness, token)).toBe(200);
    });
  });
  it("issues no token when a member's automation steers into an admin thread", async () => {
    const server = await startTestServer({ authMode: "multi" });
    try {
      server.pluginService.bindSdk({
        baseUrl: server.baseUrl,
        serviceToken: server.deps.userAuth.serviceToken,
      });
      const entry = await server.pluginService.install("builtin:automations", {
        kind: "root",
      });
      expect(entry.status, entry.statusDetail ?? undefined).toBe("running");
      const { alice, bob } = await bootstrapTeam(server);
      const fixture = seedThreadFixture(server, {
        environment: { status: "ready" },
        thread: { status: "idle" },
      });
      seedThreadRuntimeState(server.deps, {
        environmentId: fixture.environment.id,
        providerThreadId: "provider-admin-thread",
        threadId: fixture.thread.id,
      });
      server.db
        .update(threads)
        .set({ createdByUserId: alice.id })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      const daemon = registerHostRpcResponder(server, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        handle: (request) => {
          switch (request.command.type) {
            case "provider.list_models":
              return {
                ok: true,
                result: {
                  models: [availableModelFixture({ model: "test-model" })],
                  selectedOnlyModels: [],
                },
              };
            case "provider.health":
              return {
                ok: true,
                result: {
                  supported: true,
                  health: {
                    status: "ready",
                    statusMessage: null,
                    accountEmail: null,
                    planLabel: null,
                    installedVersion: null,
                    minimumSupportedVersion: null,
                    canInstall: false,
                    canUpdate: false,
                    loginCommand: null,
                  },
                },
              };
            case "host.read_workspace_agent_context":
              return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
            default:
              return {
                ok: false,
                errorCode: "test_unhandled",
                errorMessage: request.command.type,
              };
          }
        },
      });
      const rpc = async (method: string, body: Record<string, unknown>) => {
        const response = await server.app.request(
          `/api/v1/plugins/automations/rpc/${method}`,
          {
            method: "POST",
            headers: { "content-type": "application/json", cookie: bob.cookie },
            body: JSON.stringify(body),
          },
        );
        const payload: unknown = await response.json();
        expect(response.status, JSON.stringify(payload)).toBe(200);
        return payload;
      };
      const created = await rpc("automations_create", {
        projectId: fixture.project.id,
        name: "Steer the admin thread",
        enabled: false,
        trigger: {
          triggerType: "schedule",
          cron: "0 * * * *",
          timezone: "UTC",
        },
        execution: {
          mode: "agent",
          prompt: "Run bb as whoever owns this thread",
          providerId: fixture.thread.providerId,
          model: "test-model",
          permissionMode: "full",
          environment: { type: "reuse", environmentId: fixture.environment.id },
          targetThreadId: fixture.thread.id,
        },
        origin: "human",
      });
      const automationId = z
        .object({ result: z.object({ id: z.string() }) })
        .parse(created).result.id;
      await rpc("automations_run", {
        projectId: fixture.project.id,
        automationId,
      });

      let submitted: unknown;
      for (
        let attempt = 0;
        attempt < 300 && submitted === undefined;
        attempt += 1
      ) {
        submitted = daemon.requests.find(
          (request) =>
            request.command.type === "turn.submit" &&
            request.command.threadId === fixture.thread.id,
        )?.command;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const contributed = z
        .object({
          resumeContext: z.object({
            contributedEnv: z.array(z.object({ name: z.string() })),
          }),
        })
        .parse(submitted).resumeContext.contributedEnv;
      expect(contributed.map((entry) => entry.name)).not.toContain("BB_TOKEN");
    } finally {
      await server.pluginService.stop();
      await server.close();
    }
  });
});
