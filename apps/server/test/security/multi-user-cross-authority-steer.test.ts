import { eq } from "drizzle-orm";
import {
  getThread,
  listEvents,
  listQueuedThreadMessages,
  threads,
} from "@bb/db";
import { LOCAL_OWNER_USER_ID } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import { availableModelFixture } from "../helpers/available-models.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  type HostRpcResponder,
} from "../helpers/host-rpc.js";
import {
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface Member {
  cookie: string;
  id: string;
}

type Fixture = ReturnType<typeof seedThreadFixture>;

const text = (value: string) => [{ type: "text", text: value, mentions: [] }];

const turnSubmitSchema = z.object({
  type: z.literal("turn.submit"),
  threadId: z.string(),
  input: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  target: z.object({ mode: z.string() }).passthrough(),
  resumeContext: z.object({
    contributedEnv: z.array(z.object({ name: z.string(), value: z.unknown() })),
  }),
});
type TurnSubmit = z.infer<typeof turnSubmitSchema>;

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

function setThreadCreator(
  harness: TestAppHarness,
  threadId: string,
  userId: string,
): void {
  harness.db
    .update(threads)
    .set({ createdByUserId: userId })
    .where(eq(threads.id, threadId))
    .run();
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function postJson(
  harness: TestAppHarness,
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  return harness.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function respondAsReadyDaemon(
  harness: TestAppHarness,
  fixture: Fixture,
): HostRpcResponder {
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
        case "turn.submit":
          return { ok: true, result: { trace: { spans: [] } } };
        case "thread.stop":
          return { ok: true, result: { providerCheckpointId: null } };
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

function turnSubmits(daemon: HostRpcResponder, threadId: string): TurnSubmit[] {
  return daemon.requests
    .map((request) => request.command)
    .filter(
      (command) =>
        command.type === "turn.submit" && command.threadId === threadId,
    )
    .map((command) => turnSubmitSchema.parse(command));
}

function stopRequests(daemon: HostRpcResponder, threadId: string): number {
  return daemon.requests.filter(
    (request) =>
      request.command.type === "thread.stop" &&
      request.command.threadId === threadId,
  ).length;
}

function submittedText(command: TurnSubmit): string {
  return command.input.map((item) => item.text ?? "").join("");
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

async function waitForSubmit(
  daemon: HostRpcResponder,
  threadId: string,
  value: string,
): Promise<TurnSubmit> {
  return waitFor(() =>
    turnSubmits(daemon, threadId).find((command) =>
      submittedText(command).includes(value),
    ),
  );
}

function dispatchedToken(command: TurnSubmit): string | null {
  const entry = command.resumeContext.contributedEnv.find(
    (candidate) => candidate.name === "BB_TOKEN",
  );
  return entry === undefined ? null : z.string().parse(entry.value);
}

async function tokenPrincipal(
  harness: TestAppHarness,
  token: string | null,
): Promise<unknown> {
  if (token === null) return null;
  return harness.deps.userAuth.resolvePrincipal(new Headers(bearer(token)));
}

async function seedIdleThread(
  harness: TestAppHarness,
  creatorId: string,
): Promise<Fixture> {
  const fixture = seedThreadFixture(harness, {
    environment: { status: "ready" },
    thread: { status: "idle" },
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: fixture.environment.id,
    providerThreadId: "provider-shared-thread",
    threadId: fixture.thread.id,
  });
  setThreadCreator(harness, fixture.thread.id, creatorId);
  return fixture;
}

async function startRunningTurn(
  harness: TestAppHarness,
  fixture: Fixture,
  daemon: HostRpcResponder,
  headers: Record<string, string>,
  value: string,
): Promise<TurnSubmit> {
  const sent = await postJson(
    harness,
    `/api/v1/threads/${fixture.thread.id}/send`,
    headers,
    { input: text(value), mode: "auto" },
  );
  expect(sent.status, await sent.clone().text()).toBe(200);
  const started = await waitForSubmit(daemon, fixture.thread.id, value);
  expect(started.target.mode).toBe("start");
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    providerThreadId: "provider-shared-thread",
    threadId: fixture.thread.id,
    turnId: "turn-running",
  });
  expect(getThread(harness.db, fixture.thread.id)?.status).toBe("active");
  return started;
}

function interruptionReasons(
  harness: TestAppHarness,
  threadId: string,
): unknown[] {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "system/thread/interrupted")
    .map(
      (event) =>
        z.object({ reason: z.string() }).parse(JSON.parse(event.data)).reason,
    );
}

async function cappedShellToken(
  harness: TestAppHarness,
  fixture: Fixture,
): Promise<string> {
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
  return z
    .string()
    .parse(
      config.contributedEnv.find((entry) => entry.name === "BB_TOKEN")?.value,
    );
}

describe("sends into a running turn of another authority", () => {
  it("interrupts an admin's running turn and starts the member's input with the member's token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = await seedIdleThread(harness, alice.id);
      const daemon = respondAsReadyDaemon(harness, fixture);
      const adminTurn = await startRunningTurn(
        harness,
        fixture,
        daemon,
        { cookie: alice.cookie },
        "Admin work",
      );
      expect(
        await tokenPrincipal(harness, dispatchedToken(adminTurn)),
      ).toMatchObject({ userId: alice.id, role: "admin" });

      const steered = await postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/send`,
        { cookie: bob.cookie },
        { input: text("Member input"), mode: "auto" },
      );
      expect(steered.status, await steered.clone().text()).toBe(200);

      const memberTurn = await waitForSubmit(
        daemon,
        fixture.thread.id,
        "Member input",
      );
      expect(memberTurn.target.mode).toBe("start");
      expect(stopRequests(daemon, fixture.thread.id)).toBe(1);
      expect(
        await tokenPrincipal(harness, dispatchedToken(memberTurn)),
      ).toMatchObject({ userId: bob.id, role: "member" });
      expect(interruptionReasons(harness, fixture.thread.id)).toEqual([
        "other-author",
      ]);
    });
  });

  it("interrupts an admin's running turn for a plugin-authored send and starts it without a token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = await seedIdleThread(harness, alice.id);
      const daemon = respondAsReadyDaemon(harness, fixture);
      await startRunningTurn(
        harness,
        fixture,
        daemon,
        { cookie: alice.cookie },
        "Admin work",
      );

      const steered = await postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/send`,
        bearer(harness.deps.userAuth.serviceToken),
        { input: text("Plugin steer"), mode: "steer" },
      );
      expect(steered.status, await steered.clone().text()).toBe(200);

      const pluginTurn = await waitForSubmit(
        daemon,
        fixture.thread.id,
        "Plugin steer",
      );
      expect(pluginTurn.target.mode).toBe("start");
      expect(stopRequests(daemon, fixture.thread.id)).toBe(1);
      expect(dispatchedToken(pluginTurn)).toBeNull();
    });
  });

  it("keeps steering a running turn for the user who started it", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = await seedIdleThread(harness, alice.id);
      const daemon = respondAsReadyDaemon(harness, fixture);
      await startRunningTurn(
        harness,
        fixture,
        daemon,
        { cookie: alice.cookie },
        "Admin work",
      );

      const steered = await postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/send`,
        { cookie: alice.cookie },
        { input: text("Admin follow-up"), mode: "auto" },
      );
      expect(steered.status, await steered.clone().text()).toBe(200);
      expect(await steered.json()).toMatchObject({ delivery: "sent" });

      const followUp = await waitForSubmit(
        daemon,
        fixture.thread.id,
        "Admin follow-up",
      );
      expect(followUp.target).toMatchObject({
        mode: "auto",
        expectedTurnId: "turn-running",
      });
      expect(stopRequests(daemon, fixture.thread.id)).toBe(0);
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("active");
    });
  });

  it("treats a capped token of the same user as a different authority", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { bob } = await bootstrapTeam(harness);
      const fixture = await seedIdleThread(harness, bob.id);
      const capped = await cappedShellToken(harness, fixture);
      const daemon = respondAsReadyDaemon(harness, fixture);
      await startRunningTurn(
        harness,
        fixture,
        daemon,
        { cookie: bob.cookie },
        "Bob work",
      );

      const steered = await postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/send`,
        bearer(capped),
        { input: text("Agent steer"), mode: "auto" },
      );
      expect(steered.status, await steered.clone().text()).toBe(200);

      const cappedTurn = await waitForSubmit(
        daemon,
        fixture.thread.id,
        "Agent steer",
      );
      expect(cappedTurn.target.mode).toBe("start");
      expect(stopRequests(daemon, fixture.thread.id)).toBe(1);
      const principal = z
        .object({ userId: z.string(), roleCeiling: z.string().nullable() })
        .parse(await tokenPrincipal(harness, dispatchedToken(cappedTurn)));
      expect(principal).toMatchObject({
        userId: bob.id,
        roleCeiling: "member",
      });
    });
  });
});

describe("queued messages edited by another authority", () => {
  it("re-attributes an admin's queued message to the member who edits it", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = await seedIdleThread(harness, alice.id);
      const daemon = respondAsReadyDaemon(harness, fixture);
      await startRunningTurn(
        harness,
        fixture,
        daemon,
        { cookie: alice.cookie },
        "Admin work",
      );
      const queuedPath = `/api/v1/threads/${fixture.thread.id}/queued-messages`;
      const queued = await postJson(
        harness,
        queuedPath,
        { cookie: alice.cookie },
        { input: text("Queued by Alice"), model: "test-model" },
      );
      expect(queued.status, await queued.clone().text()).toBe(201);
      const [row] = listQueuedThreadMessages(harness.db, fixture.thread.id);
      if (row === undefined) throw new Error("message not queued");
      expect(row.authorUserId).toBe(alice.id);

      const edited = await harness.app.request(`${queuedPath}/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: bob.cookie },
        body: JSON.stringify({
          expectedUpdatedAt: row.updatedAt,
          input: text("Edited by Bob"),
        }),
      });
      expect(edited.status, await edited.clone().text()).toBe(200);
      const [editedRow] = listQueuedThreadMessages(
        harness.db,
        fixture.thread.id,
      );
      expect(editedRow).toMatchObject({
        authorUserId: bob.id,
        authorGrantId: null,
        authorRoleCeiling: null,
      });

      const sentNow = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/queued-messages/${row.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: bob.cookie },
          body: JSON.stringify({ mode: "steer" }),
        },
      );
      expect(sentNow.status, await sentNow.clone().text()).toBe(200);
      const editedTurn = await waitForSubmit(
        daemon,
        fixture.thread.id,
        "Edited by Bob",
      );
      expect(editedTurn.target.mode).toBe("start");
      expect(stopRequests(daemon, fixture.thread.id)).toBe(1);
      expect(
        await tokenPrincipal(harness, dispatchedToken(editedTurn)),
      ).toMatchObject({ userId: bob.id, role: "member" });
    });
  });
});
