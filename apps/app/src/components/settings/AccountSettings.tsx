import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { LOCAL_OWNER_USER_ID, type UserRole } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { SettingsSection } from "@/components/ui/settings-section";
import { CopyButton } from "@/components/ui/copy-button";
import { useAuth, useCurrentUser } from "@/hooks/useAuth";
import {
  INVITES_QUERY_KEY,
  PLUGIN_GRANTS_QUERY_KEY,
  TOKENS_QUERY_KEY,
  USERS_QUERY_KEY,
  useAuthCacheOwner,
} from "@/hooks/cache-owners/auth-cache-owner";
import { sdk } from "@/lib/sdk";

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RoleSelect({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: UserRole;
  onChange: (role: UserRole) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      className={SELECT_CLASS}
      value={value}
      disabled={disabled}
      onChange={(event) =>
        onChange(event.target.value === "admin" ? "admin" : "member")
      }
    >
      <option value="member">Member</option>
      <option value="admin">Admin</option>
    </select>
  );
}

function RequestError({ error }: { error: Error | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error.message}
    </p>
  ) : null;
}

function ConfirmAction({
  label,
  description,
  pending,
  onConfirm,
}: {
  label: string;
  description: string;
  pending: boolean;
  onConfirm: () => Promise<{ ok: true }>;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs">{description}</span>
      <Button
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() => {
          void onConfirm()
            .then(() => setConfirming(false))
            .catch(() => {});
        }}
      >
        Confirm {label.toLowerCase()}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
    </div>
  );
}

function TokenSettings() {
  const cache = useAuthCacheOwner();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ token: string; id: string } | null>(
    null,
  );
  const tokens = useQuery({
    queryKey: TOKENS_QUERY_KEY,
    queryFn: ({ signal }) => sdk.experimental_auth.listTokens({ signal }),
  });
  const create = useMutation({
    mutationFn: () => sdk.experimental_auth.createToken({ name }),
    onSuccess: (result) => {
      setCreated({ token: result.token, id: result.summary.id });
      setName("");
      void cache.refreshTokens();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => sdk.experimental_auth.revokeToken({ id }),
    onSuccess: (_result, id) => {
      if (created?.id === id) setCreated(null);
      void cache.refreshTokens();
    },
  });
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate();
  }
  return (
    <SettingsSection
      title="Personal access tokens"
      description="Use your tokens to sign in from the CLI, SDK and scripts. They have your account's access."
    >
      <div className="space-y-4">
        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="min-w-0 flex-1 space-y-1 text-sm">
            Token name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={200}
            />
          </label>
          <Button type="submit" disabled={create.isPending || created !== null}>
            Create token
          </Button>
        </form>
        {created && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-sm">
              Copy this token now. You cannot view it again.
            </p>
            <div className="flex items-center gap-2">
              <Input
                aria-label="New personal access token"
                readOnly
                value={created.token}
                onFocus={(event) => event.target.select()}
                className="font-mono"
              />
              <CopyButton
                text={created.token}
                label="Copy token"
                className="size-9 shrink-0"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreated(null)}
            >
              Done
            </Button>
          </div>
        )}
        <RequestError error={create.error ?? revoke.error ?? tokens.error} />
        {tokens.isPending ? (
          <p role="status" className="text-sm text-subtle-foreground">
            Loading tokens...
          </p>
        ) : tokens.isError ? (
          <Button variant="outline" onClick={() => void tokens.refetch()}>
            Retry tokens
          </Button>
        ) : tokens.data?.tokens.length === 0 ? (
          <p className="text-sm text-subtle-foreground">
            You have no personal access tokens.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {tokens.data?.tokens.map((token) => (
              <li
                key={token.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">
                    {token.name}
                  </p>
                  <p className="text-xs text-subtle-foreground">
                    Created {new Date(token.createdAt).toLocaleDateString()}.{" "}
                    {token.lastUsedAt === null
                      ? "Never used."
                      : `Last used ${new Date(token.lastUsedAt).toLocaleDateString()}.`}
                  </p>
                </div>
                <ConfirmAction
                  label="Revoke"
                  description={`Revoke ${token.name}? Clients using it will lose access.`}
                  pending={revoke.isPending}
                  onConfirm={() => revoke.mutateAsync(token.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

function PluginGrantSettings({ userId }: { userId: string }) {
  const cache = useAuthCacheOwner();
  const grants = useQuery({
    queryKey: [...PLUGIN_GRANTS_QUERY_KEY, userId],
    queryFn: ({ signal }) =>
      sdk.experimental_users.listPluginGrants({ userId, signal }),
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) =>
      sdk.experimental_users.revokePluginGrant({ userId, grantId }),
    onSuccess: () => void cache.refreshPluginGrants(),
  });
  return (
    <SettingsSection
      title="Plugin access"
      description="Plugins you let act as you later, such as automations you saved. They never get more access than you have."
    >
      <div className="space-y-4">
        <RequestError error={revoke.error ?? grants.error} />
        {grants.isPending ? (
          <p role="status" className="text-sm text-subtle-foreground">
            Loading plugin access...
          </p>
        ) : grants.isError ? (
          <Button variant="outline" onClick={() => void grants.refetch()}>
            Retry plugin access
          </Button>
        ) : grants.data?.grants.length === 0 ? (
          <p className="text-sm text-subtle-foreground">
            No plugin can act as you.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {grants.data?.grants.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">
                    {grant.purpose}
                  </p>
                  <p className="text-xs text-subtle-foreground">
                    {grant.pluginId}, {grant.maxRole} access. Granted{" "}
                    {new Date(grant.createdAt).toLocaleDateString()}.{" "}
                    {grant.expiresAt === null
                      ? "Never expires."
                      : grant.expiresAt <= Date.now()
                        ? `Expired ${new Date(grant.expiresAt).toLocaleDateString()}.`
                        : `Expires ${new Date(grant.expiresAt).toLocaleDateString()}.`}
                  </p>
                </div>
                <ConfirmAction
                  label="Revoke"
                  description={`Revoke ${grant.purpose}? ${grant.pluginId} can no longer act as you for it.`}
                  pending={revoke.isPending}
                  onConfirm={() => revoke.mutateAsync(grant.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

function UserSettings({ currentUserId }: { currentUserId: string }) {
  const cache = useAuthCacheOwner();
  const users = useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: ({ signal }) => sdk.experimental_users.list({ signal }),
  });
  const update = useMutation({
    mutationFn: (input: { userId: string; role: UserRole }) =>
      sdk.experimental_users.updateRole(input),
    onSuccess: () => cache.refreshUsers(),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => sdk.experimental_users.remove({ userId }),
    onSuccess: () => cache.refreshUsers(),
  });
  return (
    <SettingsSection
      title="Users"
      description="Everyone shares projects, threads, hosts and secrets. Members who run agents have shell access to hosts. Roles guard administrative controls."
    >
      <div className="space-y-3">
        <RequestError error={users.error ?? update.error ?? remove.error} />
        {users.isPending ? (
          <p role="status" className="text-sm">
            Loading users...
          </p>
        ) : users.isError ? (
          <Button variant="outline" onClick={() => void users.refetch()}>
            Retry users
          </Button>
        ) : (
          <ul className="divide-y divide-border">
            {users.data?.users.map((user) => (
              <li
                key={user.id}
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">
                    {user.name}
                    {user.id === currentUserId ? " (you)" : ""}
                  </p>
                  <p className="break-all text-xs text-subtle-foreground">
                    {user.email}
                  </p>
                </div>
                {user.id === LOCAL_OWNER_USER_ID ? (
                  <span className="text-xs text-subtle-foreground">
                    Local owner
                  </span>
                ) : (
                  <>
                    <RoleSelect
                      label={`Role for ${user.email}`}
                      value={user.role}
                      disabled={update.isPending || remove.isPending}
                      onChange={(role) =>
                        update.mutate({ userId: user.id, role })
                      }
                    />
                    <ConfirmAction
                      label="Remove"
                      description={`Remove ${user.email}? Their sessions and tokens will stop working.`}
                      pending={remove.isPending || update.isPending}
                      onConfirm={() => remove.mutateAsync(user.id)}
                    />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

function InviteSettings() {
  const cache = useAuthCacheOwner();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [created, setCreated] = useState<{ url: string; id: string } | null>(
    null,
  );
  const invites = useQuery({
    queryKey: INVITES_QUERY_KEY,
    queryFn: ({ signal }) => sdk.experimental_auth.listInvites({ signal }),
  });
  const create = useMutation({
    mutationFn: () =>
      sdk.experimental_auth.createInvite({
        role,
        ...(email.trim() ? { email: email.trim() } : {}),
      }),
    onSuccess: (invite) => {
      const url = new URL("/invite", window.location.origin);
      url.searchParams.set("token", invite.token);
      setCreated({ url: url.href, id: invite.id });
      setEmail("");
      void cache.refreshInvites();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => sdk.experimental_auth.revokeInvite({ id }),
    onSuccess: (_result, id) => {
      if (created?.id === id) setCreated(null);
      void cache.refreshInvites();
    },
  });
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate();
  }
  return (
    <SettingsSection
      title="Invites"
      description="Share a single-use link to invite someone. Links expire after seven days. No email is sent automatically."
    >
      <div className="space-y-4">
        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="min-w-0 flex-1 space-y-1 text-sm">
            Email (optional)
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <RoleSelect label="Invite role" value={role} onChange={setRole} />
          <Button type="submit" disabled={create.isPending || created !== null}>
            Create invite
          </Button>
        </form>
        {created && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-sm">
              Copy and share this invite link. You cannot view it again.
            </p>
            <div className="flex items-center gap-2">
              <Input
                aria-label="New invite link"
                readOnly
                value={created.url}
                onFocus={(event) => event.target.select()}
              />
              <CopyButton
                text={created.url}
                label="Copy invite link"
                className="size-9 shrink-0"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreated(null)}
            >
              Done
            </Button>
          </div>
        )}
        <RequestError error={create.error ?? revoke.error ?? invites.error} />
        {invites.isPending ? (
          <p role="status" className="text-sm">
            Loading invites...
          </p>
        ) : invites.isError ? (
          <Button variant="outline" onClick={() => void invites.refetch()}>
            Retry invites
          </Button>
        ) : invites.data?.invites.length === 0 ? (
          <p className="text-sm text-subtle-foreground">
            There are no pending invites.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {invites.data?.invites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-all text-sm">
                    {invite.email ?? "Any email address"}
                  </p>
                  <p className="text-xs text-subtle-foreground">
                    {invite.role}. Expires{" "}
                    {new Date(invite.expiresAt).toLocaleDateString()}.
                  </p>
                </div>
                <ConfirmAction
                  label="Revoke"
                  description={`Revoke the invite for ${invite.email ?? "any email address"}?`}
                  pending={revoke.isPending}
                  onConfirm={() => revoke.mutateAsync(invite.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

export function AccountSettings() {
  const auth = useAuth();
  const currentUser = useCurrentUser();
  if (auth?.authMode !== "multi" || auth.user === null) return null;
  return (
    <>
      <SettingsSection title="Your account">
        <p className="break-words text-sm">{auth.user.name}</p>
        <p className="break-all text-sm text-subtle-foreground">
          {auth.user.email}
        </p>
        <p className="text-xs capitalize text-subtle-foreground">
          {auth.user.role}
        </p>
      </SettingsSection>
      <TokenSettings />
      <PluginGrantSettings userId={auth.user.id} />
      {currentUser?.effectiveRole === "admin" && (
        <>
          <UserSettings currentUserId={auth.user.id} />
          <InviteSettings />
        </>
      )}
    </>
  );
}
