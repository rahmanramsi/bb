import { ARCHIVE_UNDO_GRACE_MS } from "../../constants.js";
import type { ThreadRecord } from "@bb/domain";

type ArchiveUndoGraceThread = Pick<ThreadRecord, "archivedAt" | "status">;

export function archiveUndoGraceKeepsTerminals(
  thread: Pick<ThreadRecord, "archivedAt">,
  now: number,
): boolean {
  return (
    thread.archivedAt !== null &&
    thread.archivedAt + ARCHIVE_UNDO_GRACE_MS > now
  );
}

export function archiveUndoGraceKeepsTurnRunning(
  thread: ArchiveUndoGraceThread,
  now: number,
): boolean {
  return (
    thread.status === "active" && archiveUndoGraceKeepsTerminals(thread, now)
  );
}
