import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getThread, recordTurnRequestAuthorInTransaction } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  LOCAL_OWNER_USER_ID,
  type RoleCeiling,
} from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import {
  issueThreadShellToken,
  PLUGIN_CALLER_CREDENTIAL_TTL_MS,
} from "../../src/services/user-auth.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

let server: RunningTestServer | null = null;
const sockets = new Set<WebSocket>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  if (server !== null) {
    await server.pluginService.stop();
    await server.close();
    server = null;
  }
});

const IDENTITY_PLUGIN_SOURCE = `
  const passthrough = {
    "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
  };
  const shared = globalThis as any;
  async function attempt(run: () => Promise<unknown>) {
    try {
      return { ok: true, value: await run() };
    } catch (error: any) {
      return { ok: false, status: error?.status ?? null, code: error?.code ?? null, message: String(error?.message ?? error) };
    }
  }
  export default function plugin(bb: any) {
    const settings = bb.settings.define({ mode: { type: "string", label: "Mode" } });
    bb.rpc.register(
      {
        whoami: { input: passthrough, output: passthrough },
        act: { input: passthrough, output: passthrough },
        setMode: { input: passthrough, output: passthrough },
        lend: { input: passthrough, output: passthrough },
      },
      {
        whoami: (_input: unknown, ctx: any) => ctx.experimental_caller,
        async act(input: any, ctx: any) {
          const sdk = bb.sdk.experimental_asCaller(ctx);
          if (input.op === "same") return sdk === bb.sdk;
          if (input.op === "stash") shared.__identityStash = sdk;
          if (input.op === "users") return attempt(() => sdk.experimental_users.list());
          if (input.op === "token") return attempt(() => sdk.experimental_auth.createToken({ name: "escalate" }));
          if (input.op === "nested") return attempt(async () => sdk.experimental_asCaller(ctx));
          return attempt(() => sdk.experimental_auth.me());
        },
        async setMode(input: any) {
          return attempt(() => settings.experimental_set({ mode: input.mode }));
        },
        lend(_input: unknown, ctx: any) {
          try {
            shared.__borrowAsCaller(ctx);
            return "borrowed";
          } catch (error: any) {
            return String(error?.message ?? error);
          }
        },
      },
    );
    bb.http.route("GET", "/whoami", (c: any, ctx: any) => c.json(ctx.experimental_caller));
    bb.http.route("POST", "/admin", (c: any) => c.json({ admin: true }), { experimental_requiredRole: "admin" });
    bb.http.experimental_websocket("/whoami", (ctx: any) => ({
      onOpen(socket: any) { socket.send(JSON.stringify(ctx.experimental_caller)); },
    }));
    bb.http.experimental_websocket("/admin-socket", () => ({}), { experimental_requiredRole: "admin" });
    bb.agents.registerTool({
      name: "identity_whoami",
      description: "Echo the caller",
      parameters: { type: "object" },
      execute: (_params: unknown, ctx: any) => JSON.stringify(ctx.experimental_caller),
    });
    bb.agents.registerTool({
      name: "identity_admin",
      description: "Admin-only tool",
      parameters: { type: "object" },
      experimental_requiredRole: "admin",
      execute: () => "admin tool ran",
    });
    bb.cli.register({
      name: "identity",
      summary: "Echo the caller",
      run: (_argv: string[], ctx: any) => ({ exitCode: 0, stdout: JSON.stringify([ctx.experimental_caller, ctx.experimental_callerRole]) }),
    });
  }
`;

const BORROWER_PLUGIN_SOURCE = `
  export default function plugin(bb: any) {
    (globalThis as any).__borrowAsCaller = (ctx: any) => bb.sdk.experimental_asCaller(ctx);
  }
`;

async function installFixture(
  target: RunningTestServer,
  name: string,
  source: string,
): Promise<void> {
  const rootDir = join(target.config.dataDir, "fixtures", `bb-plugin-${name}`);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: `bb-plugin-${name}`,
      version: "0.1.0",
      bb: {
        name: `${name} fixture`,
        description: "Caller identity fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), source);
  expect((await target.pluginService.installPath(rootDir)).status).toBe(
    "running",
  );
}

async function startServer(authMode: "local" | "multi") {
  const started = await startTestServer({ authMode });
  server = started;
  started.pluginService.bindSdk({
    baseUrl: started.baseUrl,
    serviceToken: started.deps.userAuth.serviceToken,
  });
  await installFixture(started, "identity", IDENTITY_PLUGIN_SOURCE);
  await installFixture(started, "borrower", BORROWER_PLUGIN_SOURCE);
  return started;
}

function request(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  if (server === null) throw new Error("server not started");
  return fetch(new URL(path, server.baseUrl), {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

async function rpc(
  method: string,
  input: unknown,
  headers: Record<string, string>,
): Promise<any> {
  const response = await request(
    "POST",
    `/api/v1/plugins/identity/rpc/${method}`,
    headers,
    input,
  );
  const body = await json(response);
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.result;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

interface Team {
  admin: Record<string, string>;
  adminId: string;
  cappedAdmin: Record<string, string>;
  member: Record<string, string>;
  memberId: string;
}

async function bootstrapTeam(): Promise<Team> {
  if (server === null) throw new Error("server not started");
  const adminSignUp = await request(
    "POST",
    "/api/v1/auth/sign-up",
    {},
    {
      email: "admin@example.test",
      name: "Admin",
      password: "correct horse battery",
    },
  );
  expect(adminSignUp.status).toBe(201);
  const adminCookie = cookieHeader(adminSignUp);
  const adminId: string = (await json(adminSignUp)).user.id;
  const invite = await json(
    await request(
      "POST",
      "/api/v1/auth/invites",
      { cookie: adminCookie },
      { role: "member" },
    ),
  );
  const memberSignUp = await request(
    "POST",
    "/api/v1/auth/sign-up",
    {},
    {
      email: "member@example.test",
      inviteToken: invite.token,
      name: "Member",
      password: "another long password",
    },
  );
  expect(memberSignUp.status).toBe(201);
  const memberId: string = (await json(memberSignUp)).user.id;
  const capped = await issueThreadShellToken(server.config.dataDir, {
    userId: adminId,
    roleCeiling: "member",
  });
  return {
    admin: { cookie: adminCookie },
    adminId,
    cappedAdmin: { authorization: `Bearer ${capped}` },
    member: { cookie: cookieHeader(memberSignUp) },
    memberId,
  };
}

function firstSocketMessage(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; message: unknown }> {
  if (server === null) throw new Error("server not started");
  const url = new URL(path, server.baseUrl);
  url.protocol = "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.href, { headers });
    sockets.add(socket);
    socket.once("message", (data) =>
      resolve({ status: 101, message: JSON.parse(String(data)) }),
    );
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, message: null });
    });
    socket.once("error", reject);
  });
}

describe("plugin caller identity in multi-user mode", () => {
  it("hands every entry point the authenticated caller with its effective role", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();
    const member = {
      kind: "client",
      userId: team.memberId,
      role: "member",
      roleCeiling: null,
      effectiveRole: "member",
    };
    const cappedAdmin = {
      kind: "client",
      userId: team.adminId,
      role: "admin",
      roleCeiling: "member",
      effectiveRole: "member",
    };
    const admin = {
      kind: "client",
      userId: team.adminId,
      role: "admin",
      roleCeiling: null,
      effectiveRole: "admin",
    };

    expect(await rpc("whoami", null, team.member)).toEqual(member);
    expect(await rpc("whoami", null, team.cappedAdmin)).toEqual(cappedAdmin);
    expect(await rpc("whoami", null, team.admin)).toEqual(admin);
    expect(
      await rpc("whoami", null, {
        authorization: `Bearer ${server!.deps.userAuth.serviceToken}`,
      }),
    ).toEqual({ kind: "system" });
    expect(
      await server!.pluginService.getApi("borrower")!.sdk.plugins.callRpc({
        pluginId: "identity",
        method: "whoami",
        input: null,
        outputSchema: z.unknown(),
      }),
    ).toEqual({ kind: "plugin", pluginId: "borrower" });

    expect(
      await json(
        await request(
          "GET",
          "/api/v1/plugins/identity/http/whoami",
          team.cappedAdmin,
        ),
      ),
    ).toEqual(cappedAdmin);
    expect(
      await firstSocketMessage(
        "/api/v1/plugins/identity/http/whoami",
        team.member,
      ),
    ).toEqual({ status: 101, message: member });
    const cli = await json(
      await request("POST", "/api/v1/plugins/identity/cli", team.cappedAdmin, {
        argv: [],
      }),
    );
    expect(JSON.parse(cli.stdout)).toEqual([cappedAdmin, "member"]);
  });

  it("refuses admin-only HTTP and WebSocket routes to members and capped admins", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();
    for (const headers of [team.member, team.cappedAdmin]) {
      const refused = await request(
        "POST",
        "/api/v1/plugins/identity/http/admin",
        headers,
        {},
      );
      expect(refused.status).toBe(403);
      expect(await json(refused)).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
      expect(
        (
          await firstSocketMessage(
            "/api/v1/plugins/identity/http/admin-socket",
            headers,
          )
        ).status,
      ).toBe(403);
    }
    const allowed = await request(
      "POST",
      "/api/v1/plugins/identity/http/admin",
      team.admin,
      {},
    );
    expect(await json(allowed)).toEqual({ admin: true });
  });

  it("refuses plugin settings writes made inside a member's request", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();
    for (const headers of [team.member, team.cappedAdmin]) {
      expect(await rpc("setMode", { mode: "member" }, headers)).toMatchObject({
        ok: false,
        message: expect.stringContaining("requires a server admin"),
      });
    }
    expect(await rpc("setMode", { mode: "admin" }, team.admin)).toMatchObject({
      ok: true,
      value: { mode: "admin" },
    });
  });

  it("acts as the caller with no more than the caller's authority", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();

    expect(await rpc("act", { op: "me" }, team.member)).toMatchObject({
      ok: true,
      value: {
        user: { id: team.memberId },
        effectiveRole: "member",
        roleCeiling: null,
      },
    });
    expect(await rpc("act", { op: "me" }, team.cappedAdmin)).toMatchObject({
      ok: true,
      value: {
        user: { id: team.adminId },
        effectiveRole: "member",
        roleCeiling: "member",
      },
    });
    expect(await rpc("act", { op: "me" }, team.admin)).toMatchObject({
      ok: true,
      value: { user: { id: team.adminId }, effectiveRole: "admin" },
    });

    for (const headers of [team.member, team.cappedAdmin]) {
      expect(await rpc("act", { op: "users" }, headers)).toMatchObject({
        ok: false,
        status: 403,
      });
    }
    expect(await rpc("act", { op: "users" }, team.admin)).toMatchObject({
      ok: true,
    });

    for (const headers of [team.member, team.cappedAdmin, team.admin]) {
      const refusal = await rpc("act", { op: "token" }, headers);
      expect(refusal).toMatchObject({ ok: false, status: 403 });
      expect(["credential_delegated", "credential_role_capped"]).toContain(
        refusal.code,
      );
    }
    expect(await rpc("act", { op: "nested" }, team.admin)).toMatchObject({
      ok: false,
      message: expect.stringContaining("caller-bound SDK"),
    });
  });

  it("stops the caller credential when the handler returns", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();
    expect(await rpc("act", { op: "stash" }, team.admin)).toMatchObject({
      ok: true,
    });
    const stashed = (globalThis as { __identityStash?: any }).__identityStash;
    await expect(stashed.experimental_auth.me()).rejects.toMatchObject({
      status: 401,
    });
  });

  it("refuses asCaller for plugin and system callers and for another plugin's context", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();
    expect(await rpc("lend", null, team.admin)).toContain(
      "handler of this plugin that is still running",
    );
    const system = await request(
      "POST",
      "/api/v1/plugins/identity/rpc/act",
      { authorization: `Bearer ${server!.deps.userAuth.serviceToken}` },
      { op: "me" },
    );
    expect(system.status).toBe(500);
    expect(await json(system)).toMatchObject({
      error: {
        message: expect.stringContaining("cannot act as a system caller"),
      },
    });
  });

  it("expires caller credentials and binds them to the user's current role", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const auth = started.deps.userAuth;
    const meWith = async (token: string) =>
      auth.authenticate(new Headers({ authorization: `Bearer ${token}` }));

    const admin = auth.issuePluginCallerCredential({
      maxRole: "admin",
      pluginId: "identity",
      roleCeiling: null,
      userId: team.adminId,
    });
    expect((await meWith(admin.token))?.principal).toEqual({
      delegatedPluginId: "identity",
      kind: "user",
      role: "admin",
      roleCeiling: null,
      userId: team.adminId,
    });
    const memberWithAdminClaim = auth.issuePluginCallerCredential({
      maxRole: "admin",
      pluginId: "identity",
      roleCeiling: null,
      userId: team.memberId,
    });
    expect((await meWith(memberWithAdminClaim.token))?.principal.role).toBe(
      "member",
    );
    const capped = auth.issuePluginCallerCredential({
      maxRole: "admin",
      pluginId: "identity",
      roleCeiling: "member",
      userId: team.adminId,
    });
    expect((await meWith(capped.token))?.principal).toMatchObject({
      role: "member",
      roleCeiling: "member",
    });
    const tampered = `${admin.token.slice(0, -2)}xx`;
    expect(await meWith(tampered)).toBeNull();

    admin.revoke();
    expect(await meWith(admin.token)).toBeNull();

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(
      now + PLUGIN_CALLER_CREDENTIAL_TTL_MS + 1,
    );
    expect(await meWith(capped.token)).toBeNull();
  });
});

describe("plugin caller identity in local mode", () => {
  it("treats every caller as the local owner admin and returns bb.sdk from asCaller", async () => {
    await startServer("local");
    expect(await rpc("whoami", null, {})).toEqual({
      kind: "client",
      userId: LOCAL_OWNER_USER_ID,
      role: "admin",
      roleCeiling: null,
      effectiveRole: "admin",
    });
    expect(await rpc("act", { op: "same" }, {})).toBe(true);
    expect(await rpc("setMode", { mode: "local" }, {})).toMatchObject({
      ok: true,
    });
    const allowed = await request(
      "POST",
      "/api/v1/plugins/identity/http/admin",
      {},
      {},
    );
    expect(allowed.status).toBe(200);
  });
});

describe("plugin agent tool callers", () => {
  function seedRunningTurn(
    target: RunningTestServer,
    author: { userId: string; roleCeiling: RoleCeiling | null },
    index: number,
  ) {
    const fixture = seedThreadFixture(target, {
      session: { id: `host-tool-caller-${index}` },
    });
    seedThreadRuntimeState(target.deps, {
      environmentId: fixture.environment.id,
      providerThreadId: `provider-tool-caller-${index}`,
      threadId: fixture.thread.id,
    });
    seedTurnStarted(target.deps, {
      threadId: fixture.thread.id,
      turnId: `turn-${index}`,
    });
    target.db.transaction((tx) =>
      recordTurnRequestAuthorInTransaction(tx, {
        threadId: fixture.thread.id,
        requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        authorUserId: author.userId,
        authorRoleCeiling: author.roleCeiling,
      }),
    );
    return fixture;
  }

  async function callTool(
    target: RunningTestServer,
    fixture: ReturnType<typeof seedThreadFixture>,
    tool: string,
    turnId: string,
  ): Promise<string> {
    const response = await target.app.request("/internal/session/tool-call", {
      method: "POST",
      headers: internalAuthHeaders(target, { hostId: fixture.host.id }),
      body: JSON.stringify({
        sessionId: fixture.session.id,
        threadId: fixture.thread.id,
        providerThreadId: "provider-thread",
        turnId,
        callId: `call-${tool}-${turnId}`,
        tool,
        arguments: {},
      }),
    });
    const body = await json(response);
    return body.contentItems[0].text;
  }

  it("runs tools as the running turn's author and refuses admin tools to members", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const memberTurn = seedRunningTurn(
      started,
      { userId: team.memberId, roleCeiling: null },
      1,
    );
    const cappedTurn = seedRunningTurn(
      started,
      { userId: team.adminId, roleCeiling: "member" },
      2,
    );
    const adminTurn = seedRunningTurn(
      started,
      { userId: team.adminId, roleCeiling: null },
      3,
    );

    expect(
      JSON.parse(
        await callTool(started, memberTurn, "identity_whoami", "turn-1"),
      ),
    ).toEqual({
      kind: "client",
      userId: team.memberId,
      role: "member",
      roleCeiling: null,
      effectiveRole: "member",
    });
    expect(
      JSON.parse(
        await callTool(started, cappedTurn, "identity_whoami", "turn-2"),
      ),
    ).toMatchObject({ userId: team.adminId, effectiveRole: "member" });
    expect(
      JSON.parse(
        await callTool(started, memberTurn, "identity_whoami", "turn-stale"),
      ),
    ).toEqual({ kind: "system" });

    for (const [fixture, turnId] of [
      [memberTurn, "turn-1"],
      [cappedTurn, "turn-2"],
      [memberTurn, "turn-stale"],
    ] as const) {
      expect(
        await callTool(started, fixture, "identity_admin", turnId),
      ).toContain("requires a server admin");
    }
    expect(await callTool(started, adminTurn, "identity_admin", "turn-3")).toBe(
      "admin tool ran",
    );
  });
});

describe("side chat forks", () => {
  it("creates a member's side chat as that member", async () => {
    const started = await startServer("multi");
    const entry = await started.pluginService.install("builtin:side-chat", {
      kind: "root",
    });
    expect(entry.status, entry.statusDetail ?? undefined).toBe("running");
    const team = await bootstrapTeam();
    const source = seedThreadFixture(started, {
      session: { id: "host-side-chat" },
    });
    seedThreadRuntimeState(started.deps, {
      environmentId: source.environment.id,
      providerThreadId: "provider-side-chat-source",
      threadId: source.thread.id,
    });

    const response = await request(
      "POST",
      "/api/v1/plugins/side-chat/rpc/createSideChat",
      team.member,
      { sourceThreadId: source.thread.id, anchorText: "" },
    );
    const body = await json(response);
    expect(response.status, JSON.stringify(body)).toBe(200);

    const fork = getThread(started.db, body.result.threadId);
    expect(fork).toMatchObject({
      createdByUserId: team.memberId,
      originPluginId: "side-chat",
      visibility: "hidden",
    });
  });
});
