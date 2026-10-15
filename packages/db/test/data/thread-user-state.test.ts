import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_OWNER_USER_ID } from "@bb/domain";
import {
  authUsers,
  createProject,
  createPromptHistoryEntry,
  createQueuedThreadMessage,
  listQueuedThreadMessages,
  setQueuedThreadMessageGroupBoundary,
  createThread,
  getStoredAppearance,
  getThreadForViewer,
  getThreadViewerState,
  hasActiveThreadAttention,
  listActiveVisiblePinnedThreadRootsWithPendingInteractionState,
  listPromptHistoryPage,
  listStoredProjectPromptHistoryRows,
  listStoredUiPreferences,
  listThreadsWithPendingInteractionState,
  noopNotifier,
  pinThread,
  reorderPinnedThread,
  replaceStoredUiPreference,
  setStoredAppearance,
  setThreadLastReadAt,
  threads,
  unpinThread,
  upsertHost,
  type DbConnection,
  type DbNotifier,
} from "../../src/index.js";
import { eq } from "drizzle-orm";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const OTHER_USER_ID = "usr_other";

function insertUser(db: DbConnection, id: string): void {
  const now = new Date(1);
  db.insert(authUsers)
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      role: "member",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function createSpyNotifier(): DbNotifier {
  return {
    notifyThread: vi.fn(),
    notifyProject: vi.fn(),
    notifyEnvironment: vi.fn(),
    notifyHost: vi.fn(),
    notifySystem: vi.fn(),
    notifyUserThread: vi.fn(),
    notifyUserSystem: vi.fn(),
  };
}

describe("per-user thread and settings state", () => {
  let db: DbConnection;
  let projectId: string;

  beforeEach(() => {
    db = createMigratedConnection();
    insertUser(db, OTHER_USER_ID);
    const host = upsertHost(db, noopNotifier, { name: "per-user-host" });
    projectId = createProject(db, noopNotifier, {
      name: "Per user",
      source: { type: "local_path", hostId: host.id, path: "/tmp/per-user" },
    }).project.id;
  });

  afterEach(() => {
    db.$client.close();
  });

  function newThread(createdByUserId: string | null, pinned = false) {
    return createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      createdByUserId,
      pinned,
    });
  }

  it("records the creator and seeds only the creator's read and pin state", () => {
    const thread = newThread(OTHER_USER_ID, true);

    expect(thread.createdByUserId).toBe(OTHER_USER_ID);
    expect(
      getThreadViewerState(db, { threadId: thread.id, userId: OTHER_USER_ID }),
    ).toMatchObject({
      lastReadAt: thread.createdAt,
      pinnedAt: thread.createdAt,
      pinSortKey: expect.any(String),
    });
    expect(
      getThreadViewerState(db, {
        threadId: thread.id,
        userId: LOCAL_OWNER_USER_ID,
      }),
    ).toEqual({
      lastReadAt: thread.createdAt,
      pinnedAt: null,
      pinSortKey: null,
    });
  });

  it("keeps read state independent per user and notifies only the reader", () => {
    const thread = newThread(null);
    db.update(threads)
      .set({ latestAttentionAt: thread.createdAt + 10 })
      .where(eq(threads.id, thread.id))
      .run();
    expect(hasActiveThreadAttention(db, LOCAL_OWNER_USER_ID)).toBe(true);
    expect(hasActiveThreadAttention(db, OTHER_USER_ID)).toBe(true);

    const notifier = createSpyNotifier();
    setThreadLastReadAt(db, notifier, {
      lastReadAt: thread.createdAt + 20,
      threadId: thread.id,
      userId: OTHER_USER_ID,
    });

    expect(hasActiveThreadAttention(db, OTHER_USER_ID)).toBe(false);
    expect(hasActiveThreadAttention(db, LOCAL_OWNER_USER_ID)).toBe(true);
    expect(
      getThreadForViewer(db, { threadId: thread.id, userId: OTHER_USER_ID })
        ?.lastReadAt,
    ).toBe(thread.createdAt + 20);
    expect(
      getThreadForViewer(db, {
        threadId: thread.id,
        userId: LOCAL_OWNER_USER_ID,
      })?.lastReadAt,
    ).toBe(thread.createdAt);
    expect(notifier.notifyUserThread).toHaveBeenCalledWith(
      OTHER_USER_ID,
      thread.id,
      ["read-state-changed"],
      { projectId },
    );
    expect(notifier.notifyThread).not.toHaveBeenCalled();

    setThreadLastReadAt(db, noopNotifier, {
      lastReadAt: null,
      threadId: thread.id,
      userId: LOCAL_OWNER_USER_ID,
    });
    expect(
      getThreadViewerState(db, {
        threadId: thread.id,
        userId: LOCAL_OWNER_USER_ID,
      }).lastReadAt,
    ).toBeNull();
    expect(
      getThreadViewerState(db, { threadId: thread.id, userId: OTHER_USER_ID })
        .lastReadAt,
    ).toBe(thread.createdAt + 20);
  });

  it("keeps pins and pin order independent per user", () => {
    const first = newThread(null);
    const second = newThread(null);
    const third = newThread(null);
    for (const thread of [first, second, third]) {
      pinThread(db, noopNotifier, {
        threadId: thread.id,
        userId: LOCAL_OWNER_USER_ID,
      });
    }
    pinThread(db, noopNotifier, { threadId: second.id, userId: OTHER_USER_ID });
    expect(
      getThreadViewerState(db, { threadId: second.id, userId: OTHER_USER_ID })
        .lastReadAt,
    ).toBe(second.createdAt);

    const pinnedIds = (userId: string) =>
      listActiveVisiblePinnedThreadRootsWithPendingInteractionState(
        db,
        userId,
      ).map((thread) => thread.id);
    expect(pinnedIds(LOCAL_OWNER_USER_ID)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
    expect(pinnedIds(OTHER_USER_ID)).toEqual([second.id]);

    expect(
      reorderPinnedThread({
        db,
        notifier: noopNotifier,
        threadId: first.id,
        userId: LOCAL_OWNER_USER_ID,
        previousThreadId: null,
        nextThreadId: third.id,
      }).kind,
    ).toBe("reordered");
    expect(pinnedIds(LOCAL_OWNER_USER_ID)).toEqual([
      first.id,
      third.id,
      second.id,
    ]);
    expect(pinnedIds(OTHER_USER_ID)).toEqual([second.id]);

    unpinThread(db, noopNotifier, {
      threadId: second.id,
      userId: OTHER_USER_ID,
    });
    expect(pinnedIds(OTHER_USER_ID)).toEqual([]);
    expect(pinnedIds(LOCAL_OWNER_USER_ID)).toContain(second.id);

    const listed = (userId: string) =>
      listThreadsWithPendingInteractionState(db, {
        projectId,
        viewerUserId: userId,
      }).map((thread) => [thread.id, thread.pinnedAt !== null]);
    expect(listed(LOCAL_OWNER_USER_ID).slice(0, 3)).toEqual([
      [first.id, true],
      [third.id, true],
      [second.id, true],
    ]);
    expect(listed(OTHER_USER_ID).every(([, pinned]) => pinned === false)).toBe(
      true,
    );
  });

  it("keeps UI preferences and appearance independent per user", () => {
    expect(
      replaceStoredUiPreference(db, {
        expectedRevision: 0,
        key: "sidebar.organizationMode",
        userId: OTHER_USER_ID,
        valueJson: '"machine"',
      }),
    ).toEqual({ outcome: "updated", revision: 1 });
    expect(listStoredUiPreferences(db, OTHER_USER_ID)).toEqual([
      { key: "sidebar.organizationMode", revision: 1, valueJson: '"machine"' },
    ]);
    expect(listStoredUiPreferences(db, LOCAL_OWNER_USER_ID)).toEqual([]);
    expect(
      replaceStoredUiPreference(db, {
        expectedRevision: 0,
        key: "sidebar.organizationMode",
        userId: LOCAL_OWNER_USER_ID,
        valueJson: '"project"',
      }),
    ).toEqual({ outcome: "updated", revision: 1 });

    setStoredAppearance(db, OTHER_USER_ID, {
      themeId: "nord",
      faviconColor: "teal",
    });
    expect(getStoredAppearance(db, OTHER_USER_ID)).toEqual({
      themeId: "nord",
      faviconColor: "teal",
    });
    expect(getStoredAppearance(db, LOCAL_OWNER_USER_ID).themeId).not.toBe(
      "nord",
    );
  });

  it("lists prompt history for its author only", () => {
    const thread = newThread(null);
    for (const [index, userId] of [
      LOCAL_OWNER_USER_ID,
      OTHER_USER_ID,
    ].entries()) {
      createPromptHistoryEntry(db, {
        createdAt: 10 + index,
        input: [{ type: "text", text: `from ${userId}`, mentions: [] }],
        projectId,
        requestSequence: index + 1,
        scope: "project",
        threadId: thread.id,
        userId,
      });
    }

    const page = (userId: string) =>
      listPromptHistoryPage(db, { before: null, limit: 10, userId }).map(
        (row) => row.input,
      );
    expect(page(OTHER_USER_ID)).toEqual([
      JSON.stringify([
        { type: "text", text: `from ${OTHER_USER_ID}`, mentions: [] },
      ]),
    ]);
    expect(
      listStoredProjectPromptHistoryRows(db, {
        limit: 10,
        projectId,
        userId: LOCAL_OWNER_USER_ID,
      }).map((row) => row.requestSequence),
    ).toEqual([1]);
  });

  it("does not group queued messages from different users and filters queued history by author", () => {
    const thread = newThread(null);
    const queued = [LOCAL_OWNER_USER_ID, OTHER_USER_ID].map((authorUserId) =>
      createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        authorUserId,
        content: [{ type: "text", text: authorUserId, mentions: [] }],
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "auto",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      }),
    );
    const result = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      groupBoundaryQueuedMessageId: queued[1]!.id,
      expectedGroupedPrefixQueuedMessageIds: queued.map((row) => row.id),
    });
    expect(result.kind).toBe("invalid_sender");
    expect(
      listQueuedThreadMessages(db, thread.id, OTHER_USER_ID).map(
        (row) => row.id,
      ),
    ).toEqual([queued[1]!.id]);
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.groupWithNext),
    ).toEqual([false, false]);
  });
});
