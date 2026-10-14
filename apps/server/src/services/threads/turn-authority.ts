import { and, desc, eq, sql } from "drizzle-orm";
import {
  createQueuedThreadMessageInTransaction,
  events,
  type DbNotifier,
  type DbQueryConnection,
  type DbTransaction,
} from "@bb/db";
import {
  systemMessageKindSchema,
  systemMessageSubjectSchema,
  type ThreadRecord,
} from "@bb/domain";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import {
  resolveThreadShellCredential,
  type ThreadShellCredential,
} from "./thread-runtime-config.js";
import { getActiveTurnId } from "./thread-events.js";
import {
  readTurnRequestAuthor,
  type TurnAuthor,
} from "./turn-request-authors.js";

function latestTurnStartRequestId(
  db: DbQueryConnection,
  threadId: string,
): string | null {
  const row = db
    .select({
      requestId: sql<
        string | null
      >`json_extract(${events.data}, '$.requestId')`,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "client/turn/requested"),
        sql`json_extract(${events.data}, '$.target.kind') IN ('thread-start', 'new-turn')`,
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  return row?.requestId ?? null;
}

function sameCredential(
  left: ThreadShellCredential | null,
  right: ThreadShellCredential | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.userId === right.userId && left.roleCeiling === right.roleCeiling;
}

export interface RunningTurnBinding {
  activeTurnId: string | null;
  turnStartRequestId: string | null;
}

export function readRunningTurnBinding(
  db: DbQueryConnection,
  threadId: string,
): RunningTurnBinding {
  return {
    activeTurnId: getActiveTurnId({ db }, threadId),
    turnStartRequestId: latestTurnStartRequestId(db, threadId),
  };
}

export function bindsSteersToExpectedTurn(
  deps: Pick<AppDeps, "config">,
): boolean {
  return deps.config.authMode === "multi";
}

export function runningTurnBindingHolds(
  deps: Pick<AppDeps, "config">,
  args: {
    binding: RunningTurnBinding;
    db: DbQueryConnection;
    threadId: string;
  },
): boolean {
  if (!bindsSteersToExpectedTurn(deps)) return true;
  const current = readRunningTurnBinding(args.db, args.threadId);
  return (
    current.activeTurnId === args.binding.activeTurnId &&
    current.turnStartRequestId === args.binding.turnStartRequestId
  );
}

export function sharesRunningTurnAuthority(
  deps: Pick<AppDeps, "config" | "db">,
  args: {
    author: TurnAuthor;
    binding: RunningTurnBinding;
    thread: ThreadRecord;
  },
): boolean {
  if (deps.config.authMode !== "multi") return true;
  const requestId = args.binding.turnStartRequestId;
  if (requestId === null) return false;
  const runningAuthor = readTurnRequestAuthor({
    requestId,
    threadId: args.thread.id,
  });
  if (runningAuthor === null) return false;
  return sameCredential(
    resolveThreadShellCredential(deps, {
      ...runningAuthor,
      thread: args.thread,
    }),
    resolveThreadShellCredential(deps, { ...args.author, thread: args.thread }),
  );
}

const refusedTurnRequestSchema = z.object({
  senderThreadId: z.string().nullable(),
  systemMessageKind: systemMessageKindSchema.optional(),
  systemMessageSubject: systemMessageSubjectSchema.nullable().optional(),
});

export function requeueTurnSubmitRefusedForBindingInTransaction(
  deps: { db: DbTransaction; hub: DbNotifier },
  command: Extract<HostDaemonCommand, { type: "turn.submit" }>,
): void {
  const row = deps.db
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, command.threadId),
        eq(events.type, "client/turn/requested"),
        sql`json_extract(${events.data}, '$.requestId') = ${command.requestId}`,
      ),
    )
    .limit(1)
    .get();
  if (row === undefined) return;
  const request = refusedTurnRequestSchema.parse(JSON.parse(row.data));
  const author = readTurnRequestAuthor({
    requestId: command.requestId,
    threadId: command.threadId,
  });
  createQueuedThreadMessageInTransaction(deps.db, {
    threadId: command.threadId,
    content: command.input,
    senderThreadId: request.senderThreadId,
    authorUserId: author?.authorUserId ?? null,
    authorRoleCeiling: author?.authorRoleCeiling ?? null,
    origin: null,
    originPluginId: null,
    model: command.options.model,
    reasoningLevel: command.options.reasoningLevel,
    permissionMode: command.options.permissionMode,
    serviceTier: command.options.serviceTier,
    waitingOn: { kind: "thread-busy" },
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice:
      request.systemMessageKind === undefined
        ? null
        : {
            kind: request.systemMessageKind,
            subject: request.systemMessageSubject ?? null,
          },
  });
  deps.hub.notifyThread(command.threadId, ["queue-changed"]);
}
