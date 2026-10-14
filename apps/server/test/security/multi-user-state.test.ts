import { createPromptHistoryEntry, listQueuedThreadMessages } from "@bb/db";
import type { PendingInteractionCreate } from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import { onClientSocketOpen } from "../../src/ws/client-protocol.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { readJson } from "../helpers/json.js";
import {
  createAllowOnceResolution,
  createCommandApprovalPayload,
} from "../helpers/pending-interactions.js";
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

interface Team {
  alice: Member;
  bob: Member;
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

async function bootstrapTeam(harness: TestAppHarness): Promise<Team> {
  const alice = await signUp(harness, {
    email: "alice@example.test",
    name: "Alice",
    password: "correct horse battery",
  });
  const invite = await harness.app.request("/api/v1/auth/invites", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: alice.cookie },
    body: JSON.stringify({}),
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

function request(
  harness: TestAppHarness,
  member: Member,
  path: string,
  init: { body?: unknown; method?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    harness.app.request(path, {
      method: init.method ?? "GET",
      headers: {
        cookie: member.cookie,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

async function json<T>(response: Promise<Response>): Promise<T> {
  const resolved = await response;
  expect(resolved.status).toBeLessThan(300);
  return (await readJson(resolved)) as T;
}

interface ThreadView {
  createdByUserId: string | null;
  lastReadAt: number | null;
  pinnedAt: number | null;
}

describe("multi-user per-user state", () => {
  it("attributes newly created threads and their initial queued prompt to the caller", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const { environment, project } = seedThreadFixture(harness);
      const created = await json<ThreadView & { id: string }>(
        request(harness, bob, "/api/v1/threads", {
          method: "POST",
          body: {
            origin: "app",
            projectId: project.id,
            providerId: "codex",
            input: [
              { type: "text", text: "Bob's initial prompt", mentions: [] },
            ],
            sendAt: Date.now() + 600_000,
            environment: { type: "reuse", environmentId: environment.id },
          },
        }),
      );
      expect(created.createdByUserId).toBe(bob.id);
      expect(listQueuedThreadMessages(harness.db, created.id)).toMatchObject([
        { authorUserId: bob.id },
      ]);
      expect(
        await json<Array<{ input: Array<{ text: string }> }>>(
          request(harness, bob, `/api/v1/threads/${created.id}/prompt-history`),
        ),
      ).toMatchObject([{ input: [{ text: "Bob's initial prompt" }] }]);
      expect(
        await json(
          request(
            harness,
            alice,
            `/api/v1/threads/${created.id}/prompt-history`,
          ),
        ),
      ).toEqual([]);
    });
  });

  it("keeps read, unread, pin, and attention state per user", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const { thread, project } = seedThreadFixture(harness);
      const other = seedThread(harness.deps, { projectId: project.id });
      const threadPath = `/api/v1/threads/${thread.id}`;

      await json(
        request(harness, alice, `${threadPath}/unread`, { method: "POST" }),
      );
      expect(
        (await json<ThreadView>(request(harness, alice, threadPath)))
          .lastReadAt,
      ).toBeNull();
      expect(
        (await json<ThreadView>(request(harness, bob, threadPath))).lastReadAt,
      ).toBe(thread.createdAt);
      expect(
        await json(request(harness, alice, "/api/v1/system/attention")),
      ).toEqual({ hasAttention: true });
      expect(
        await json(request(harness, bob, "/api/v1/system/attention")),
      ).toEqual({ hasAttention: false });

      await json(
        request(harness, bob, `${threadPath}/pin`, { method: "POST" }),
      );
      await json(
        request(harness, bob, `/api/v1/threads/${other.id}/pin`, {
          method: "POST",
        }),
      );
      expect(
        (await json<ThreadView>(request(harness, bob, threadPath))).pinnedAt,
      ).not.toBeNull();
      expect(
        (await json<ThreadView>(request(harness, alice, threadPath))).pinnedAt,
      ).toBeNull();

      const listed = async (member: Member) =>
        (
          await json<Array<{ id: string; pinnedAt: number | null }>>(
            request(harness, member, `/api/v1/threads?projectId=${project.id}`),
          )
        ).map((entry) => [entry.id, entry.pinnedAt !== null]);
      expect(await listed(bob)).toEqual([
        [other.id, true],
        [thread.id, true],
      ]);
      expect(
        (await listed(alice)).every(([, pinned]) => pinned === false),
      ).toBe(true);

      const reordered = await json<Array<{ id: string }>>(
        request(harness, bob, `${threadPath}/pin-order`, {
          method: "PATCH",
          body: { previousThreadId: null, nextThreadId: other.id },
        }),
      );
      expect(reordered.map((entry) => entry.id)).toEqual([thread.id, other.id]);
      expect(await listed(alice)).not.toContainEqual([thread.id, true]);
    });
  });

  it("keeps UI preferences, appearance, and prompt history per user", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);

      await json(
        request(
          harness,
          alice,
          "/api/v1/preferences/ui/sidebar.organizationMode",
          {
            method: "PUT",
            body: { expectedRevision: 0, value: "machine" },
          },
        ),
      );
      const preferences = async (member: Member) =>
        (
          await json<{
            preferences: Record<string, { revision: number; value: unknown }>;
          }>(request(harness, member, "/api/v1/preferences/ui"))
        ).preferences["sidebar.organizationMode"];
      expect(await preferences(alice)).toEqual({
        revision: 1,
        value: "machine",
      });
      expect((await preferences(bob))?.revision).toBe(0);

      await json(
        request(harness, bob, "/api/v1/settings/appearance", {
          method: "PUT",
          body: { themeId: "nord", faviconColor: "teal" },
        }),
      );
      const appearance = async (member: Member) =>
        (
          await json<{ appearance: { themeId: string; faviconColor: string } }>(
            request(harness, member, "/api/v1/system/config"),
          )
        ).appearance;
      expect(await appearance(bob)).toMatchObject({
        themeId: "nord",
        faviconColor: "teal",
      });
      expect((await appearance(alice)).themeId).not.toBe("nord");

      const { thread, project } = seedThreadFixture(harness);
      for (const [index, member] of [alice, bob].entries()) {
        createPromptHistoryEntry(harness.db, {
          createdAt: 10 + index,
          input: [{ type: "text", text: `prompt ${index}`, mentions: [] }],
          projectId: project.id,
          requestSequence: index + 1,
          scope: "project",
          threadId: thread.id,
          userId: member.id,
        });
      }
      const history = async (member: Member) =>
        (
          await json<{ entries: Array<{ input: Array<{ text?: string }> }> }>(
            request(harness, member, "/api/v1/prompt-history"),
          )
        ).entries.map((entry) => entry.input[0]?.text);
      expect(await history(alice)).toEqual(["prompt 0"]);
      expect(await history(bob)).toEqual(["prompt 1"]);
    });
  });

  it("records who wrote queued messages and who resolved interactions", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-multi-user-attribution",
        threadId: thread.id,
      });
      await json(
        request(harness, bob, `/api/v1/threads/${thread.id}/unread`, {
          method: "POST",
        }),
      );

      const queued = await json<{ delivery: string }>(
        request(harness, bob, `/api/v1/threads/${thread.id}/send`, {
          method: "POST",
          body: {
            input: [{ type: "text", text: "Queued by Bob", mentions: [] }],
            mode: "queue-if-active",
          },
        }),
      );
      expect(queued.delivery).toBe("queued");
      expect(
        (
          await json<ThreadView>(
            request(harness, bob, `/api/v1/threads/${thread.id}`),
          )
        ).lastReadAt,
      ).toBeNull();
      expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
        { authorUserId: bob.id },
      ]);
      expect(
        await json(
          request(
            harness,
            alice,
            `/api/v1/threads/${thread.id}/queued-messages`,
          ),
        ),
      ).toMatchObject([{ authorUserId: bob.id, initiator: "user" }]);

      const interaction: PendingInteractionCreate = {
        threadId: thread.id,
        turnId: "turn-multi-user",
        providerId: "codex",
        providerThreadId: "provider-multi-user-attribution",
        providerRequestId: "request-multi-user",
        payload: createCommandApprovalPayload({
          itemId: "item-multi-user",
          reason: "Approve command",
          command: "git push",
          cwd: "/tmp/project",
        }),
      };
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: interaction.turnId,
        providerThreadId: interaction.providerThreadId,
      });
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction,
        });
      if (registered.outcome === "rejected") {
        throw new Error(registered.reason);
      }
      expect(
        await json(
          request(
            harness,
            alice,
            `/api/v1/threads/${thread.id}/interactions/${registered.interaction.id}/resolve`,
            { method: "POST", body: createAllowOnceResolution() },
          ),
        ),
      ).toMatchObject({ status: "resolving", resolvedByUserId: alice.id });

      const users = await json<{ users: Array<{ id: string; name: string }> }>(
        request(harness, bob, "/api/v1/users/directory"),
      );
      expect(users.users).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: alice.id, name: "Alice" }),
          expect.objectContaining({ id: bob.id, name: "Bob" }),
        ]),
      );
    });
  });
});

describe("per-user realtime routing", () => {
  it("sends per-user changes only to that user's sockets and broadcasts shared changes", () => {
    const hub = new NotificationHub();
    const aliceSocket = { close: vi.fn(), send: vi.fn() };
    const bobSocket = { close: vi.fn(), send: vi.fn() };
    onClientSocketOpen(hub, aliceSocket, "usr_alice");
    onClientSocketOpen(hub, bobSocket, "usr_bob");
    for (const socket of [aliceSocket, bobSocket]) {
      hub.subscribe(socket, { kind: "thread-list" });
      hub.subscribe(socket, { kind: "system" });
    }

    hub.notifyUserThread("usr_alice", "thr_1", ["read-state-changed"], {
      projectId: "proj_1",
    });
    hub.notifyUserSystem("usr_bob", ["ui-preferences-changed"]);
    expect(aliceSocket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(aliceSocket.send.mock.calls[0]?.[0])).toMatchObject({
      entity: "thread",
      id: "thr_1",
      changes: ["read-state-changed"],
    });
    expect(bobSocket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(bobSocket.send.mock.calls[0]?.[0])).toMatchObject({
      entity: "system",
      changes: ["ui-preferences-changed"],
    });

    hub.notifyThread("thr_1", ["title-changed"], { projectId: "proj_1" });
    expect(aliceSocket.send).toHaveBeenCalledTimes(2);
    expect(bobSocket.send).toHaveBeenCalledTimes(2);
  });
});
