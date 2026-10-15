import { eq } from "drizzle-orm";
import {
  getThread,
  listEvents,
  listQueuedThreadMessages,
  threads,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  type HostRpcHandlerResult,
  type HostRpcResponder,
} from "../helpers/host-rpc.js";
import { textInput } from "../helpers/prompt-input.js";
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

const PROVIDER_THREAD_ID = "provider-shared-thread";

const text = (value: string) => [{ type: "text", text: value, mentions: [] }];

const turnSubmitSchema = z.object({
  type: z.literal("turn.submit"),
  threadId: z.string(),
  input: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  target: z.object({ mode: z.string() }).passthrough(),
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

interface PreparationGate {
  arm(): void;
  reached: Promise<void>;
  release(): void;
}

function createPreparationGate(): PreparationGate & {
  pause(): Promise<void> | null;
} {
  let armed = false;
  let signalReached: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arm: () => {
      armed = true;
    },
    reached,
    release,
    pause: () => {
      if (!armed) return null;
      armed = false;
      signalReached();
      return released;
    },
  };
}

function respondAsReadyDaemon(
  harness: TestAppHarness,
  fixture: Fixture,
  args: {
    gate: ReturnType<typeof createPreparationGate>;
    turnSubmit?: (command: TurnSubmit) => HostRpcHandlerResult;
  },
): HostRpcResponder {
  return registerHostRpcResponder(harness, {
    hostId: fixture.host.id,
    sessionId: fixture.session.id,
    handle: async (request): Promise<HostRpcHandlerResult> => {
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
        case "host.read_workspace_agent_context": {
          const paused = args.gate.pause();
          if (paused !== null) await paused;
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        case "turn.submit":
          return (
            args.turnSubmit?.(turnSubmitSchema.parse(request.command)) ?? {
              ok: true,
              result: { trace: { spans: [] } },
            }
          );
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

function submitsContaining(
  daemon: HostRpcResponder,
  threadId: string,
  value: string,
): TurnSubmit[] {
  return turnSubmits(daemon, threadId).filter((command) =>
    command.input.some((item) => item.text?.includes(value) ?? false),
  );
}

function stopRequests(daemon: HostRpcResponder, threadId: string): number {
  return daemon.requests.filter(
    (request) =>
      request.command.type === "thread.stop" &&
      request.command.threadId === threadId,
  ).length;
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
  return waitFor(() => submitsContaining(daemon, threadId, value)[0]);
}

function seedIdleThread(harness: TestAppHarness, creatorId: string): Fixture {
  const fixture = seedThreadFixture(harness, {
    environment: { status: "ready" },
    thread: { status: "idle" },
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: fixture.environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: fixture.thread.id,
  });
  harness.db
    .update(threads)
    .set({ createdByUserId: creatorId })
    .where(eq(threads.id, fixture.thread.id))
    .run();
  return fixture;
}

function markTurnStarted(
  harness: TestAppHarness,
  fixture: Fixture,
  turnId: string,
): void {
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: fixture.thread.id,
    turnId,
  });
  expect(getThread(harness.db, fixture.thread.id)?.status).toBe("active");
}

async function completeTurn(
  harness: TestAppHarness,
  fixture: Fixture,
  turnId: string,
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
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(turnId),
            status: "completed",
          },
        },
      ]),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await waitFor(() =>
    getThread(harness.db, fixture.thread.id)?.status === "idle"
      ? true
      : undefined,
  );
}

async function startTurnAs(
  harness: TestAppHarness,
  fixture: Fixture,
  daemon: HostRpcResponder,
  member: Member,
  value: string,
  turnId: string,
): Promise<void> {
  const sent = await postJson(
    harness,
    `/api/v1/threads/${fixture.thread.id}/send`,
    { cookie: member.cookie },
    { input: text(value), mode: "auto" },
  );
  expect(sent.status, await sent.clone().text()).toBe(200);
  const started = await waitForSubmit(daemon, fixture.thread.id, value);
  expect(started.target.mode).toBe("start");
  markTurnStarted(harness, fixture, turnId);
}

function queuedRowContaining(
  harness: TestAppHarness,
  threadId: string,
  value: string,
) {
  return listQueuedThreadMessages(harness.db, threadId).find((row) =>
    row.content.includes(value),
  );
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

function threadFailureEvents(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) =>
      event.type === "system/error" &&
      event.data.includes("thread_command_failed"),
  );
}

async function settleBackgroundWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("authorization bound to the running turn that was checked", () => {
  it("requeues a system notice when an admin turn replaces the system turn during command preparation", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = seedIdleThread(harness, alice.id);
      const gate = createPreparationGate();
      const daemon = respondAsReadyDaemon(harness, fixture, { gate });

      await queueParentSystemMessage(harness.deps, {
        input: textInput("First notice"),
        parentThreadId: fixture.thread.id,
        systemMessageKind: "child-completed",
        systemMessageSubject: null,
      });
      const started = await waitForSubmit(
        daemon,
        fixture.thread.id,
        "First notice",
      );
      expect(started.target.mode).toBe("start");
      markTurnStarted(harness, fixture, "turn-system");

      gate.arm();
      const racing = queueParentSystemMessage(harness.deps, {
        input: textInput("Racing notice"),
        parentThreadId: fixture.thread.id,
        systemMessageKind: "child-completed",
        systemMessageSubject: null,
      });
      await gate.reached;
      await completeTurn(harness, fixture, "turn-system");
      await startTurnAs(
        harness,
        fixture,
        daemon,
        alice,
        "Admin work",
        "turn-admin",
      );
      gate.release();

      expect(await racing).toBe(true);
      await settleBackgroundWork();

      expect(
        submitsContaining(daemon, fixture.thread.id, "Racing notice"),
      ).toEqual([]);
      expect(stopRequests(daemon, fixture.thread.id)).toBe(0);
      const queued = queuedRowContaining(
        harness,
        fixture.thread.id,
        "Racing notice",
      );
      expect(queued?.systemNotice).not.toBeNull();
      expect(JSON.parse(queued?.waitingOn ?? "null")).toEqual({
        kind: "thread-busy",
      });
    });
  });

  it("interrupts instead of steering a member send when an admin turn replaces the member's turn during command preparation", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = seedIdleThread(harness, alice.id);
      const gate = createPreparationGate();
      const daemon = respondAsReadyDaemon(harness, fixture, { gate });
      await startTurnAs(
        harness,
        fixture,
        daemon,
        bob,
        "Member work",
        "turn-member",
      );

      gate.arm();
      const racing = postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/send`,
        { cookie: bob.cookie },
        { input: text("Member follow-up"), mode: "auto" },
      );
      await gate.reached;
      await completeTurn(harness, fixture, "turn-member");
      await startTurnAs(
        harness,
        fixture,
        daemon,
        alice,
        "Admin work",
        "turn-admin",
      );
      gate.release();

      const response = await racing;
      expect(response.status, await response.clone().text()).toBe(200);
      await settleBackgroundWork();

      expect(
        submitsContaining(daemon, fixture.thread.id, "Member follow-up").map(
          (command) => command.target,
        ),
      ).toEqual([{ mode: "start" }]);
      expect(stopRequests(daemon, fixture.thread.id)).toBe(1);
      expect(interruptionReasons(harness, fixture.thread.id)).toEqual([
        "other-author",
      ]);
    });
  });

  it("binds steers to the checked turn and requeues input the daemon refuses for a different live turn", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice } = await bootstrapTeam(harness);
      const fixture = seedIdleThread(harness, alice.id);
      const gate = createPreparationGate();
      const daemon = respondAsReadyDaemon(harness, fixture, {
        gate,
        turnSubmit: (command) =>
          command.input.some((item) => item.text === "Admin follow-up")
            ? {
                ok: false,
                errorCode: "turn_binding_mismatch",
                errorMessage: "The live turn differs from the expected turn",
              }
            : { ok: true, result: { trace: { spans: [] } } },
      });
      await startTurnAs(
        harness,
        fixture,
        daemon,
        alice,
        "Admin work",
        "turn-admin",
      );

      const sent = await postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/send`,
        { cookie: alice.cookie },
        { input: text("Admin follow-up"), mode: "auto" },
      );
      expect(sent.status, await sent.clone().text()).toBe(200);
      const steer = await waitForSubmit(
        daemon,
        fixture.thread.id,
        "Admin follow-up",
      );
      expect(steer.target).toEqual({
        mode: "auto",
        expectedTurnId: "turn-admin",
        bindExpectedTurn: true,
      });

      const requeued = await waitFor(() =>
        queuedRowContaining(harness, fixture.thread.id, "Admin follow-up"),
      );
      expect(requeued).toMatchObject({ authorUserId: alice.id });
      expect(JSON.parse(requeued.waitingOn ?? "null")).toEqual({
        kind: "thread-busy",
      });
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("active");
      expect(threadFailureEvents(harness, fixture.thread.id)).toEqual([]);
    });
  });
});
