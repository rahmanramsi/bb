# Authentication, team access, and attribution

Status: **not yet audited as a complete group**. Record each recipe separately.

## Setup and entry points

Use two isolated source instances with fresh data: one in the default `local`
mode and one with `BB_AUTH_MODE=multi`. The multi-mode instance needs separate
admin and member browser profiles plus profile-scoped source CLI data. Keep
tokens out of logs and screenshots.

Follow the main skill's isolated launch, doctor, evidence, and cleanup rules.
Use the source CLI and SDK from this checkout against the same instance. Hosted
Connect checks require disposable local-cloud accounts and a disposable tunnel;
do not deploy or use a production server.

## Source

- `apps/server/src/authenticate.ts`
- `apps/server/src/routes/auth.ts`
- `apps/server/src/services/user-auth.ts`
- `apps/server/src/request-context.ts`
- `apps/server/src/ws/authenticated-sockets.ts`
- `apps/app/src/components/auth/AuthGate.tsx`
- `apps/app/src/components/settings/AccountSettings.tsx`
- `apps/cli/src/commands/auth.ts`
- `apps/cli/src/commands/user.ts`
- `packages/sdk/src/areas/auth.ts`
- `packages/sdk/src/areas/users.ts`
- `packages/db/src/data/threads.ts`
- `packages/tunnel-contract/src/gate-identity.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Local-mode compatibility | Start without `BB_AUTH_MODE`; use browser, CLI, SDK, HTTP, and WebSocket without credentials. Try account sign-in. | Every request resolves to `usr_local_owner` with admin access, existing local workflows remain usable, and account sign-in reports that multi-user mode is disabled. |
| Multi-mode bootstrap and sessions | Start fresh in multi mode, request protected HTTP and WebSocket paths before bootstrap, create the first account in the UI, sign out, sign in, and reload. | Unauthenticated product paths reject access, the first account becomes admin exactly once, the session survives reload, and sign-out revokes browser access. |
| Personal access tokens | Create a token in Account settings, sign in with `bb login`, call `whoami` and a typed SDK read, open a realtime SDK connection, then revoke the token. | CLI, SDK HTTP, uploads, and realtime identify the same user; token material is shown only at creation; revoked credentials stop authorizing new and existing connections. |
| User and invite administration | As admin, create member and admin invites, accept them in separate profiles, change a disposable user's role, and remove that user. Repeat list/add/change/remove through `bb user` and the experimental SDK areas. | UI, CLI, and SDK observe one shared directory; invites are single-use and honor their role; only admins can manage users and invites; removal revokes that user's sessions and tokens. |
| Member policy boundaries | As member, use shared projects, threads, hosts, secrets needed by agents, and personal account/preferences. Attempt host enrollment/removal, plugin install/enable/settings, provider/global secret/server settings, and user administration through UI, CLI, SDK, plugin CLI, and plugin RPC. | Shared team data remains visible and usable while every administrative mutation returns `admin_required` or is absent from the member UI; no rejected action partially mutates state. |
| Per-user state and attribution | Have admin and member independently read, unread, pin, reorder, theme, and change UI preferences. Create, queue, and resolve interactions from both accounts. | Read/pin/theme/preferences remain independent; thread creator, queued-message author, and interaction resolver identify the acting user across UI, CLI, SDK, events, and persisted rows. |
| Plugin and MCP authentication | Exercise plugin HTTP and WebSocket endpoints with no credential, a valid user credential, a revoked credential, and a daemon machine key. Start the MCP server in local and multi modes. | Multi mode requires a current user on plugin routes, revocation closes existing plugin sockets, machine keys retain only machine authority, and MCP is unavailable in multi mode while local-mode behavior is unchanged. |
| Agent credential propagation | Start short member-authored Claude Code and Codex turns through Account Pooler, then run `bb whoami --json` inside each agent. Repeat a system-authored turn and revoke the author's token before a new turn. | User-authored turns carry a short-lived shell credential for the author through both bridges without exposing it in runtime displays or plugin input; system users receive no user token; revoked credentials cannot start authorized work. |
| Connect team membership | In local cloud, add and remove disposable server members through UI, `bb user connect-members`, and SDK. Open HTTP and WebSocket through the test tunnel as owner, member, non-member, and a revoked member. | Signed gate identity binds the intended user and server; admitted users map to the matching local account and role; non-members and revoked members cannot reach the server; machine credentials remain separate. |

## Evidence and cleanup

Record the auth mode, source commit, browser profile, principal kind, user ID,
role, entry point, HTTP or socket result, and persisted side effect for each
recipe. Redact cookies, tokens, passwords, signed gate identities, provider
account details, and private model names. A provider quota failure proves only
that the authenticated request reached that provider boundary, not that an
agent turn completed.

Restore changed roles and settings, revoke disposable tokens and invites, leave
synthetic threads idle, stop only owned browser and server processes, and keep
the evidence directory. Do not remove or modify production accounts, tunnels,
hosts, or credentials.
