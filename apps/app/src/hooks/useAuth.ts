import { createContext, useContext, useMemo } from "react";
import type { AuthSessionResponse } from "@bb/server-contract";
import type { ExperimentalCurrentUser } from "@get-bb/plugin-sdk";

export const AUTH_SESSION_QUERY_KEY = ["auth", "session"] as const;
export const AuthContext = createContext<AuthSessionResponse | null>(null);

export function useAuth() {
  return useContext(AuthContext);
}

function currentUserFromSession(
  auth: AuthSessionResponse | null,
): ExperimentalCurrentUser | null {
  if (auth === null || auth.user === null || auth.effectiveRole === null) {
    return null;
  }
  return {
    userId: auth.user.id,
    displayName: auth.user.name,
    email: auth.principalKind === "local" ? null : auth.user.email,
    role: auth.user.role,
    effectiveRole: auth.effectiveRole,
    roleCeiling: auth.roleCeiling,
  };
}

export function useCurrentUser(): ExperimentalCurrentUser | null {
  const auth = useAuth();
  return useMemo(() => currentUserFromSession(auth), [auth]);
}

export function useActsAsMember(): boolean {
  return useCurrentUser()?.effectiveRole === "member";
}

export function useUserStorageKey(key: string): string | null {
  const auth = useAuth();
  if (auth === null || auth.authMode === "local") return key;
  return auth.user === null ? null : `${key}:user:${auth.user.id}`;
}
