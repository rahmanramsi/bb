import type { PluginThreadTitleProps } from "@get-bb/plugin-sdk";
import { ThreadTitleMentions } from "@/components/thread/ThreadTitleMentions";
import { useSidebarThreadEntry } from "@/lib/plugin-sidebar-hooks";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { ThreadCreator } from "@/components/thread/ThreadCreator";

export function PluginThreadTitle({ threadId }: PluginThreadTitleProps) {
  const entry = useSidebarThreadEntry(threadId);
  if (entry === null) return null;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
      <ThreadTitleMentions title={getThreadDisplayTitle(entry)} />
      <ThreadCreator userId={entry.createdByUserId} />
    </span>
  );
}
