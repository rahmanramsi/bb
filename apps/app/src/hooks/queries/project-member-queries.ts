import { useQuery } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { projectMembersQueryKey } from "./query-keys";
import { REALTIME_OWNED_NO_FOCUS_QUERY_POLICY } from "./query-policies";

export function useProjectMembers(
  projectId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: projectMembersQueryKey(projectId),
    queryFn: ({ signal }) =>
      sdk.projects.experimental_members.list({ projectId, signal }),
    enabled: options?.enabled ?? true,
    ...REALTIME_OWNED_NO_FOCUS_QUERY_POLICY,
  });
}
