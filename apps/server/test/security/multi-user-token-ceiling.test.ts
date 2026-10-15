import { eq } from "drizzle-orm";
import { getThread, listQueuedThreadMessages, threads } from "@bb/db";
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

async function shellToken(
  harness: TestAppHarness,
  fixture: Fixture,
  threadId: string,
  author: {
    authorGrantId: string | null;
    authorRoleCeiling: "member" | null;
    authorUserId: string | null;
  },
): Promise<string | null> {
  const thread = getThread(harness.db, threadId);
  if (thread === null) throw new Error("thread not found");
  const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
    ...author,
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

async function cappedShellToken(
  harness: TestAppHarness,
  fixture: Fixture,
  threadId: string,
): Promise<string> {
  const token = await shellToken(harness, fixture, threadId, {
    authorGrantId: null,
    authorRoleCeiling: null,
    authorUserId: LOCAL_OWNER_USER_ID,
  });
  if (token === null) throw new Error("no inferred shell credential");
  return token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function listUsersStatus(
  harness: TestAppHarness,
  headers: Record<string, string>,
): Promise<number> {
  const response = await harness.app.request("/api/v1/users", { headers });
  return response.status;
}

async function createPat(
  harness: TestAppHarness,
  headers: Record<string, string>,
): Promise<Response> {
  return harness.app.request("/api/v1/auth/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name: "laptop" }),
  });
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

async function queuedRowToken(
  harness: TestAppHarness,
  fixture: Fixture,
  threadId: string,
): Promise<string | null> {
  const [queued] = listQueuedThreadMessages(harness.db, threadId);
  if (queued === undefined) throw new Error("message not queued");
  return shellToken(harness, fixture, threadId, {
    authorGrantId: queued.authorGrantId,
    authorRoleCeiling: queued.authorRoleCeiling,
    authorUserId: queued.authorUserId,
  });
}

const text = (value: string) => [{ type: "text", text: value, mentions: [] }];

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

describe("credentials derived from a role-capped BB_TOKEN", () => {
  it("refuses PAT creation from a capped token while uncapped credentials still create one", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      setThreadCreator(harness, fixture.thread.id, bob.id);
      const capped = await cappedShellToken(
        harness,
        fixture,
        fixture.thread.id,
      );

      const refused = await createPat(harness, bearer(capped));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: "credential_role_capped",
      });
      expect(
        harness.deps.userAuth.listPersonalAccessTokens(bob.id),
      ).toHaveLength(0);

      const direct = await shellToken(harness, fixture, fixture.thread.id, {
        authorGrantId: null,
        authorRoleCeiling: null,
        authorUserId: bob.id,
      });
      if (direct === null) throw new Error("no direct shell credential");
      expect((await createPat(harness, bearer(direct))).status).toBe(201);
      expect((await createPat(harness, { cookie: bob.cookie })).status).toBe(
        201,
      );
      expect((await createPat(harness, { cookie: alice.cookie })).status).toBe(
        201,
      );
    });
  });

  it("dispatches a capped BB_TOKEN for a turn sent with a capped token, even after promotion", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness, {
        environment: { status: "ready" },
        thread: { status: "idle" },
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: fixture.environment.id,
        providerThreadId: "provider-member-thread",
        threadId: fixture.thread.id,
      });
      setThreadCreator(harness, fixture.thread.id, bob.id);
      const capped = await cappedShellToken(
        harness,
        fixture,
        fixture.thread.id,
      );
      const daemon = respondAsReadyDaemon(harness, fixture);

      const sent = await postJson(
        harness,
        `/api/v1/threads/${fixture.thread.id}/send`,
        bearer(capped),
        { input: text("Run bb"), mode: "auto" },
      );
      expect(sent.status, await sent.clone().text()).toBe(200);

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
            contributedEnv: z.array(
              z.object({ name: z.string(), value: z.unknown() }),
            ),
          }),
        })
        .parse(submitted).resumeContext.contributedEnv;
      const dispatched = z
        .string()
        .parse(contributed.find((entry) => entry.name === "BB_TOKEN")?.value);
      expect(
        await harness.deps.userAuth.resolvePrincipal(
          new Headers(bearer(dispatched)),
        ),
      ).toMatchObject({ userId: bob.id, role: "member" });

      const patResponse = await createPat(harness, { cookie: bob.cookie });
      expect(patResponse.status).toBe(201);
      const { token: pat } = z
        .object({ token: z.string() })
        .parse(await patResponse.json());

      await promote(harness, alice, bob.id);

      expect(await listUsersStatus(harness, bearer(capped))).toBe(403);
      expect(await listUsersStatus(harness, bearer(dispatched))).toBe(403);
      expect((await createPat(harness, bearer(dispatched))).status).toBe(403);
      expect(await listUsersStatus(harness, bearer(pat))).toBe(200);
      expect(await listUsersStatus(harness, { cookie: bob.cookie })).toBe(200);
    });
  });

  it("persists the ceiling on threads and queued messages created with a capped token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      setThreadCreator(harness, fixture.thread.id, bob.id);
      const capped = await cappedShellToken(
        harness,
        fixture,
        fixture.thread.id,
      );
      const later = Date.now() + 600_000;

      const created = await postJson(
        harness,
        "/api/v1/threads",
        bearer(capped),
        {
          origin: "app",
          projectId: fixture.project.id,
          providerId: "codex",
          input: text("Do the work"),
          sendAt: later,
          environment: { type: "reuse", environmentId: fixture.environment.id },
        },
      );
      expect(created.status, await created.clone().text()).toBe(201);
      const createdThread = z
        .object({ id: z.string() })
        .parse(await created.json());

      const scheduled = await postJson(
        harness,
        `/api/v1/threads/${createdThread.id}/send`,
        bearer(capped),
        {
          input: text("Later"),
          mode: "auto",
          model: "test-model",
          sendAt: later,
        },
      );
      expect(scheduled.status, await scheduled.clone().text()).toBe(200);

      const queuedTarget = seedThreadFixture(harness);
      setThreadCreator(harness, queuedTarget.thread.id, bob.id);
      const queued = await postJson(
        harness,
        `/api/v1/threads/${queuedTarget.thread.id}/queued-messages`,
        bearer(capped),
        { input: text("Queued"), model: "test-model" },
      );
      expect(queued.status, await queued.clone().text()).toBe(201);

      const derived = [
        await queuedRowToken(harness, fixture, createdThread.id),
        await queuedRowToken(harness, queuedTarget, queuedTarget.thread.id),
      ];
      const scheduledRows = listQueuedThreadMessages(
        harness.db,
        createdThread.id,
      );
      expect(scheduledRows.length).toBeGreaterThanOrEqual(2);
      for (const row of scheduledRows) {
        expect(row.authorUserId).toBe(bob.id);
        derived.push(
          await shellToken(harness, fixture, createdThread.id, {
            authorGrantId: row.authorGrantId,
            authorRoleCeiling: row.authorRoleCeiling,
            authorUserId: row.authorUserId,
          }),
        );
      }

      await promote(harness, alice, bob.id);

      for (const token of derived) {
        if (token === null) throw new Error("no derived shell credential");
        expect(await listUsersStatus(harness, bearer(token))).toBe(403);
      }
      const ownTurn = await shellToken(harness, fixture, createdThread.id, {
        authorGrantId: null,
        authorRoleCeiling: null,
        authorUserId: bob.id,
      });
      if (ownTurn === null) throw new Error("no direct shell credential");
      expect(await listUsersStatus(harness, bearer(ownTurn))).toBe(200);
    });
  });

  it("caps a queued message edited with a capped token and leaves uncapped edits alone", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob } = await bootstrapTeam(harness);
      const fixture = seedThreadFixture(harness);
      setThreadCreator(harness, fixture.thread.id, bob.id);
      const capped = await cappedShellToken(
        harness,
        fixture,
        fixture.thread.id,
      );
      const queuedPath = `/api/v1/threads/${fixture.thread.id}/queued-messages`;
      const queued = await postJson(
        harness,
        queuedPath,
        { cookie: bob.cookie },
        {
          input: text("Queued by Bob"),
          model: "test-model",
        },
      );
      expect(queued.status, await queued.clone().text()).toBe(201);
      const edit = async (headers: Record<string, string>, value: string) => {
        const [row] = listQueuedThreadMessages(harness.db, fixture.thread.id);
        if (row === undefined) throw new Error("message not queued");
        const response = await harness.app.request(`${queuedPath}/${row.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            expectedUpdatedAt: row.updatedAt,
            input: text(value),
          }),
        });
        expect(response.status, await response.clone().text()).toBe(200);
      };

      await edit({ cookie: bob.cookie }, "Edited by Bob");
      expect(
        listQueuedThreadMessages(harness.db, fixture.thread.id)[0]
          ?.authorRoleCeiling,
      ).toBeNull();

      await edit(bearer(capped), "Edited by a capped token");
      await edit({ cookie: bob.cookie }, "Edited by Bob again");
      const token = await queuedRowToken(harness, fixture, fixture.thread.id);
      if (token === null) throw new Error("no derived shell credential");

      await promote(harness, alice, bob.id);

      expect(await listUsersStatus(harness, bearer(token))).toBe(403);
    });
  });
});
