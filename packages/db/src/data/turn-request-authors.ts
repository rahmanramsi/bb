import { and, eq } from "drizzle-orm";
import type { RoleCeiling } from "@bb/domain";
import type { DbQueryConnection, DbTransaction } from "../connection.js";
import { turnRequestAuthors } from "../schema.js";

export interface TurnRequestAuthor {
  authorGrantId: string | null;
  authorRoleCeiling: RoleCeiling | null;
  authorUserId: string | null;
}

export function recordTurnRequestAuthorInTransaction(
  db: DbTransaction,
  args: TurnRequestAuthor & { requestId: string; threadId: string },
): void {
  db.insert(turnRequestAuthors)
    .values({
      threadId: args.threadId,
      requestId: args.requestId,
      authorUserId: args.authorUserId,
      authorRoleCeiling: args.authorRoleCeiling,
      authorGrantId: args.authorGrantId,
    })
    .onConflictDoUpdate({
      target: [turnRequestAuthors.threadId, turnRequestAuthors.requestId],
      set: {
        authorUserId: args.authorUserId,
        authorRoleCeiling: args.authorRoleCeiling,
        authorGrantId: args.authorGrantId,
      },
    })
    .run();
}

export function getTurnRequestAuthor(
  db: DbQueryConnection,
  args: { requestId: string; threadId: string },
): TurnRequestAuthor | null {
  return (
    db
      .select({
        authorUserId: turnRequestAuthors.authorUserId,
        authorRoleCeiling: turnRequestAuthors.authorRoleCeiling,
        authorGrantId: turnRequestAuthors.authorGrantId,
      })
      .from(turnRequestAuthors)
      .where(
        and(
          eq(turnRequestAuthors.threadId, args.threadId),
          eq(turnRequestAuthors.requestId, args.requestId),
        ),
      )
      .get() ?? null
  );
}
