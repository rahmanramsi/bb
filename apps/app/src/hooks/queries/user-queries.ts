import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { sdk } from "@/lib/sdk";
import { userDirectoryQueryKey } from "./query-keys";
import { SERVER_SESSION_QUERY_POLICY } from "./query-policies";

export interface UserAttribution {
  nameFor(userId: string | null): string | null;
}

const NO_ATTRIBUTION: UserAttribution = { nameFor: () => null };

export function useUserDirectory() {
  return useQuery({
    queryKey: userDirectoryQueryKey(),
    queryFn: ({ signal }) => sdk.experimental_users.list({ signal }),
    ...SERVER_SESSION_QUERY_POLICY,
  });
}

export function useUserAttribution(): UserAttribution {
  const { data } = useUserDirectory();
  return useMemo(() => {
    if (data === undefined || data.users.length < 2) return NO_ATTRIBUTION;
    const namesById = new Map(data.users.map((user) => [user.id, user.name]));
    return {
      nameFor: (userId) =>
        userId === null ? null : (namesById.get(userId) ?? null),
    };
  }, [data]);
}
