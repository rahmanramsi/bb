import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { sdk } from "@/lib/sdk";
import { AUTHENTICATION_REQUIRED_EVENT } from "@/lib/app-surface";
import { AuthContext, AUTH_SESSION_QUERY_KEY } from "@/hooks/useAuth";
import { AuthForm } from "./AuthForm";
import { wsManager } from "@/lib/ws";

export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const session = useQuery({
    queryKey: AUTH_SESSION_QUERY_KEY,
    queryFn: ({ signal }) => sdk.experimental_auth.session({ signal }),
    retry: false,
    staleTime: 0,
    refetchInterval: 60_000,
  });
  const { refetch } = session;
  useEffect(() => {
    const refresh = () => void refetch();
    window.addEventListener(AUTHENTICATION_REQUIRED_EVENT, refresh);
    return () =>
      window.removeEventListener(AUTHENTICATION_REQUIRED_EVENT, refresh);
  }, [refetch]);
  useEffect(() => {
    if (session.data?.authMode === "multi" && session.data.user === null) {
      wsManager.disconnect();
    }
  }, [session.data]);

  if (session.isError) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
        <p role="alert">
          Unable to check sign-in. Check your connection and try again.
        </p>
        <Button onClick={() => void session.refetch()}>Try again</Button>
      </main>
    );
  }
  if (session.data === undefined) {
    return (
      <main
        className="flex min-h-dvh items-center justify-center bg-background text-foreground"
        role="status"
      >
        Loading bb...
      </main>
    );
  }

  const auth = session.data;
  const invitePage = location.pathname === "/invite";
  return (
    <AuthContext.Provider value={auth}>
      {auth.authMode === "local" ? (
        children
      ) : invitePage ? (
        <AuthForm
          mode="invite"
          inviteToken={new URLSearchParams(location.search).get("token")}
        />
      ) : auth.user === null ? (
        <AuthForm
          mode={auth.needsBootstrap ? "bootstrap" : "login"}
          inviteToken={null}
        />
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}
