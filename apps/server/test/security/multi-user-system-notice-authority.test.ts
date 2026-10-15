import { eq } from "drizzle-orm";
import {
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessage,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  threads,
} from "@bb/db";
import { turnRequestEventDataSchema, turnScope } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { queueChildThreadTurnNotificationBestEffort } from "../../src/services/threads/child-thread-notifications.js";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  type HostRpcResponder,
} from "../helpers/host-rpc.js";
import {
  seedThread,
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

function seedChild(harness: TestAppHarness, fixture: Fixture, creatorId: string) {
  const child = seedThread(harness.deps, {
    environmentId: fixture.environment.id,
    parentThreadId: fixture.thread.id,
    projectId: fixture.project.id,
    status: "idle",
    title: "Worker child",
  });
  setThreadCreator(harness, child.id, creatorId);
  return child;
}

async function notifyChildCompleted(
  harness: TestAppHarness,
  fixture: Fixture,
  child: { id: string; projectId: string; title: string | null },
): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await queueChildThreadTurnNotificationBestEffort(harness.deps, {
      childThread: child,
      parentThreadId: fixture.thread.id,
      turnStatus: "completed",
    });
    await vi.advanceTimersByTimeAsync(2_000);
  } finally {
    vi.useRealTimers();
  }
}

async function settleRunningTurn(
  harness: TestAppHarness,
  fixture: Fixture,
): Promise<void> {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId: fixture.session.id,
      eventGroups: groupHostDaemonEvents([
        {
          threadId: fixture.thread.id,
          event: {
            type: "turn/completed",
            threadId: fixture.thread.id,
            providerThreadId: "provider-shared-thread",
            scope: turnScope("turn-running"),
            status: "completed",
          },
        },
      ]),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

function queueSystemNotice(
  harness: TestAppHarness,
  fixture: Fixture,
  value: string,
) {
  return createQueuedThreadMessage(harness.db, harness.deps.hub, {
    threadId: fixture.thread.id,
    content: textInput(value),
    senderThreadId: null,
    origin: null,
    originPluginId: null,
    model: "test-model",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: { kind: "thread-busy" },
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: { kind: "child-completed", subject: null },
  });
}

function turnRequestsContaining(
  harness: TestAppHarness,
  threadId: string,
  value: string,
) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)))
    .filter((data) =>
      data.input.some(
        (item) => item.type === "text" && item.text.includes(value),
      ),
    );
}

describe("child-outcome notices for a parent running another authority's turn", () => {
  it("queues the notice behind an admin's running turn and starts it as a new tokenless turn once the turn settles", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = await seedIdleThread(harness, alice.id);
      const child = seedChild(harness, fixture, bob.id);
      const daemon = respondAsReadyDaemon(harness, fixture);
      await startRunningTurn(
        harness,
        fixture,
        daemon,
        { cookie: alice.cookie },
        "Admin work",
      );

      await notifyChildCompleted(harness, fixture, child);

      const [queued] = await waitFor(() => {
        const rows = listQueuedThreadMessages(harness.db, fixture.thread.id);
        return rows.length > 0 ? rows : undefined;
      });
      expect(queued?.systemNotice).not.toBeNull();
      expect(
        turnSubmits(daemon, fixture.thread.id).filter((command) =>
          submittedText(command).includes(`@thread:${child.id}`),
        ),
      ).toEqual([]);
      expect(stopRequests(daemon, fixture.thread.id)).toBe(0);
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("active");

      await settleRunningTurn(harness, fixture);

      const notice = await waitForSubmit(
        daemon,
        fixture.thread.id,
        `@thread:${child.id}`,
      );
      expect(notice.target.mode).toBe("start");
      expect(dispatchedToken(notice)).toBeNull();
      expect(stopRequests(daemon, fixture.thread.id)).toBe(0);
      expect(listQueuedThreadMessages(harness.db, fixture.thread.id)).toEqual(
        [],
      );
    });
  });

  it("steers the notice into a running turn that a system notice started", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = await seedIdleThread(harness, alice.id);
      const first = seedChild(harness, fixture, bob.id);
      const second = seedChild(harness, fixture, bob.id);
      const daemon = respondAsReadyDaemon(harness, fixture);

      await notifyChildCompleted(harness, fixture, first);
      const started = await waitForSubmit(
        daemon,
        fixture.thread.id,
        `@thread:${first.id}`,
      );
      expect(started.target.mode).toBe("start");
      seedTurnStarted(harness.deps, {
        environmentId: fixture.environment.id,
        providerThreadId: "provider-shared-thread",
        threadId: fixture.thread.id,
        turnId: "turn-running",
      });

      await notifyChildCompleted(harness, fixture, second);
      const steered = await waitForSubmit(
        daemon,
        fixture.thread.id,
        `@thread:${second.id}`,
      );
      expect(steered.target).toMatchObject({
        mode: "auto",
        expectedTurnId: "turn-running",
      });
      expect(stopRequests(daemon, fixture.thread.id)).toBe(0);
      expect(listQueuedThreadMessages(harness.db, fixture.thread.id)).toEqual(
        [],
      );
    });
  });
});

describe("queued system notices", () => {
  it("turns a member-edited system notice into an ordinary member message dispatched with the member's token", async () => {
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
      const row = queueSystemNotice(harness, fixture, "Original notice");
      const queuedPath = `/api/v1/threads/${fixture.thread.id}/queued-messages`;

      const edited = await harness.app.request(`${queuedPath}/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: bob.cookie },
        body: JSON.stringify({
          expectedUpdatedAt: row.updatedAt,
          input: text("Edited notice by Bob"),
        }),
      });
      expect(edited.status, await edited.clone().text()).toBe(200);
      const [editedRow] = listQueuedThreadMessages(
        harness.db,
        fixture.thread.id,
      );
      expect(editedRow).toMatchObject({
        authorUserId: bob.id,
        authorRoleCeiling: null,
        systemNotice: null,
      });

      const sentNow = await postJson(
        harness,
        `${queuedPath}/${row.id}/send`,
        { cookie: bob.cookie },
        { mode: "steer" },
      );
      expect(sentNow.status, await sentNow.clone().text()).toBe(200);
      const editedTurn = await waitForSubmit(
        daemon,
        fixture.thread.id,
        "Edited notice by Bob",
      );
      expect(editedTurn.target.mode).toBe("start");
      expect(stopRequests(daemon, fixture.thread.id)).toBe(1);
      expect(
        await tokenPrincipal(harness, dispatchedToken(editedTurn)),
      ).toMatchObject({ userId: bob.id, role: "member" });
      expect(
        turnRequestsContaining(
          harness,
          fixture.thread.id,
          "Edited notice by Bob",
        ).map((request) => request.initiator),
      ).toEqual(["user"]);
    });
  });

  it("keeps a system notice queued when send-now would steer it into an admin's running turn", async () => {
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
      const row = queueSystemNotice(harness, fixture, "Waiting notice");

      const sentNow = await postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/queued-messages/${row.id}/send`,
        { cookie: alice.cookie },
        { mode: "steer" },
      );
      expect(sentNow.status).toBe(409);
      expect(await sentNow.json()).toMatchObject({
        code: "queued_message_still_waiting",
      });
      expect(
        turnSubmits(daemon, fixture.thread.id).filter((command) =>
          submittedText(command).includes("Waiting notice"),
        ),
      ).toEqual([]);
      expect(stopRequests(daemon, fixture.thread.id)).toBe(0);
      expect(
        listQueuedThreadMessages(harness.db, fixture.thread.id),
      ).toMatchObject([{ id: row.id, waitingOn: expect.any(String) }]);

      await settleRunningTurn(harness, fixture);
      const notice = await waitForSubmit(
        daemon,
        fixture.thread.id,
        "Waiting notice",
      );
      expect(notice.target.mode).toBe("start");
      expect(dispatchedToken(notice)).toBeNull();
    });
  });

  it("keeps a system notice queued when a drain runs during an admin's running turn", async () => {
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
      const row = queueSystemNotice(harness, fixture, "Drained notice");
      clearQueuedThreadMessageWaitingOn(harness.db, harness.deps.hub, {
        id: row.id,
        threadId: fixture.thread.id,
      });

      await sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: fixture.thread.id,
      });

      expect(
        turnSubmits(daemon, fixture.thread.id).filter((command) =>
          submittedText(command).includes("Drained notice"),
        ),
      ).toEqual([]);
      expect(stopRequests(daemon, fixture.thread.id)).toBe(0);
      const [waiting] = listQueuedThreadMessages(harness.db, fixture.thread.id);
      expect(waiting?.id).toBe(row.id);
      expect(waiting?.claimToken).toBeNull();
      expect(JSON.parse(waiting?.waitingOn ?? "null")).toEqual({
        kind: "thread-busy",
      });
    });
  });
});

describe("long-running turns", () => {
  it("keeps steering the starting author's turn after more than 64 steers", async () => {
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

      for (let index = 0; index < 70; index += 1) {
        const steered = await postJson(
          harness,
          `/api/v1/threads/${fixture.thread.id}/send`,
          { cookie: alice.cookie },
          { input: text(`Steer ${index}.`), mode: "steer" },
        );
        expect(steered.status, await steered.clone().text()).toBe(200);
        await waitForSubmit(daemon, fixture.thread.id, `Steer ${index}.`);
      }

      expect(stopRequests(daemon, fixture.thread.id)).toBe(0);
      expect(interruptionReasons(harness, fixture.thread.id)).toEqual([]);
      expect(
        turnSubmits(daemon, fixture.thread.id)
          .filter((command) => submittedText(command).startsWith("Steer "))
          .map((command) => command.target.mode),
      ).toEqual(Array.from({ length: 70 }, () => "steer"));
    });
  });
});
