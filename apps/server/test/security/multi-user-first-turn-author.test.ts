import { eq } from "drizzle-orm";
import { getThread, threads } from "@bb/db";
import { LOCAL_OWNER_USER_ID } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import { availableModelFixture } from "../helpers/available-models.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
} from "../helpers/host-rpc.js";
import { seedThreadFixture, seedThreadRuntimeState } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface Member {
  cookie: string;
  id: string;
}

type Fixture = ReturnType<typeof seedThreadFixture>;
type Daemon = ReturnType<typeof respondAsReadyDaemon>;

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
  const { user } = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await response.json());
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
  const { token } = z.object({ token: z.string() }).parse(await invite.json());
  const bob = await signUp(harness, {
    email: "bob@example.test",
    inviteToken: token,
    name: "Bob",
    password: "another long password",
  });
  return { alice, bob };
}

function respondAsReadyDaemon(harness: TestAppHarness, fixture: Fixture) {
  return registerHostRpcResponder(harness, {
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
}

async function createThread(
  harness: TestAppHarness,
  fixture: Fixture,
  headers: Record<string, string>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const service = headers.authorization?.endsWith(
    harness.deps.userAuth.serviceToken,
  );
  const response = await harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      origin: service ? "plugin" : "app",
      ...(service ? { originPluginId: "workflows" } : {}),
      projectId: fixture.project.id,
      providerId: "codex",
      model: "test-model",
      input: [{ type: "text", text: "Run bb whoami", mentions: [] }],
      environment: { type: "reuse", environmentId: fixture.environment.id },
      ...extra,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return z.object({ id: z.string() }).parse(await response.json()).id;
}

const contributedEnvSchema = z.array(
  z.object({ name: z.string(), value: z.unknown() }),
);

async function dispatchedCommand(
  daemon: Daemon,
  type: "thread.start" | "turn.submit",
  threadId: string,
): Promise<unknown> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const command = daemon.requests.find(
      (request) =>
        request.command.type === type && request.command.threadId === threadId,
    )?.command;
    if (command !== undefined) return command;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${type} dispatched for ${threadId}`);
}

function bbToken(
  contributedEnv: z.infer<typeof contributedEnvSchema>,
): string | null {
  const credential = contributedEnv.find((entry) => entry.name === "BB_TOKEN");
  if (credential === undefined) return null;
  return z.string().parse(credential.value);
}

async function firstTurnToken(
  daemon: Daemon,
  threadId: string,
): Promise<string | null> {
  const started = await dispatchedCommand(daemon, "thread.start", threadId);
  return bbToken(
    z.object({ contributedEnv: contributedEnvSchema }).parse(started)
      .contributedEnv,
  );
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function listUsersStatus(
  harness: TestAppHarness,
  token: string,
): Promise<number> {
  const response = await harness.app.request("/api/v1/users", {
    headers: bearer(token),
  });
  return response.status;
}

async function promote(
  harness: TestAppHarness,
  admin: Member,
  userId: string,
): Promise<void> {
  const response = await harness.app.request(`/api/v1/users/${userId}/role`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ role: "admin" }),
  });
  expect(response.status).toBe(200);
}

async function cappedMemberToken(
  harness: TestAppHarness,
  fixture: Fixture,
  memberId: string,
): Promise<string> {
  harness.db
    .update(threads)
    .set({ createdByUserId: memberId })
    .where(eq(threads.id, fixture.thread.id))
    .run();
  const thread = getThread(harness.db, fixture.thread.id);
  if (thread === null) throw new Error("thread not found");
  const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
    authorGrantId: null,
    authorRoleCeiling: null,
    authorUserId: LOCAL_OWNER_USER_ID,
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
  return z.string().parse(credential?.value);
}

async function principalOf(harness: TestAppHarness, token: string | null) {
  if (token === null) throw new Error("first turn carried no BB_TOKEN");
  return harness.deps.userAuth.resolvePrincipal(new Headers(bearer(token)));
}

function readyFixture(harness: TestAppHarness): Fixture {
  return seedThreadFixture(harness, { environment: { status: "ready" } });
}

describe("the first turn of a thread runs as the human who created it", () => {
  it("gives an admin's first turn the admin's own uncapped token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = readyFixture(harness);
      const daemon = respondAsReadyDaemon(harness, fixture);

      const threadId = await createThread(harness, fixture, {
        cookie: alice.cookie,
      });
      const token = await firstTurnToken(daemon, threadId);

      expect(await principalOf(harness, token)).toMatchObject({
        kind: "user",
        userId: alice.id,
        role: "admin",
        roleCeiling: null,
      });
      expect(await listUsersStatus(harness, token ?? "")).toBe(200);
    });
  });

  it("gives a member's first turn the member's own uncapped token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = readyFixture(harness);
      const daemon = respondAsReadyDaemon(harness, fixture);

      const threadId = await createThread(harness, fixture, {
        cookie: bob.cookie,
      });
      const token = await firstTurnToken(daemon, threadId);

      expect(await principalOf(harness, token)).toMatchObject({
        userId: bob.id,
        role: "member",
        roleCeiling: null,
      });
      await promote(harness, alice, bob.id);
      expect(await listUsersStatus(harness, token ?? "")).toBe(200);
    });
  });

  it("keeps a member's first turn capped when the thread was created with a capped token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = readyFixture(harness);
      const capped = await cappedMemberToken(harness, fixture, bob.id);
      const daemon = respondAsReadyDaemon(harness, fixture);

      const threadId = await createThread(harness, fixture, bearer(capped));
      const token = await firstTurnToken(daemon, threadId);

      expect(await principalOf(harness, token)).toMatchObject({
        userId: bob.id,
        role: "member",
        roleCeiling: "member",
      });
      await promote(harness, alice, bob.id);
      expect(await listUsersStatus(harness, token ?? "")).toBe(403);
    });
  });

  it("issues no token to a service-spawned first turn under an admin parent", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = readyFixture(harness);
      const parentId = await createThread(
        harness,
        fixture,
        { cookie: alice.cookie },
        { sendAt: Date.now() + 600_000 },
      );
      const daemon = respondAsReadyDaemon(harness, fixture);

      const childId = await createThread(
        harness,
        fixture,
        bearer(harness.deps.userAuth.serviceToken),
        { parentThreadId: parentId },
      );

      expect(await firstTurnToken(daemon, childId)).toBeNull();
    });
  });

  it("gives a service-spawned first turn under a member parent a member-capped token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = readyFixture(harness);
      const parentId = await createThread(
        harness,
        fixture,
        { cookie: bob.cookie },
        { sendAt: Date.now() + 600_000 },
      );
      const daemon = respondAsReadyDaemon(harness, fixture);

      const childId = await createThread(
        harness,
        fixture,
        bearer(harness.deps.userAuth.serviceToken),
        { parentThreadId: parentId },
      );
      const token = await firstTurnToken(daemon, childId);

      expect(await principalOf(harness, token)).toMatchObject({
        userId: bob.id,
        role: "member",
        roleCeiling: "member",
      });
      await promote(harness, alice, bob.id);
      expect(await listUsersStatus(harness, token ?? "")).toBe(403);
    });
  });

  it("runs a manual compaction as the user who requested it", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness, {
        environment: { status: "ready" },
        thread: { providerId: "pi", status: "idle" },
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: fixture.environment.id,
        providerThreadId: "provider-admin-thread",
        threadId: fixture.thread.id,
      });
      harness.db
        .update(threads)
        .set({ createdByUserId: alice.id })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      const daemon = respondAsReadyDaemon(harness, fixture);

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/compact`,
        { method: "POST", headers: { cookie: alice.cookie } },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const submitted = await dispatchedCommand(
        daemon,
        "turn.submit",
        fixture.thread.id,
      );
      const token = bbToken(
        z
          .object({
            resumeContext: z.object({ contributedEnv: contributedEnvSchema }),
          })
          .parse(submitted).resumeContext.contributedEnv,
      );

      expect(await principalOf(harness, token)).toMatchObject({
        userId: alice.id,
        role: "admin",
        roleCeiling: null,
      });
    });
  });

  it("reports the effective role and cap of the calling credential from /me", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = readyFixture(harness);
      const capped = await cappedMemberToken(harness, fixture, bob.id);
      await promote(harness, alice, bob.id);
      const me = async (headers: Record<string, string>) => {
        const response = await harness.app.request("/api/v1/me", { headers });
        expect(response.status).toBe(200);
        return response.json();
      };

      expect(await me(bearer(capped))).toMatchObject({
        user: { id: bob.id, role: "admin" },
        effectiveRole: "member",
        roleCeiling: "member",
      });
      expect(await me({ cookie: bob.cookie })).toMatchObject({
        user: { id: bob.id, role: "admin" },
        effectiveRole: "admin",
        roleCeiling: null,
      });
    });
  });
});
