import { useQueryClient } from "@tanstack/react-query";
import { AUTH_SESSION_QUERY_KEY } from "@/hooks/useAuth";
import { userDirectoryQueryKey } from "@/hooks/queries/query-keys";

export const TOKENS_QUERY_KEY = ["auth", "tokens"] as const;
export const INVITES_QUERY_KEY = ["auth", "invites"] as const;
export const USERS_QUERY_KEY = ["auth", "users"] as const;
export const PLUGIN_GRANTS_QUERY_KEY = ["auth", "plugin-grants"] as const;

export function useAuthCacheOwner() {
  const client = useQueryClient();
  return {
    refreshTokens: () =>
      client.invalidateQueries({ queryKey: TOKENS_QUERY_KEY }),
    refreshPluginGrants: () =>
      client.invalidateQueries({ queryKey: PLUGIN_GRANTS_QUERY_KEY }),
    refreshInvites: () =>
      client.invalidateQueries({ queryKey: INVITES_QUERY_KEY }),
    refreshUsers: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: USERS_QUERY_KEY }),
        client.invalidateQueries({ queryKey: userDirectoryQueryKey() }),
        client.invalidateQueries({ queryKey: AUTH_SESSION_QUERY_KEY }),
      ]),
  };
}
