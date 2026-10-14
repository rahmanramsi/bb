import { and, eq } from "drizzle-orm";
import {
  getThread,
  listEvents,
  threads,
  turnRequestAuthors,
} from "@bb/db";
import type { ResolvedThreadExecutionOptions, RoleCeiling } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  advanceThreadProvisioning,
  requestThreadProvision,
} from "../../src/services/threads/thread-provisioning.js";
import { readThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import {
  reportQueuedCommandError,
  waitForQueuedCommand,
  type QueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const EXECUTION = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  source: "client/turn/requested",
} satisfies ResolvedThreadExecutionOptions;

const PENDING_INPUT = "run bb whoami while setup finishes";

interface Member {
  cookie: string;
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
  const { user } = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await response.json());
  return { cookie: cookieHeader(response), id: user.id };
}

async function inviteMember(
  harness: TestAppHarness,
  admin: Member,
  name: string,
): Promise<Member> {
  const invite = await harness.app.request("/api/v1/auth/invites", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ role: "member" }),
  });
  expect(invite.status).toBe(201);
  const { token } = z.object({ token: z.string() }).parse(await invite.json());
  return signUp(harness, {
    email: `${name}@example.test`,
    inviteToken: token,
    name,
    password: `${name} long enough password`,
  });
}

async function bootstrapTeam(harness: TestAppHarness) {
  const alice = await signUp(harness, {
    email: "alice@example.test",
    name: "Alice",
    password: "correct horse battery",
  });
  const bob = await inviteMember(harness, alice, "bob");
  const carol = await inviteMember(harness, alice, "carol");
  return { alice, bob, carol };
}

function seedStartingThreadOwnedBy(harness: TestAppHarness, ownerId: string) {
  const { host } = seedHostSession(harness.deps, { id: "host-provisioning" });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/provisioning-author",
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "starting",
  });
  harness.db
    .update(threads)
    .set({ createdByUserId: ownerId })
    .where(eq(threads.id, thread.id))
    .run();
  const owned = getThread(harness.db, thread.id);
  if (owned === null) throw new Error("thread not found");
  return { environment, thread: owned };
}

function requestProvisionAs(
  harness: TestAppHarness,
  seeded: ReturnType<typeof seedStartingThreadOwnedBy>,
  author: { authorRoleCeiling: RoleCeiling | null; authorUserId: string | null },
) {
  return requestThreadProvision(harness.deps, {
    ...author,
    thread: seeded.thread,
    environmentIntent: { type: "reuse", environmentId: seeded.environment.id },
    execution: EXECUTION,
    fork: null,
    input: textInput(PENDING_INPUT),
    startedOnBehalfOf: null,
    titleProvided: true,
  });
}

async function finishProvisioning(
  harness: TestAppHarness,
  threadId: string,
): Promise<{ advance: Promise<void>; started: QueuedCommand | null }> {
  const advance = advanceThreadProvisioning(harness.deps, { threadId });
  const isStart = ({ command }: QueuedCommand) =>
    command.type === "thread.start" && command.threadId === threadId;
  await Promise.race([advance, waitForQueuedCommand(harness, isStart)]);
  const started = await waitForQueuedCommand(harness, isStart, 50).catch(
    () => null,
  );
  return { advance, started };
}

async function releaseStart(
  harness: TestAppHarness,
  run: { advance: Promise<void>; started: QueuedCommand | null },
): Promise<void> {
  if (run.started !== null) {
    await reportQueuedCommandError(harness, run.started, {
      errorCode: "test_cleanup",
      errorMessage: "test cleanup",
    });
  }
  await run.advance;
}

async function startedPrincipal(
  harness: TestAppHarness,
  started: QueuedCommand | null,
) {
  const command = z
    .object({
      contributedEnv: z.array(
        z.object({ name: z.string(), value: z.unknown() }),
      ),
    })
    .parse(started?.command);
  const token = command.contributedEnv.find(
    (entry) => entry.name === "BB_TOKEN",
  )?.value;
  return harness.deps.userAuth.resolvePrincipal(
    new Headers({ authorization: `Bearer ${z.string().parse(token)}` }),
  );
}

function systemErrorCodes(harness: TestAppHarness, threadId: string): string[] {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "system/error")
    .map(
      (event) =>
        z.object({ code: z.string() }).parse(JSON.parse(event.data)).code,
    );
}

function expectRefusedAndIdle(
  harness: TestAppHarness,
  run: { started: QueuedCommand | null },
  threadId: string,
): void {
  expect(run.started?.command ?? null).toBeNull();
  expect(systemErrorCodes(harness, threadId)).toContain(
    "turn_request_author_unknown",
  );
  expect(getThread(harness.db, threadId)?.status).toBe("idle");
  expect(readThreadProvisionContext(harness.db, threadId)).toBeNull();
}

describe("a provisioning thread starts its pending input only as a known author", () => {
  it("does not run a removed member's pending input under the thread creator's token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { alice, bob, carol } = await bootstrapTeam(harness);
      const seeded = seedStartingThreadOwnedBy(harness, bob.id);
      requestProvisionAs(harness, seeded, {
        authorRoleCeiling: null,
        authorUserId: carol.id,
      });

      const removed = await harness.app.request(`/api/v1/users/${carol.id}`, {
        method: "DELETE",
        headers: { cookie: alice.cookie },
      });
      expect(removed.status).toBe(200);
      const run = await finishProvisioning(harness, seeded.thread.id);
      await releaseStart(harness, run);

      expectRefusedAndIdle(harness, run, seeded.thread.id);
    });
  });

  it("does not run a legacy pending input that has no recorded author", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { bob } = await bootstrapTeam(harness);
      const seeded = seedStartingThreadOwnedBy(harness, bob.id);
      const context = requestProvisionAs(harness, seeded, {
        authorRoleCeiling: null,
        authorUserId: bob.id,
      });
      harness.db
        .delete(turnRequestAuthors)
        .where(
          and(
            eq(turnRequestAuthors.threadId, seeded.thread.id),
            eq(
              turnRequestAuthors.requestId,
              context.request.clientRequestId,
            ),
          ),
        )
        .run();

      const run = await finishProvisioning(harness, seeded.thread.id);
      await releaseStart(harness, run);

      expectRefusedAndIdle(harness, run, seeded.thread.id);
    });
  });

  it("still applies the system-author rule when the row records a system author", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { bob } = await bootstrapTeam(harness);
      const seeded = seedStartingThreadOwnedBy(harness, bob.id);
      requestProvisionAs(harness, seeded, {
        authorRoleCeiling: null,
        authorUserId: null,
      });

      const run = await finishProvisioning(harness, seeded.thread.id);
      try {
        expect(await startedPrincipal(harness, run.started)).toMatchObject({
          userId: bob.id,
          role: "member",
          roleCeiling: "member",
        });
        expect(systemErrorCodes(harness, seeded.thread.id)).not.toContain(
          "turn_request_author_unknown",
        );
      } finally {
        await releaseStart(harness, run);
      }
    });
  });

  it("starts a normal first turn with its author's own token", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { bob } = await bootstrapTeam(harness);
      const seeded = seedStartingThreadOwnedBy(harness, bob.id);
      requestProvisionAs(harness, seeded, {
        authorRoleCeiling: null,
        authorUserId: bob.id,
      });

      const run = await finishProvisioning(harness, seeded.thread.id);
      try {
        expect(await startedPrincipal(harness, run.started)).toMatchObject({
          userId: bob.id,
          role: "member",
          roleCeiling: null,
        });
      } finally {
        await releaseStart(harness, run);
      }
    });
  });
});
