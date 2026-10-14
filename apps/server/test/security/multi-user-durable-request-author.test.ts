import { and, eq } from "drizzle-orm";
import {
  createConnection,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  threads,
  turnRequestAuthors,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import {
  readRunningTurnBinding,
  sharesRunningTurnAuthority,
} from "../../src/services/threads/turn-authority.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  type HostRpcHandlerResult,
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

const PROVIDER_THREAD_ID = "provider-shared-thread";
const HELD_INPUT = "Held follow-up";
const FILLER_COUNT = 70;

const text = (value: string) => [{ type: "text", text: value, mentions: [] }];

const turnSubmitSchema = z.object({
  type: z.literal("turn.submit"),
  threadId: z.string(),
  requestId: z.string(),
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

interface HeldRefusal {
  release(): void;
  released: Promise<void>;
}

function createHeldRefusal(): HeldRefusal {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, released };
}

function respondAsReadyDaemon(
  harness: TestAppHarness,
  fixture: Fixture,
  held: HeldRefusal,
): HostRpcResponder {
  let refused = false;
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
        case "host.read_workspace_agent_context":
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        case "turn.submit": {
          const command = turnSubmitSchema.parse(request.command);
          if (!refused && submittedText(command) === HELD_INPUT) {
            refused = true;
            await held.released;
            return {
              ok: false,
              errorCode: "turn_binding_mismatch",
              errorMessage: "The live turn differs from the expected turn",
            };
          }
          return { ok: true, result: { trace: { spans: [] } } };
        }
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

function submittedText(command: TurnSubmit): string {
  return command.input.map((item) => item.text ?? "").join("");
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

function submitsOf(
  daemon: HostRpcResponder,
  threadId: string,
  value: string,
): TurnSubmit[] {
  return turnSubmits(daemon, threadId).filter(
    (command) => submittedText(command) === value,
  );
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
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

async function cappedToken(
  harness: TestAppHarness,
  fixture: Fixture,
  userId: string,
): Promise<string> {
  const thread = getThread(harness.db, fixture.thread.id);
  if (thread === null) throw new Error("thread not found");
  const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
    authorRoleCeiling: "member",
    authorUserId: userId,
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

async function send(
  harness: TestAppHarness,
  fixture: Fixture,
  headers: Record<string, string>,
  value: string,
): Promise<void> {
  const sent = await postJson(
    harness,
    `/api/v1/threads/${fixture.thread.id}/send`,
    headers,
    { input: text(value), mode: "auto" },
  );
  expect(sent.status, await sent.clone().text()).toBe(200);
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
}

function systemErrorCodes(harness: TestAppHarness, threadId: string): string[] {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "system/error")
    .map(
      (event) =>
        z.object({ code: z.string() }).parse(JSON.parse(event.data)).code,
    );
}

async function settleBackgroundWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

interface RefusalScenario {
  alice: Member;
  bob: Member;
  daemon: HostRpcResponder;
  fixture: Fixture;
  held: HeldRefusal;
  heldSend: Promise<void>;
  heldSubmit: TurnSubmit;
}

async function steerPastTheRequestCacheWhileARefusalIsHeld(
  harness: TestAppHarness,
): Promise<RefusalScenario> {
  const { alice, bob } = await bootstrapTeam(harness);
  const fixture = seedIdleThread(harness, bob.id);
  const held = createHeldRefusal();
  const daemon = respondAsReadyDaemon(harness, fixture, held);
  const capped = await cappedToken(harness, fixture, alice.id);

  await send(harness, fixture, bearer(capped), "Capped work");
  const started = await waitFor(
    () => submitsOf(daemon, fixture.thread.id, "Capped work")[0],
  );
  expect(started.target.mode).toBe("start");
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: fixture.thread.id,
    turnId: "turn-capped",
  });

  const heldSend = send(harness, fixture, bearer(capped), HELD_INPUT);
  const heldSubmit = await waitFor(
    () => submitsOf(daemon, fixture.thread.id, HELD_INPUT)[0],
  );
  expect(heldSubmit.target).toMatchObject({ mode: "auto" });
  for (let index = 0; index < FILLER_COUNT; index += 1) {
    await send(harness, fixture, bearer(capped), `Filler ${index}`);
  }
  expect(
    turnSubmits(daemon, fixture.thread.id).filter((command) =>
      submittedText(command).startsWith("Filler "),
    ),
  ).toHaveLength(FILLER_COUNT);
  return { alice, bob, daemon, fixture, held, heldSend, heldSubmit };
}

describe("requeueing input the daemon refused for a different live turn", () => {
  it("keeps the original author and ceiling after many later requests and dispatches with that author's token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, daemon, fixture, held, heldSend } =
        await steerPastTheRequestCacheWhileARefusalIsHeld(harness);

      held.release();
      await heldSend;
      const requeued = await waitFor(() =>
        listQueuedThreadMessages(harness.db, fixture.thread.id).find((row) =>
          row.content.includes(HELD_INPUT),
        ),
      );
      expect(requeued).toMatchObject({
        authorUserId: alice.id,
        authorRoleCeiling: "member",
      });

      await completeTurn(harness, fixture, "turn-capped");
      const redispatched = await waitFor(
        () => submitsOf(daemon, fixture.thread.id, HELD_INPUT)[1],
      );
      expect(redispatched.target.mode).toBe("start");
      expect(
        await tokenPrincipal(harness, dispatchedToken(redispatched)),
      ).toMatchObject({ userId: alice.id, role: "member" });
    });
  });

  it("drops refused input whose author cannot be recovered with a visible notice instead of running it under any fallback token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { daemon, fixture, held, heldSend, heldSubmit } =
        await steerPastTheRequestCacheWhileARefusalIsHeld(harness);
      harness.db
        .delete(turnRequestAuthors)
        .where(
          and(
            eq(turnRequestAuthors.threadId, fixture.thread.id),
            eq(turnRequestAuthors.requestId, heldSubmit.requestId),
          ),
        )
        .run();

      held.release();
      await heldSend;
      await waitFor(() =>
        systemErrorCodes(harness, fixture.thread.id).includes(
          "turn_request_author_unknown",
        )
          ? true
          : undefined,
      );
      expect(
        listQueuedThreadMessages(harness.db, fixture.thread.id).filter((row) =>
          row.content.includes(HELD_INPUT),
        ),
      ).toEqual([]);

      await completeTurn(harness, fixture, "turn-capped");
      await settleBackgroundWork();
      expect(submitsOf(daemon, fixture.thread.id, HELD_INPUT)).toHaveLength(1);
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("idle");
    });
  });

  it("drops a removed user's queued messages instead of leaving them to run without an author", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = seedIdleThread(harness, alice.id);
      const later = Date.now() + 600_000;
      const queued = await postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/send`,
        { cookie: bob.cookie },
        {
          input: text("Bob's queued work"),
          mode: "auto",
          model: "test-model",
          sendAt: later,
        },
      );
      expect(queued.status, await queued.clone().text()).toBe(200);
      const kept = await postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/send`,
        { cookie: alice.cookie },
        {
          input: text("Alice's queued work"),
          mode: "auto",
          model: "test-model",
          sendAt: later,
        },
      );
      expect(kept.status, await kept.clone().text()).toBe(200);

      const removed = await harness.app.request(`/api/v1/users/${bob.id}`, {
        method: "DELETE",
        headers: { cookie: alice.cookie },
      });
      expect(removed.status, await removed.clone().text()).toBe(200);

      expect(
        listQueuedThreadMessages(harness.db, fixture.thread.id).map((row) => ({
          authorUserId: row.authorUserId,
          content: row.content,
        })),
      ).toEqual([
        {
          authorUserId: alice.id,
          content: expect.stringContaining("Alice's queued work"),
        },
      ]);
    });
  });

  it("recovers the running turn's author from the stored database after a restart", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob, fixture, held, heldSend } =
        await steerPastTheRequestCacheWhileARefusalIsHeld(harness);
      held.release();
      await heldSend;
      const restarted = {
        config: harness.deps.config,
        db: createConnection(harness.db.$client.serialize()),
      };
      try {
        const thread = getThread(restarted.db, fixture.thread.id);
        if (thread === null) throw new Error("thread not found");
        const binding = readRunningTurnBinding(restarted.db, thread.id);
        expect(binding.activeTurnId).toBe("turn-capped");
        expect(
          sharesRunningTurnAuthority(restarted, {
            author: { authorUserId: alice.id, authorRoleCeiling: "member" },
            binding,
            thread,
          }),
        ).toBe(true);
        expect(
          sharesRunningTurnAuthority(restarted, {
            author: { authorUserId: bob.id, authorRoleCeiling: null },
            binding,
            thread,
          }),
        ).toBe(false);
      } finally {
        restarted.db.$client.close();
      }
    });
  });
});
