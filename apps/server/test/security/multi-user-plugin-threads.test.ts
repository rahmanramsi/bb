import { eq } from "drizzle-orm";
import {
  authUsers,
  getThread,
  listQueuedThreadMessages,
  threads,
} from "@bb/db";
import { LOCAL_OWNER_USER_ID } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import { readJson } from "../helpers/json.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

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
