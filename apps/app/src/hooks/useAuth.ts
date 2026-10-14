import { createContext, useContext } from "react";
import type { AuthSessionResponse } from "@bb/server-contract";

export const AUTH_SESSION_QUERY_KEY = ["auth", "session"] as const;
export const AuthContext = createContext<AuthSessionResponse | null>(null);

export function useAuth() {
  return useContext(AuthContext);
}
