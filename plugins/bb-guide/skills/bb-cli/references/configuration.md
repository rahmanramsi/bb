# Configuration and skill management

## Environment Setup And Teardown Scripts

- To make a repo work with bb worktrees, run `bb guide environments`. It
  documents the repo-level `.bb-env-setup.sh` and `.bb-env-teardown.sh` hooks,
  and the `.worktreeinclude` file.
- A new worktree checks out tracked files only. Commit a `.worktreeinclude`
  file at the repo root to list untracked files, such as `.env`, that bb must
  copy from the source checkout. It uses gitignore pattern syntax. bb copies
  the matches before it runs `.bb-env-setup.sh`.

- Hooks require ownership confirmed by successful provider creation. Attached
  checkout and personal-workspace paths skip both hooks. Server restart resumes
  the saved hook operation; cleanup waits for daemon-confirmed termination
  after a transport failure and retries while the daemon is unreachable.

- Missing default environment plugins cause creation to fail before a thread is
  inserted. Enable the plugin or explicitly select another environment.
- Host-dependent environment preflight requires a connected machine. Directory
  switching creates a core-owned attachment without claiming plugin provenance.

## App settings

- Read `references/app-settings.md` for every general key, experiment, default,
  and effect.
- Use `bb settings show` and `bb settings ai-services` for current values.
- Use `bb settings ai-services set <thread-title|commit-message|voice>
<automatic|off|service-id>` to choose which plugin AI service writes titles,
  commit messages, or voice transcripts, and `bb settings ai-services test
<thread-title|commit-message>` to try the current choice. Add
  `--plugin <plugin-id>` to `set` when two plugins register the same service
  id.
- Use `bb settings general <key> <value>` or
  `bb settings experiment <key> <value>` for updates.
- Use `bb settings keyboard list`, `set`, and `reset` for shortcut overrides.
- Use `bb settings usage [--machine <id-or-name>] [--refresh]` for provider limits. `--refresh` bypasses completed cached results; ordinary reads may reuse results for 10 seconds.
  `--host` is an alias for `--machine`.
- Use `bb settings version [--force]` for release information.
- Use `bb settings reload` to reload BB-managed configuration.
- These commands support `--json`.

BB accepts request hosts that are `localhost`, IP addresses (including LAN and
Tailscale IPs), or the hostname in `BB_APP_URL`. For a custom DNS name or reverse
proxy, set `npx bb-app config set BB_APP_URL https://bb.example.com` before
connecting, including from the CLI or SDK. A matching `Host` and `Origin`, or
`X-Forwarded-Host`, cannot authorize an unconfigured DNS name. A proxy can
preserve the configured host or forward to localhost. BB Connect rewrites
requests to the local server address and needs no additional configuration.
`BB_SERVER_BIND_HOST=0.0.0.0` remains supported for direct remote access.

`BB_AUTH_MODE` (startup-only, `local` by default) controls sign-in. `local`
treats every request as the built-in local owner. `multi` requires a session
cookie (`POST /api/v1/auth/sign-in`) or a personal access token
(`Authorization: Bearer bbpat_…`, created with `POST /api/v1/auth/tokens`) on
every API and WebSocket request, including loopback. The first account
registered on a `multi` server becomes an admin; later sign-ups need an admin's
invite. Admin-only actions return `403` to members.

Read and unread state, pins and pin order, UI preferences, appearance, and
prompt history are kept per user; projects and threads are shared. Threads,
queued messages, and resolved interactions record who created, wrote, or
answered them (`createdByUserId`, `authorUserId`, `resolvedByUserId`);
`bb user list` maps those ids to names for admins.

Sign in to a multi-user server with `bb login --email EMAIL`. The CLI prompts
for the password and creates a PAT. Use `--password-file PATH` for unattended
sign-in, or `bb login --token TOKEN` to save an existing PAT. Without either
option, `bb login` reads a PAT from a hidden prompt or standard input. Login
validates the credential before saving it to the server origin's profile in
`<BB_DATA_DIR>/client.json`, with file permissions `0600`. `BB_SERVER_URL`
selects the server; `BB_TOKEN` overrides its saved token for CLI requests,
including plugin commands. `bb whoami [--json]` shows the current user and
the role the credential acts with: a member-capped `BB_TOKEN` reports
`effectiveRole: "member"` and `roleCeiling: "member"` even after its user is
promoted, and the text output names the cap and the account role.
`GET /api/v1/auth/session` (SDK `experimental_auth.session`) reports the same
`effectiveRole` and `roleCeiling`, both null while signed out; the app and
plugin pages read the signed-in user from it.
`bb logout [--json]` removes only that profile's saved login. It does not
revoke the PAT or unset `BB_TOKEN`.

Admins use `bb user list`, `bb user role USER_ID admin|member`, and
`bb user remove USER_ID`. Removing a user also deletes their queued and
scheduled messages. System users and the last account admin cannot be removed
or demoted. `bb invite create [--email EMAIL] [--role admin|member]`
prints a seven-day, single-use token. `bb invite list` lists pending unexpired
invites without tokens; `bb invite revoke ID` invalidates one. New users run
`bb invite accept TOKEN --email EMAIL --name NAME` and enter their password,
or supply `--password-file PATH`, then sign in with `bb login`.
`bb token create NAME`, `bb token list`, and `bb token revoke ID` manage only
the current user's PATs. New token values are shown once. A member-capped
`BB_TOKEN` cannot create a PAT: `POST /api/v1/auth/tokens` answers 403
`credential_role_capped`. All these commands accept `--json`.

In the multi-mode app, open the user menu in the navigation rail to sign out
or open Settings → Account. Everyone manages their own personal access
tokens; admins also manage users and invites. Copy new tokens and invite
links before selecting Done. Share invite links yourself; bb does not send
invite emails. The link opens an account registration page. Local mode does
not show these controls. Thread lists and headers show creators in multi mode.

Roles are guardrails for a trusted team. A member who runs an agent effectively
has shell access to its host. In multi mode, each turn supplies a signed
seven-day `BB_TOKEN` to the agent shell through the launch environment. For a
turn a user sent, it authenticates as that user with their current role. For a
turn no user sent, or that a plugin or other service credential sent, it
authenticates as the thread creator only if the creator exists and is a member
when the turn starts, and it stays capped at member even if that user is later
promoted to admin. The cap carries over to work the capped token requests: a
thread, fork, sent, queued, scheduled, retried, or edited message it authors
gets a capped `BB_TOKEN` for that user, and a queued message it edits becomes
capped. Tokens and sessions the user creates by signing in keep their current
role. Such turns in a thread whose creator is an admin, a removed
user, or nobody get no `BB_TOKEN`, so plugin-driven work never runs with admin
authority. A thread that a plugin creates under a parent, fork source, or
lifecycle owner thread is attributed to that thread's creator for display; the
attribution grants no authority beyond this rule. A user's own thread is always
attributed to that user. The token stops authenticating if its user is removed
and is masked in runtime environment displays. Threads created before multi
mode and threads a plugin creates without a parent have no creator to fall back
to. In local mode, shells need no credential.

A running turn keeps the `BB_TOKEN` it started with, so in multi mode a
message steers into it only when it would get the same credential: the same
user with the same role ceiling, or no token for both. A message from anyone
else, including a plugin, an automation, or the same user's member-capped
`BB_TOKEN`, interrupts the running turn instead and starts as a new turn with
its own credential under the rules above. The timeline shows the interruption
as stopped because another author sent a message, and the send answers
`delivery: "queued"` until the new turn starts. A queued message that another
user or a plugin edits is attributed to the editor and runs with the editor's
credential.

Notices that bb sends a thread on its own, such as a child thread's outcome or
a delivered tool result, carry no token. While the thread runs a turn with a
different credential, a notice neither steers into that turn nor interrupts it:
it waits in the queue and starts as a new turn once the running turn ends. Send
now on a waiting notice answers that the thread is already running a turn.
Editing a waiting notice turns it into an ordinary message by the editor, with
the editor's credential.

These credential checks hold only for the turn bb checked. If that turn ends
and another one starts before the message reaches the host, bb decides again
against the new turn: a notice waits in the queue, and any other message
follows the interrupt rule above. The host never steers a message into a turn
other than the one it was checked against; it hands the message back to the
queue instead.

bb stores each message's author and role ceiling with its turn request, so a
message handed back keeps them, including after a server restart. If bb cannot
recover the author, for example because an older bb version accepted the
message or its author was removed, it drops the message rather than running it
with any other credential, and the timeline shows the error
`turn_request_author_unknown`: the message was not delivered and must be sent
again. The same holds for a message that waits while bb sets up the thread's
environment, including a new thread's first message: when setup finishes, bb
does not start it, shows the error, and leaves the thread idle.

Plugin RPC methods and commands that change server-wide settings, such as
`bb concurrency-limit global 0` or `bb pool routing claude`, are admin-only and
fail for members with `admin_required`. Session cookies are `Secure` when
`BB_APP_URL` uses HTTPS. Repeated failed sign-ins for one email get `429`.
Realtime and terminal connections close when their credential is revoked, the
user is removed, or the user's role changes.

Settings → General → Command line installs the bb CLI for use outside bb: it
puts the `bb` command on PATH on the computer that runs the bb server, so the
user, a script, or an agent running outside bb (such as Claude Code or Codex)
can control bb. Threads in bb already have `bb`. `bb settings cli-command` shows the state and
`bb settings cli-command install` or `remove` changes it.
Install links the launcher bb keeps at `~/.bb/bin/bb` into a PATH folder such
as `~/.local/bin` (on Windows it adds `~/.bb/bin` to the user PATH). bb never
replaces another `bb`: install is refused while one runs first in a new
terminal. Only an installed bb (`npx bb-app` or the desktop app) offers this;
a source checkout does not.

## Agent Instructions

- Add `AGENTS.md` to the bb data dir (usually `~/.bb/AGENTS.md`) to inject
  user-level default instructions for every provider-backed thread across all
  projects.
- Add `.bb/AGENTS.md` at a workspace root to inject repo-specific instructions
  into every thread that runs there. Track the workspace file with git so fresh
  managed worktrees include it.
- bb appends data-dir instructions first, then workspace instructions, to the
  thread system prompt for all providers when a provider session starts.
- Only the plural `AGENTS.md` is read, only from those exact locations (no
  parent-directory walk); an empty file is ignored. Run
  `bb guide agent-configuration` for details (it also covers project
  `.bb/skills/`).

## Skills

- Use `bb skill list` to inspect installed and discovered skills. It defaults to
  `BB_PROJECT_ID`, then the personal project; pass `--project` or
  `--environment` to select another workspace.
- Copy the opaque ID from `bb skill list`, then use `bb skill show <skill-id>`
  or `bb skill files <skill-id>` to read that exact skill.
- `bb skill show <skill-id> --json` returns the revision. Pass that revision,
  plus `--file`, to `bb skill update <skill-id>`. Use update or delete only when
  the list says editable.
- Use `bb skill search [query]` for live skills.sh results. With no query it
  lists what is trending. The page defaults to zero, and the page size defaults
  to 24. The `ranking` field names the selected leaderboard.
- In JSON, `installs` is the ranking-window count. `lifetimeInstalls` is the
  resolved lifetime count or `null`. Resolution covers at most 48 rows and can
  fail at any page size. Human output prints `—` for an unresolved lifetime
  count.
- Inspect metadata and the bounded file preview with
  `bb skill registry detail <registry-skill-id>`.
  Install with `bb skill install <registry-skill-id>`; never infer an install
  source from a display name.
- `bb skill install-cli-skills` copies bb's built-in CLI skills into a machine's
  global agent skill roots (`~/.agents/skills` and `~/.claude/skills`) so agents
  outside bb can drive bb. It targets every connected machine unless you pass
  the repeatable `--machine <id-or-name>`, and reports each machine's outcome.
  Settings → Skills has the same action; it confirms first, and asks which
  machines only when more than one is enrolled.
- `bb skill cli-skills-status` reports per machine whether the installed copy is
  `installed`, `outdated`, `missing`, or `unknown` (disconnected or unreachable).

## BB guide instructions and skills

Settings → Installed plugins → BB guide controls the BB introduction and the
four bundled skills. All settings default to true. Use
`bb plugin config bb-guide set <key> true|false` with `introduction`, `skills`
(the master skill switch), `bbCli`, `pluginAuthoring`, `skillCreator`, or `submitPlugin`.
Disabling the plugin removes its introduction and skills. Changes apply when
agent configuration is next assembled; independently installed copies remain
available through their own sources.

## BB source runtime preparation

In the BB repository, add `--dryrun` to `pnpm start` or `pnpm start:worktree`
to run Turbo preparation, print resolved paths/ports and exit. The dry run uses
the same dotenv settings and runtime policy as normal startup. It does not start
services, migrate instance data or require ports to be free, but still writes
build outputs and may repair native modules. Install dependencies beforehand.
Preparation writes the checkout's build outputs; use a separate staging checkout
to warm Turbo while a live instance serves its existing files, then prepare the
stable serving checkout before launch. See `docs/debugging-and-qa.md` and
`bb guide environments`. These source-maintenance commands are separate from
installed `bb` commands and `.bb-env-setup.sh`.

## Machine access and isolated data

Machine access `machineServerUrl` is the URL reachable by machines; unset uses
`BB_EXTERNAL_URL`. `defaultMachineAccess` selects an access provider; unset
uses the first registered access provider, or direct when none are registered.
Inspect effective values
with `bb settings show --json` and change them with `bb settings general`.
`BB_DATA_DIR` selects isolated enrollment state. Local machine lifecycle commands
treat it as an ownership assertion and refuse the default BB installation; see
thread-creation.md and docs/configuration.md for the directory constraints.

The `bb` CLI appends every failed invocation to
`<data dir>/logs/cli-errors.jsonl` on the machine that ran it: command path,
error code, and the unknown command or flag, never argument values.
`bb diagnostics cli-errors [--since 7d] [--json]` tallies it; `--clear` deletes
it. `BB_CLI_ERROR_LOG=0` turns recording off.

Machine enrollment v2 stores private `serverHeaders` in machine `config.json`.
The launcher transports these through `BB_SERVER_HEADERS` (JSON string map) for
all server requests. Do not print these headers; they can contain access tokens.

## Machine environment

Use `--project <id>` on `bb machine env list|set|unset` for project overrides;
omit it for global settings. Project overrides follow the project across
machines and worktrees, including the primary host. Empty strings override;
unset restores inheritance. List masks all values and includes inherited global
rows for project scope. Set and unset update a single variable atomically.

Settings → Environment variables edits machine variables and has a scope
selector under its header. Project settings → Advanced settings opens the same editor for that
project. Changes apply
to the next agent turn and new terminals/commands. Project values are passed per
operation and never installed into the daemon's global environment. They override
global values; provider contributions retain precedence. All scopes share an
encrypted database table and the existing machine-environment encryption key.

Repository setup receives freshly resolved machine variables on each dispatch,
including recovery. Values are sent transiently to the setup process and are
not stored in provisioning requests. Existing attached paths skip setup.

Use `bb machine env list --json` for variables and built-in gh health.
`bb machine env set NAME [--note text] --json` reads the value from
stdin and removes one trailing newline; never pass secrets in argv. Runtime
output is forwarded as-is, so commands and providers can print contributed
values. `bb machine env unset NAME --json` removes an override. All values are
encrypted in the database and omitted from settings responses.

These settings apply globally to every connected machine, including the primary
host. The server synchronizes them into the daemon environment on connection and
settings changes, so background commands and new child processes inherit them.
Removing an override restores the original daemon value. User values override
built-ins; agent-provider entries override host values. Environment synchronization
does not restart cached provider runtimes; they retain their launch environment until
recreated. Reopen existing terminals after a change. The server gh login provides
GitHub Git/gh authentication and commit identity to non-primary hosts by default;
the primary host uses its local Git authentication. A user GH_TOKEN replaces it.
See Settings → Machines →
Machine environment, and `bb machine env list` for builtInGit readiness.

Plugin host calls start immediately using the current environment while any calls
are active in that plugin worker. Changed or removed machine variables take
effect on the next call after all active calls finish. Continuous overlapping
calls can keep the previous values until the worker becomes idle.

On macOS, right-panel tabs use `panel.previousTab` / `panel.nextTab` with
`Command+Control+ArrowLeft` / `Command+Control+ArrowRight`. They wrap through visible
tabs and each pane's New tab button in displayed order across the active
chat's right-panel groups. Press Enter or Space on New tab to open the picker.
On the selected New tab page, `panel.previousNewTabItem` /
`panel.nextNewTabItem` use `Command+Control+ArrowUp` / `Command+Control+ArrowDown` to
move through search, enabled actions, and recent items in displayed order.
Search results replace actions and recents while searching. Enter activates
the focused item.
`history.back` / `history.forward` (Go back / Go forward) do the same thing
as the sidebar's back and forward arrows, moving through the pages opened in
the current window like browser history: `Mod+[` / `Mod+]` on desktop and
the web. `thread.previous` / `thread.next`
(`Mod+Shift+[` / `Mod+Shift+]` on desktop, `Control+Shift+[` / `Control+Shift+]`
on the web) follow the sidebar order instead.
Chat splits use `pane.focus.left` / `right` / `up` / `down` with
`Command+Control+Shift+ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` on macOS. These move
spatially to the adjacent chat pane, including stacked splits, and stop at the
layout edge. The initially unassigned `pane.focus.previous` / `pane.focus.next`
commands still cycle in reading order. On Windows/Linux, these arrow navigation
commands start unassigned to preserve native Control-arrow editing shortcuts.
Rebind any of these commands in Settings → Keyboard, via
`bb settings keyboard set <command> <shortcut|disabled>`, or SDK
`system.updateKeyboardSettings`; read bindings with `system.config`.
Use `bb settings keyboard reset <command>` to adopt the current default.
Overrides can specify `platform: "mac"`, `"windows"`, or `"linux"`; omission applies
on all platforms. A platform-specific override takes precedence over a general one,
including when disabled. UI edits and clears apply only to the current platform;
UI resets remove overrides for the current platform so web and desktop each use
their own defaults. Shared overrides become explicit bindings on the other platforms
to preserve their behavior. Explicit overrides remain resettable even when they match
a default shortcut.
CLI `set` and `reset` accept `--platform mac|windows|linux`; scoped operations retain
other platforms. Unscoped `set` updates the general override; unscoped `reset`
clears all scopes for the selected command (or every command if omitted).

Plugin commands use `plugin:<plugin-id>/<command-id>` as their stable binding
ID. For example: `bb settings keyboard set plugin:example/open-issue Mod+Shift+I`.
`bb settings keyboard reset plugin:example/open-issue` restores the plugin's
default; `set ... disabled` explicitly unbinds it. The SDK supports the same IDs
through `system.updateKeyboardSettings` and `system.config`.
Overrides survive plugin disable/re-enable and reload. Every active plugin
command appears in Keyboard Settings; commands without defaults start unbound.
Conflicting plugin defaults stay unbound and display the conflicting command.
The UI offers Replace binding or Cancel when assigning an occupied shortcut.
`keyboard list` includes all saved overrides and core effective bindings;
plugin defaults and availability are resolved in each app window, where the
plugin frontend runs. CLI/SDK callers should clear conflicting explicit
bindings in the same update; plugin defaults yield to explicit bindings.

### Opt-in server performance diagnostics

Start with `pnpm start --perf-diagnostics`, `pnpm start:worktree --perf-diagnostics`,
or `bb-app --perf-diagnostics` to permit detailed performance logs and rolling
CPU profiles when the experiment is on. `BB_PERF_DIAGNOSTICS=1` is the equivalent startup environment
setting (off by default; restart required). Server logs include five-second
CPU/GC/loop/memory summaries and lower slow-operation thresholds. Profiles
are saved every 30 seconds under `$BB_DATA_DIR/logs/performance/`, in ten
rotating slots of at most 12 MiB each. Copy a relevant `.cpuprofile` promptly
and open it in Chrome DevTools' JavaScript profiler. This adds overhead;
remove the setting and restart to disable. No inspector network port is
opened. Profile files contain local paths/function names; inspect before sharing.

Diagnostics require **both** startup permission (`--perf-diagnostics` or
`BB_PERF_DIAGNOSTICS=1`) and the **Server performance diagnostics** toggle in
Settings → Experiments. The toggle is only shown when startup permission is present; a saved experiment value does not make it visible. The experiment defaults to off. Use
`bb settings experiment performanceDiagnostics true` to enable it, or `false`
to stop it; SDK clients use the existing experiments update endpoint. The
experiment takes effect live on that server. Without startup permission it
cannot start collection. Turning it off restores normal logging thresholds,
stops the sampler and flushes the in-flight profile; existing files remain.
The launch flag only grants permission and still requires a restart to change.


### Share access through BB Connect

In Settings > Remote access, choose **Manage server access** to add or remove
existing bb accounts. Only the gate's server owner can manage membership.
Admins can use the same gate API through this server:

```sh
bb user connect-members list --json
bb user connect-members add EMAIL --role member --json
bb user connect-members remove CONNECT_USER_ID --json
```

The SDK methods are `experimental_users.listConnectMembers`,
`experimental_users.addConnectMember({ email, role? })`, and
`experimental_users.removeConnectMember({ userId })`. These use
`GET /api/v1/users/connect-members`, `POST /api/v1/users/connect-members`, and
`DELETE /api/v1/users/connect-members/:id`. The id belongs to the bb account,
not the local server user. All three require a local admin and a server pairing
owned by the gate account. Gate membership roles do not change local roles or
allow members to manage sharing.

In `multi` mode, also create a local invite restricted to the account's email:
`bb invite create --email EMAIL`. The gate forwards a signed identity with
its account id, verified email, server id, and a one-minute expiry. The server
verifies HMAC-SHA256 using the active tunnel credential, then resolves the local
user by email. An existing user keeps their local role. On first access, an
unexpired email invite creates a local member and consumes the invite, even if
the invite requested admin. Generic invites do not authorize gate registration.
Without an email invite or an existing account, access returns `403`.

Gate membership also allows access to this server's shared ports. Machine
shares keep their existing owner-only access. Signed server identities never
reach shared ports. Removing membership rejects new gate requests; it does
not delete the local account, revoke its PATs, or close existing sockets.
In `local` mode, everyone admitted by the gate acts as the local owner.
Members running agents effectively have host shell access, including secrets.

Tunnels opened before signed identity support keep local owner access. Reconnect
the tunnel to use gate identities in `multi` mode. Daemon machine keys and MCP
OAuth credentials retain their existing behavior.
