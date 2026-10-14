import { and, eq } from "drizzle-orm";
import type { RoleCeiling } from "@bb/domain";
import type { DbQueryConnection, DbTransaction } from "../connection.js";
import { turnRequestAuthors } from "../schema.js";

export interface TurnRequestAuthor {
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
    })
    .onConflictDoUpdate({
      target: [turnRequestAuthors.threadId, turnRequestAuthors.requestId],
      set: {
        authorUserId: args.authorUserId,
        authorRoleCeiling: args.authorRoleCeiling,
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
