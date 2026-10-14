import type { RoleCeiling } from "@bb/domain";

export interface TurnAuthor {
  authorRoleCeiling: RoleCeiling | null;
  authorUserId: string | null;
}

const MAX_RECORDED_REQUESTS_PER_THREAD = 64;

const turnRequestAuthorsByThread = new Map<string, Map<string, TurnAuthor>>();

export function recordTurnRequestAuthor(args: {
  author: TurnAuthor;
  requestId: string;
  threadId: string;
}): void {
  let authors = turnRequestAuthorsByThread.get(args.threadId);
  if (authors === undefined) {
    authors = new Map();
    turnRequestAuthorsByThread.set(args.threadId, authors);
  }
  authors.set(args.requestId, args.author);
  while (authors.size > MAX_RECORDED_REQUESTS_PER_THREAD) {
    const oldest = authors.keys().next();
    if (oldest.done) break;
    authors.delete(oldest.value);
  }
}

export function readTurnRequestAuthor(args: {
  requestId: string;
  threadId: string;
}): TurnAuthor | null {
  return (
    turnRequestAuthorsByThread.get(args.threadId)?.get(args.requestId) ?? null
  );
}
