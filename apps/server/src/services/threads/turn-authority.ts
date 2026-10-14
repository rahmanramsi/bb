import { and, desc, eq, sql } from "drizzle-orm";
import { events, type DbQueryConnection } from "@bb/db";
import type { ThreadRecord } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import {
  resolveThreadShellCredential,
  type ThreadShellCredential,
} from "./thread-runtime-config.js";
import { readTurnRequestAuthor, type TurnAuthor } from "./turn-request-authors.js";

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

export function sharesRunningTurnAuthority(
  deps: Pick<AppDeps, "config" | "db">,
  args: { author: TurnAuthor; thread: ThreadRecord },
): boolean {
  if (deps.config.authMode !== "multi") return true;
  const requestId = latestTurnStartRequestId(deps.db, args.thread.id);
  if (requestId === null) return false;
  const runningAuthor = readTurnRequestAuthor({
    requestId,
    threadId: args.thread.id,
  });
  if (runningAuthor === null) return false;
  return sameCredential(
    resolveThreadShellCredential(deps, { ...runningAuthor, thread: args.thread }),
    resolveThreadShellCredential(deps, { ...args.author, thread: args.thread }),
  );
}
