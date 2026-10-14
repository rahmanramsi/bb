import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { sdk } from "@/lib/sdk";
import { useAuth } from "@/hooks/useAuth";

export function AuthForm({
  mode,
  inviteToken,
}: {
  mode: "login" | "bootstrap" | "invite";
  inviteToken: string | null;
}) {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const registration = mode !== "login";
  const submit = useMutation({
    mutationFn: async () => {
      if (mode === "invite") {
        if (!inviteToken)
          throw new Error(
            "This invite link is missing its token. Ask an admin for a new link.",
          );
        return sdk.experimental_auth.acceptInvite({
          name,
          email,
          password,
          inviteToken,
        });
      }
      return mode === "bootstrap"
        ? sdk.experimental_auth.signUp({ name, email, password })
        : sdk.experimental_auth.signIn({ email, password });
    },
    onSuccess: () => {
      if (mode === "invite") window.location.replace("/");
      else window.location.reload();
    },
  });
  const signOut = useMutation({
    mutationFn: () => sdk.experimental_auth.signOut(),
    onSuccess: () => window.location.reload(),
  });
  const title =
    mode === "login"
      ? "Sign in to bb"
      : mode === "bootstrap"
        ? "Create your admin account"
        : "Join this bb server";
  const error = submit.error ?? signOut.error;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit.mutate();
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm text-subtle-foreground">
            {mode === "bootstrap"
              ? "The first account manages users and server settings."
              : mode === "invite"
                ? "Create an account using the email address your admin invited."
                : "Use your account for this server."}
          </p>
        </div>
        {mode === "invite" && auth?.user ? (
          <div className="space-y-4">
            <p className="text-sm">
              You are signed in as {auth.user.email}. Sign out to create an
              account with this invite.
            </p>
            <Button
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
            >
              Sign out
            </Button>
            <Link to="/" className="block text-sm underline underline-offset-4">
              Back to bb
            </Link>
          </div>
        ) : mode === "invite" && !inviteToken ? (
          <p role="alert" className="text-sm">
            This invite link is missing its token. Ask an admin for a new link.
          </p>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            {registration && (
              <label className="block space-y-1.5 text-sm">
                Name
                <Input
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={200}
                />
              </label>
            )}
            <label className="block space-y-1.5 text-sm">
              Email
              <Input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              Password
              <Input
                type="password"
                autoComplete={
                  registration ? "new-password" : "current-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={registration ? 8 : 1}
                maxLength={registration ? 128 : undefined}
              />
            </label>
            {registration && (
              <p className="text-xs text-subtle-foreground">
                Use at least 8 characters. Everyone on this server shares
                projects, threads and secrets. Members who run agents have shell
                access to hosts.
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={submit.isPending}
            >
              {submit.isPending
                ? "Please wait..."
                : mode === "login"
                  ? "Sign in"
                  : "Create account"}
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
      </div>
    </main>
  );
}
