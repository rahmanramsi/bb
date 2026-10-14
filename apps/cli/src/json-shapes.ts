export const JSON_SHAPE_BY_COMMAND_PATH: Readonly<Record<string, string>> = {
  status:
    "{project: {id, name} | null, thread: {id, status, title, parentThreadId, environment: {hostId, display} | null} | null, childThreads: [{id, status, title}] | null, pendingTodos, pluginsNeedingAttention: [{id, status}], dataDir}",
  "thread list":
    "[{id, projectId, environmentId, providerId, title, status, parentThreadId, sectionId, visibility, archivedAt, pinnedAt, createdAt, updatedAt, activity}]    (bare array; title can be null)",
  "thread show":
    "{thread: {id, status, title, projectId, environmentId, parentThreadId, ...}, environment: {id, hostId, path, branchName, ...} | null, pendingTodos}    (thread fields are under .thread)",
  "thread log":
    "[{id, seq, type, createdAt, threadId, scope, data}]    (bare array of raw events, oldest first; page with --after-seq <seq>); with --message: {message, before, after} of conversation rows",
  "thread output": "{output}",
  "thread spawn":
    "the created thread: {id, status, title, projectId, environmentId, ...}",
  "thread wait": "{threadId, matched: true, target}",
  "thread search": "{active: {total, results}, archived: {total, results}}",
  "prompt-history list":
    "{entries: [{id, createdAt, input, projectId, threadId, scope}], nextCursor: string | null}    (only the caller's prompts)",
  login: "{user: {id, name, email, role}}",
  logout: "{ok: true}",
  whoami: "{user: {id, name, email, role}}",
  "user connect-members list": "{members: [{userId, email, role}]}",
  "user connect-members add": "{member: {userId, email, role}}",
  "user connect-members remove": "{ok: true}",
  "user role": "{user: {id, name, email, role}}",
  "user remove": "{ok: true}",
  "invite create": "{id, token, role, email, expiresAt}",
  "invite list":
    "{invites: [{id, role, email, expiresAt, createdAt, createdByUserId}]}",
  "invite revoke": "{ok: true}",
  "invite accept": "{user: {id, name, email, role}}",
  "token create": "{token, summary: {id, name, start, createdAt, lastUsedAt}}",
  "token list": "{tokens: [{id, name, start, createdAt, lastUsedAt}]}",
  "token revoke": "{ok: true}",
  "user list": "{users: [{id, name, email, role}]}    (wrapped in .users)",
  "project list":
    "[{id, kind, name, gitRemoteUrl, sources: [{id, hostId, path, isDefault}]}]    (bare array)",
  "machine list":
    "[{id, name, type, status, lifecycle, maxPermissionMode, lastSeenAt}]    (bare array)",
  "provider list":
    "[{id, displayName, available, capabilities, reasoningLevels, serviceTiers}]    (bare array)",
  "provider models":
    "[{id, model, displayName, supportedReasoningEfforts, defaultReasoningEffort, supportedServiceTiers?, isDefault}]    (bare array)",
  "environment list":
    "[{id, name, projectId, hostId, path, branchName, status, lifecycle}]    (bare array)",
  "environment show":
    "{id, name, projectId, hostId, path, branchName, baseBranch, status, lifecycle}",
  "terminal list":
    "{sessions: [{id, title, status, exitCode, closeReason, cols, rows}]}    (wrapped in .sessions)",
  "terminal output":
    '{chunks: [{seq, dataBase64}], nextSeq, truncated, status, exitCode, closeReason}    (chunk data is base64; status is "exited" once the command has finished)',
  "terminal wait": "{terminalId, matched, nextSeq, exitCode}",
  "plugin list":
    "{plugins: [{id, version, enabled, status, source, rootDir}]}    (wrapped in .plugins)",
  "skill list":
    "{skills: [{id, name, description, scope, provider, filePath}]}    (wrapped in .skills)",
};

export function jsonShapeHelp(commandPath: string): string | null {
  const shape = JSON_SHAPE_BY_COMMAND_PATH[commandPath];
  return shape === undefined
    ? null
    : `\nJSON (--json): ${shape}\nErrors with --json: {"ok": false, "error": {code, message, hint?}} on stdout. Run \`bb guide json\` for every shape.`;
}
