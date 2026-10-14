import { createServer } from "node:http";
import { GATE_IDENTITY_HEADER, signGateIdentity } from "@bb/tunnel-contract";
import { setPluginKvValue, authUsers } from "@bb/db";
import { eq } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createNodeBbSdk } from "@bb/sdk/node";
import { issueThreadShellToken } from "../../src/services/user-auth.js";
import { SERVER_SERVICE_TOKEN_FILE_NAME } from "@bb/config/server";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { upsertHost, authVerifications } from "@bb/db";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

let server: RunningTestServer | null = null;
const sockets = new Set<WebSocket>();

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  if (server !== null) {
    await server.pluginService.stop();
    await server.close();
    server = null;
  }
});

interface Probe {
  body?: unknown;
  method: "DELETE" | "GET" | "POST" | "PUT";
  path: string;
}

const ROUTE_FAMILY_PROBES: Probe[] = [
  { method: "GET", path: "/api/v1/projects" },
  { method: "GET", path: "/api/v1/sidebar-bootstrap" },
  { method: "GET", path: "/api/v1/threads" },
  { method: "GET", path: "/api/v1/prompt-history" },
  { method: "GET", path: "/api/v1/hosts" },
  { method: "GET", path: "/api/v1/system/config" },
  { method: "GET", path: "/api/v1/settings/machine-environment" },
  { method: "GET", path: "/api/v1/preferences/ui" },
  { method: "GET", path: "/api/v1/plugins" },
  { method: "GET", path: "/api/v1/plugin-catalog" },
  { method: "GET", path: "/api/v1/plugins/install-jobs" },
  { method: "GET", path: "/api/v1/plugins/update-jobs" },
  { method: "GET", path: "/api/v1/skills-registry" },
  { method: "GET", path: "/api/v1/environments" },
  { method: "GET", path: "/api/v1/files" },
  { method: "GET", path: "/api/v1/terminals" },
  { method: "GET", path: "/api/v1/queues" },
  { method: "GET", path: "/api/v1/desktop-browsers" },
  { method: "GET", path: "/api/v1/users/connect-members" },
  {
    method: "POST",
    path: "/api/v1/users/connect-members",
    body: { email: "member@example.test" },
  },
  { method: "DELETE", path: "/api/v1/users/connect-members/missing" },
  { method: "GET", path: "/api/v1/users" },
  { method: "GET", path: "/api/v1/marketplaces" },
  { method: "POST", path: "/internal/hosts/enroll-key", body: {} },
  { method: "GET", path: "/api/v1/auth/tokens" },
  { method: "POST", path: "/api/v1/plugins/wire/token", body: {} },
  { method: "POST", path: "/api/v1/plugins/wire/rpc/echo", body: {} },
  { method: "POST", path: "/api/v1/auth/invites", body: {} },
  { method: "GET", path: "/api/v1/does-not-exist" },
];

const ADMIN_ONLY_PROBES: Probe[] = [
  { method: "GET", path: "/api/v1/users/connect-members" },
  {
    method: "POST",
    path: "/api/v1/users/connect-members",
    body: { email: "member@example.test" },
  },
  { method: "DELETE", path: "/api/v1/users/connect-members/missing" },
  { method: "GET", path: "/api/v1/users" },
  {
    method: "PUT",
    path: "/api/v1/users/missing/role",
    body: { role: "admin" },
  },
  { method: "DELETE", path: "/api/v1/users/missing" },
  { method: "GET", path: "/api/v1/auth/invites" },
  { method: "DELETE", path: "/api/v1/auth/invites/missing" },
  { method: "POST", path: "/api/v1/auth/invites", body: {} },
  { method: "POST", path: "/api/v1/hosts/join-codes", body: {} },
  {
    method: "POST",
    path: "/api/v1/settings/machine-environment",
    body: { name: "TEAM_SECRET", value: "s3cret" },
  },
  { method: "PUT", path: "/api/v1/plugins/safe-mode", body: { enabled: true } },
  { method: "POST", path: "/api/v1/plugins/wire/disable", body: {} },
  {
    method: "PUT",
    path: "/api/v1/plugins/wire/settings",
    body: { values: {} },
  },
  { method: "POST", path: "/api/v1/plugins/reload", body: {} },
  { method: "POST", path: "/api/v1/plugin-catalog/install", body: {} },
  { method: "POST", path: "/api/v1/system/config/reload" },
  { method: "GET", path: "/api/v1/server/move" },
  { method: "POST", path: "/internal/hosts/enroll-key", body: {} },
  { method: "DELETE", path: "/api/v1/hosts/missing" },
  { method: "POST", path: "/api/v1/plugins/wire/enable", body: {} },
  { method: "DELETE", path: "/api/v1/plugins/wire" },
  { method: "POST", path: "/api/v1/plugins/install", body: {} },
  { method: "POST", path: "/api/v1/marketplaces", body: {} },
];

const WIRE_PLUGIN_SOURCE = `
  export default function plugin(bb: any) {
    bb.http.route("GET", "/identity-header", (c: any) => c.json({ identity: c.req.header("x-bb-gate-identity") ?? null, userToken: c.req.header("x-bb-user-token") ?? null }));
    bb.http.route("GET", "/local", (c: any) => c.json({ local: true }));
    bb.http.route("GET", "/guarded", (c: any) => c.json({ guarded: true }), {
      auth: "token",
    });
    bb.http.route("GET", "/open", (c: any) => c.json({ open: true }), {
      auth: "none",
    });
    for (const auth of ["local", "token", "none"]) {
      bb.http.experimental_websocket("/socket-" + auth, () => ({
        onMessage(socket: any, data: any) { socket.send(data); },
      }), { auth });
    }
  }
`;

async function installWirePlugin(target: RunningTestServer): Promise<void> {
  const rootDir = join(target.config.dataDir, "fixtures", "bb-plugin-wire");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-wire",
      version: "0.1.0",
      bb: {
        name: "Wire fixture",
        description: "Plugin wire fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), WIRE_PLUGIN_SOURCE);
  const entry = await target.pluginService.installPath(rootDir);
  expect(entry.status).toBe("running");
}

async function send(
  probe: Probe,
  headers: Record<string, string> = {},
): Promise<Response> {
  if (server === null) throw new Error("server not started");
  return fetch(new URL(probe.path, server.baseUrl), {
    method: probe.method,
    headers: {
      ...(probe.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...headers,
    },
    ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
  });
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function signUp(body: {
  email: string;
  inviteToken?: string;
  name: string;
  password: string;
}): Promise<Response> {
  return send({ method: "POST", path: "/api/v1/auth/sign-up", body });
}

async function createToken(cookie: string): Promise<string> {
  const response = await send(
    { method: "POST", path: "/api/v1/auth/tokens", body: { name: "cli" } },
    { cookie },
  );
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    typeof Reflect.get(body, "token") !== "string"
  ) {
    throw new Error("token response is missing a token");
  }
  return Reflect.get(body, "token");
}

interface TeamCredentials {
  adminCookie: string;
  adminToken: string;
  memberCookie: string;
  memberToken: string;
}

async function bootstrapTeam(): Promise<TeamCredentials> {
  const admin = await signUp({
    email: "Admin@Example.test",
    name: "Admin",
    password: "correct horse battery",
  });
  expect(admin.status).toBe(201);
  expect(await admin.json()).toMatchObject({
    user: { email: "admin@example.test", role: "admin" },
  });
  const adminCookie = cookieHeader(admin);
  const invite = await send(
    { method: "POST", path: "/api/v1/auth/invites", body: {} },
    { cookie: adminCookie },
  );
  expect(invite.status).toBe(201);
  const inviteBody: unknown = await invite.json();
  const inviteToken =
    typeof inviteBody === "object" && inviteBody !== null
      ? Reflect.get(inviteBody, "token")
      : undefined;
  if (typeof inviteToken !== "string") throw new Error("missing invite");
  const member = await signUp({
    email: "member@example.test",
    inviteToken,
    name: "Member",
    password: "another long password",
  });
  expect(member.status).toBe(201);
  expect(await member.json()).toMatchObject({ user: { role: "member" } });
  const memberCookie = cookieHeader(member);
  return {
    adminCookie,
    adminToken: await createToken(adminCookie),
    memberCookie,
    memberToken: await createToken(memberCookie),
  };
}

function websocketStatus(
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  if (server === null) throw new Error("server not started");
  const url = new URL(path, server.baseUrl);
  url.protocol = "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.href, { headers });
    sockets.add(socket);
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("error", reject);
  });
}

describe("multi-user authentication", () => {
  it("rejects every route family without credentials, including over loopback", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installWirePlugin(server);

    for (const probe of ROUTE_FAMILY_PROBES) {
      const response = await send(probe);
      expect(
        { path: probe.path, status: response.status },
        `${probe.method} ${probe.path}`,
      ).toEqual({ path: probe.path, status: 401 });
    }
    const localWire = await send({
      method: "GET",
      path: "/api/v1/plugins/wire/http/local",
    });
    expect(localWire.status).toBe(401);
    expect(
      (await send({ method: "GET", path: "/api/v1/plugins/wire/http/guarded" }))
        .status,
    ).toBe(401);

    expect(await websocketStatus("/ws")).toBe(401);
    expect(await websocketStatus("/ws/terminals/missing")).toBe(401);

    const session = await send({ method: "GET", path: "/api/v1/auth/session" });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({
      authMode: "multi",
      needsBootstrap: true,
      principalKind: null,
      user: null,
    });
  });

  it("requires user credentials on plugin HTTP and WebSocket routes in every auth mode", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installWirePlugin(server);
    const team = await bootstrapTeam();
    const token = await server.pluginService.httpToken("wire");
    const pluginHeaders = { "x-bb-plugin-token": token ?? "" };
    const userHeaders = {
      ...pluginHeaders,
      authorization: `Bearer ${team.memberToken}`,
    };
    for (const path of ["local", "guarded", "open"]) {
      const probe = {
        method: "GET",
        path: `/api/v1/plugins/wire/http/${path}`,
      } as const;
      expect((await send(probe, pluginHeaders)).status).toBe(401);
      expect((await send(probe, userHeaders)).status).toBe(200);
    }
    for (const auth of ["local", "token", "none"]) {
      const path = `/api/v1/plugins/wire/http/socket-${auth}`;
      expect(await websocketStatus(path, pluginHeaders)).toBe(401);
      expect(await websocketStatus(path, userHeaders)).toBe(101);
    }
    expect(
      (
        await send(
          { method: "GET", path: "/api/v1/plugins/wire/http/open" },
          {
            authorization: "Bearer provider-hub-token",
            "x-bb-user-token": "invalid",
          },
        )
      ).status,
    ).toBe(401);
    const routed = await send(
      { method: "GET", path: "/api/v1/plugins/wire/http/identity-header" },
      {
        authorization: "Bearer provider-hub-token",
        "x-bb-user-token": team.memberToken,
      },
    );
    expect(routed.status).toBe(200);
    expect(await routed.json()).toMatchObject({ userToken: null });
    expect(
      (
        await send(
          { method: "GET", path: "/api/v1/users" },
          {
            "x-bb-user-token": team.adminToken,
          },
        )
      ).status,
    ).toBe(401);
  });

  it("closes plugin WebSockets when their personal access token is revoked", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installWirePlugin(server);
    const team = await bootstrapTeam();
    const sdk = createNodeBbSdk({
      baseUrl: server.baseUrl,
      context: { authToken: team.memberToken },
    });
    const credential = await sdk.experimental_auth.createToken({
      name: "socket",
    });
    const url = new URL(
      "/api/v1/plugins/wire/http/socket-none",
      server.baseUrl,
    );
    url.protocol = "ws:";
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${credential.token}` },
    });
    sockets.add(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Revoked plugin socket stayed open")),
        2000,
      );
      socket.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    await sdk.experimental_auth.revokeToken({ id: credential.summary.id });
    expect(await closed).toBe(1008);
  });

  it("rejects unknown bearer tokens and forged session cookies", async () => {
    server = await startTestServer({ authMode: "multi" });
    await bootstrapTeam();

    const forgedHeaders: Record<string, string>[] = [
      { authorization: "Bearer bbpat_not-a-real-token" },
      { authorization: "Bearer test-daemon-key:host-1" },
      { cookie: "bb.session_token=forged.signature" },
      { "x-bb-gate-auth": "session" },
    ];
    for (const headers of forgedHeaders) {
      const response = await send(
        { method: "GET", path: "/api/v1/projects" },
        headers,
      );
      expect(response.status, JSON.stringify(headers)).toBe(401);
    }
  });

  it("accepts session cookies and personal access tokens on HTTP and WebSocket routes", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installWirePlugin(server);
    const team = await bootstrapTeam();

    const credentialHeaders: Record<string, string>[] = [
      { cookie: team.adminCookie },
      { authorization: `Bearer ${team.memberToken}` },
    ];
    for (const headers of credentialHeaders) {
      for (const path of [
        "/api/v1/projects",
        "/api/v1/threads",
        "/api/v1/hosts",
        "/api/v1/plugins",
        "/api/v1/plugins/wire/http/local",
      ]) {
        const response = await send({ method: "GET", path }, headers);
        expect(response.status, `${path} ${JSON.stringify(headers)}`).toBe(200);
      }
      expect(await websocketStatus("/ws", headers)).toBe(101);
    }

    const session = await send(
      { method: "GET", path: "/api/v1/auth/session" },
      { authorization: `Bearer ${team.memberToken}` },
    );
    expect(await session.json()).toMatchObject({
      authMode: "multi",
      needsBootstrap: false,
      principalKind: "user",
      user: { email: "member@example.test", role: "member" },
    });
  });

  it("keeps a bootstrap admin when the first account accepts a member invite", async () => {
    server = await startTestServer({ authMode: "multi" });
    const guest = createNodeBbSdk({ baseUrl: server.baseUrl });
    await expect(
      guest.experimental_auth.acceptInvite({
        inviteToken: "bbinv_invalid",
        email: "first@example.test",
        name: "First",
        password: "a long account password",
      }),
    ).rejects.toMatchObject({ status: 403, code: "invite_required" });
    const admin = createNodeBbSdk({
      baseUrl: server.baseUrl,
      context: { authToken: server.deps.userAuth.serviceToken },
    });
    const invite = await admin.experimental_auth.createInvite({
      role: "member",
    });
    const result = await guest.experimental_auth.acceptInvite({
      inviteToken: invite.token,
      email: "first@example.test",
      name: "First",
      password: "a long account password",
    });
    expect(result.user.role).toBe("admin");
    expect((await guest.experimental_auth.session()).needsBootstrap).toBe(
      false,
    );
  });

  it("requires an invite after the first user and promotes only the first user to admin", async () => {
    server = await startTestServer({ authMode: "multi" });
    await bootstrapTeam();

    const uninvited = await signUp({
      email: "stranger@example.test",
      name: "Stranger",
      password: "yet another password",
    });
    expect(uninvited.status).toBe(403);
    expect(await uninvited.json()).toMatchObject({ code: "invite_required" });

    const forged = await signUp({
      email: "stranger@example.test",
      inviteToken: "bbinv_forged",
      name: "Stranger",
      password: "yet another password",
    });
    expect(forged.status).toBe(403);
  });

  it("serializes bootstrap and consumes email-bound invites only once", async () => {
    server = await startTestServer({ authMode: "multi" });
    const registrations = await Promise.all(
      ["first", "second"].map((name) =>
        signUp({
          email: `${name}@example.test`,
          name,
          password: "correct horse battery",
        }),
      ),
    );
    expect(registrations.map((response) => response.status).sort()).toEqual([
      201, 403,
    ]);
    const admin = registrations.find((response) => response.status === 201);
    if (admin === undefined) throw new Error("Missing bootstrap admin");
    const cookie = cookieHeader(admin);
    const invite = await send(
      {
        method: "POST",
        path: "/api/v1/auth/invites",
        body: { email: "invited@example.test" },
      },
      { cookie },
    );
    const { token } = (await invite.json()) as { token: string };
    const registration = {
      email: "invited@example.test",
      inviteToken: token,
      name: "Invited",
      password: "correct horse battery",
    };
    expect(
      (await signUp({ ...registration, email: "wrong@example.test" })).status,
    ).toBe(403);
    expect((await signUp(registration)).status).toBe(201);
    expect((await signUp(registration)).status).toBe(403);
    for (const [token, value, expiresAt] of [
      ["malformed", "{", new Date(Date.now() + 10000)],
      [
        "expired",
        JSON.stringify({
          role: "member",
          email: null,
          createdByUserId: "usr_local_owner",
        }),
        new Date(1),
      ],
    ] as const) {
      server.db
        .insert(authVerifications)
        .values({
          id: `${token}-invite`,
          identifier: `bb-invite:${createHash("sha256").update(token).digest("hex")}`,
          value,
          expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
      expect(
        (
          await signUp({
            ...registration,
            inviteToken: token,
            email: `${token}@example.test`,
          })
        ).status,
      ).toBe(403);
    }
  });

  it("keeps local enrollment private and machine credentials separate from user credentials", async () => {
    server = await startTestServer({ authMode: "multi" });
    const serviceToken = await readFile(
      join(server.config.dataDir, SERVER_SERVICE_TOKEN_FILE_NAME),
      "utf8",
    );
    const enrolled = await send(
      {
        method: "POST",
        path: "/internal/hosts/enroll-key",
        body: { hostId: "host-auth-boundary" },
      },
      { authorization: `Bearer ${serviceToken.trim()}` },
    );
    expect(enrolled.status).toBe(201);
    const host = upsertHost(server.db, server.deps.hub, {
      id: "host-auth-boundary",
      name: "Auth boundary",
    });
    const key = await server.deps.machineAuth.issueDaemonHostKey({
      hostId: host.id,
    });
    const headers = { authorization: `Bearer ${key}` };
    expect(
      (await send({ method: "GET", path: "/api/v1/projects" }, headers)).status,
    ).toBe(401);
    expect(
      (
        await send(
          { method: "GET", path: "/internal/skills/tree/missing" },
          headers,
        )
      ).status,
    ).toBe(404);
    const team = await bootstrapTeam();
    expect(
      (
        await send(
          { method: "GET", path: "/internal/skills/tree/missing" },
          {
            authorization: `Bearer ${team.adminToken}`,
          },
        )
      ).status,
    ).toBe(401);
    const directory = await send(
      { method: "GET", path: "/api/v1/users/directory" },
      { cookie: team.adminCookie },
    );
    const { users } = (await directory.json()) as {
      users: Array<{ id: string }>;
    };
    expect(users.map((user) => user.id)).not.toContain(
      "bb-machine-auth-system-user",
    );
  });

  it("signs in, signs out, and revokes personal access tokens", async () => {
    server = await startTestServer({ authMode: "multi" });
    const team = await bootstrapTeam();

    const wrongPassword = await send({
      method: "POST",
      path: "/api/v1/auth/sign-in",
      body: { email: "member@example.test", password: "wrong password" },
    });
    expect(wrongPassword.status).toBe(401);

    const signedIn = await send({
      method: "POST",
      path: "/api/v1/auth/sign-in",
      body: { email: "member@example.test", password: "another long password" },
    });
    expect(signedIn.status).toBe(200);
    const cookie = cookieHeader(signedIn);
    expect(
      (await send({ method: "GET", path: "/api/v1/projects" }, { cookie }))
        .status,
    ).toBe(200);
    const signedOut = await send(
      { method: "POST", path: "/api/v1/auth/sign-out" },
      { cookie },
    );
    expect(signedOut.status).toBe(200);
    expect(
      (await send({ method: "GET", path: "/api/v1/projects" }, { cookie }))
        .status,
    ).toBe(401);

    const tokens = await send(
      { method: "GET", path: "/api/v1/auth/tokens" },
      { authorization: `Bearer ${team.memberToken}` },
    );
    const tokenList: unknown = await tokens.json();
    const tokenId =
      typeof tokenList === "object" && tokenList !== null
        ? Reflect.get(Reflect.get(tokenList, "tokens")[0], "id")
        : undefined;
    expect(typeof tokenId).toBe("string");
    expect(
      (
        await send(
          { method: "DELETE", path: `/api/v1/auth/tokens/${tokenId}` },
          { authorization: `Bearer ${team.adminToken}` },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await send(
          { method: "DELETE", path: `/api/v1/auth/tokens/${tokenId}` },
          { cookie: team.memberCookie },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          { method: "GET", path: "/api/v1/projects" },
          { authorization: `Bearer ${team.memberToken}` },
        )
      ).status,
    ).toBe(401);
  });

  it("keeps the in-process plugin SDK working through the server service token", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installWirePlugin(server);
    server.pluginService.bindSdk({
      baseUrl: server.baseUrl,
      serviceToken: server.deps.userAuth.serviceToken,
    });
    const api = server.pluginService.getApi("wire");
    if (api === undefined) throw new Error("wire plugin is not running");
    await expect(api.sdk.projects.list()).resolves.toEqual([]);
  });

  it("keeps plugin logs to admins", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installWirePlugin(server);
    const team = await bootstrapTeam();
    const probe: Probe = {
      method: "GET",
      path: "/api/v1/plugins/wire/logs?tail=10",
    };

    const member = await send(probe, {
      authorization: `Bearer ${team.memberToken}`,
    });
    expect(member.status).toBe(403);
    expect(JSON.stringify(await member.json())).not.toContain("lines");
    const admin = await send(probe, {
      authorization: `Bearer ${team.adminToken}`,
    });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ ok: true, lines: [] });
  });

  it("returns 403 to members on admin-only actions and lets admins through", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installWirePlugin(server);
    const team = await bootstrapTeam();

    for (const probe of ADMIN_ONLY_PROBES) {
      const response = await send(probe, {
        authorization: `Bearer ${team.memberToken}`,
      });
      expect(response.status, `${probe.method} ${probe.path}`).toBe(403);
    }
    const rotate = await send(
      {
        method: "POST",
        path: "/api/v1/plugins/wire/token",
        body: { rotate: true },
      },
      { authorization: `Bearer ${team.memberToken}` },
    );
    expect(rotate.status).toBe(403);
    const read = await send(
      { method: "POST", path: "/api/v1/plugins/wire/token", body: {} },
      { authorization: `Bearer ${team.memberToken}` },
    );
    expect(read.status).toBe(200);

    const adminSecret = await send(
      {
        method: "POST",
        path: "/api/v1/settings/machine-environment",
        body: { name: "TEAM_SECRET", value: "s3cret" },
      },
      { authorization: `Bearer ${team.adminToken}` },
    );
    expect(adminSecret.status).toBe(200);
    const adminInvite = await send(
      { method: "POST", path: "/api/v1/auth/invites", body: {} },
      { cookie: team.adminCookie },
    );
    expect(adminInvite.status).toBe(201);
  });
});

describe("local auth mode", () => {
  it("serves every route family without credentials as the local owner", async () => {
    server = await startTestServer();
    await installWirePlugin(server);

    for (const path of [
      "/api/v1/projects",
      "/api/v1/threads",
      "/api/v1/hosts",
      "/api/v1/system/config",
      "/api/v1/plugins",
      "/api/v1/auth/tokens",
      "/api/v1/plugins/wire/http/local",
    ]) {
      const response = await send({ method: "GET", path });
      expect(response.status, path).toBe(200);
    }
    expect(await websocketStatus("/ws")).toBe(101);

    for (const probe of [
      { method: "POST", path: "/api/v1/auth/invites", body: {} },
      {
        method: "POST",
        path: "/api/v1/settings/machine-environment",
        body: { name: "TEAM_SECRET", value: "s3cret" },
      },
      {
        method: "PUT",
        path: "/api/v1/plugins/safe-mode",
        body: { enabled: false },
      },
    ] satisfies Probe[]) {
      const response = await send(probe);
      expect(response.status, probe.path).toBeLessThan(300);
    }

    const session = await send({ method: "GET", path: "/api/v1/auth/session" });
    expect(await session.json()).toMatchObject({
      authMode: "local",
      needsBootstrap: false,
      principalKind: "local",
      user: { id: "usr_local_owner", role: "admin" },
    });
    const signUpAttempt = await signUp({
      email: "someone@example.test",
      name: "Someone",
      password: "long enough password",
    });
    expect(signUpAttempt.status).toBe(409);
  });
});

describe("user administration", () => {
  it("changes roles immediately, protects the last admin, and removes cached user credentials", async () => {
    server = await startTestServer({ authMode: "multi" });
    const team = await bootstrapTeam();
    const admin = createNodeBbSdk({
      baseUrl: server.baseUrl,
      context: { authToken: team.adminToken },
    });
    const member = createNodeBbSdk({
      baseUrl: server.baseUrl,
      context: { authToken: team.memberToken },
    });
    const { user } = await member.experimental_auth.me();
    const { user: owner } = await admin.experimental_auth.me();
    await expect(member.experimental_users.list()).rejects.toMatchObject({
      status: 403,
    });
    expect((await member.experimental_users.directory()).users).toContainEqual(
      user,
    );
    await expect(
      admin.experimental_users.updateRole({ userId: owner.id, role: "member" }),
    ).rejects.toMatchObject({ status: 409, code: "last_admin" });
    await expect(
      admin.experimental_users.remove({ userId: owner.id }),
    ).rejects.toMatchObject({ status: 409, code: "last_admin" });
    await expect(
      admin.experimental_users.remove({ userId: "usr_local_owner" }),
    ).rejects.toMatchObject({ status: 409, code: "protected_user" });
    await expect(
      admin.experimental_users.updateRole({ userId: "missing", role: "admin" }),
    ).rejects.toMatchObject({ status: 404 });
    const shellToken = await issueThreadShellToken(
      server.config.dataDir,
      user.id,
    );
    const shell = createNodeBbSdk({
      baseUrl: server.baseUrl,
      context: { authToken: shellToken },
    });
    expect((await shell.experimental_auth.me()).user.role).toBe("member");
    await expect(shell.experimental_users.list()).rejects.toMatchObject({
      status: 403,
    });
    await admin.experimental_users.updateRole({
      userId: user.id,
      role: "admin",
    });
    expect((await member.experimental_users.list()).users).toContainEqual({
      ...user,
      role: "admin",
    });
    expect((await shell.experimental_auth.me()).user.role).toBe("admin");
    await admin.experimental_users.updateRole({
      userId: user.id,
      role: "member",
    });
    await expect(member.experimental_users.list()).rejects.toMatchObject({
      status: 403,
    });
    const tampered = createNodeBbSdk({
      baseUrl: server.baseUrl,
      context: { authToken: `${shellToken}x` },
    });
    await expect(tampered.experimental_auth.me()).rejects.toMatchObject({
      status: 401,
    });
    await admin.experimental_users.remove({ userId: user.id });
    await expect(member.experimental_auth.me()).rejects.toMatchObject({
      status: 401,
    });
    await expect(shell.experimental_auth.me()).rejects.toMatchObject({
      status: 401,
    });
    expect(
      (await admin.experimental_users.list()).users.some(
        (entry) => entry.id === user.id,
      ),
    ).toBe(false);
  });

  it("lists pending invites without their secrets and rejects revoked, mismatched, or reused invites", async () => {
    server = await startTestServer({ authMode: "multi" });
    const team = await bootstrapTeam();
    const admin = createNodeBbSdk({
      baseUrl: server.baseUrl,
      context: { authToken: team.adminToken },
    });
    const guest = createNodeBbSdk({ baseUrl: server.baseUrl });
    const invited = await admin.experimental_auth.createInvite({
      email: "next@example.test",
      role: "admin",
    });
    const list = await admin.experimental_auth.listInvites();
    expect(list.invites).toContainEqual(
      expect.objectContaining({
        id: invited.id,
        email: "next@example.test",
        role: "admin",
      }),
    );
    expect(JSON.stringify(list)).not.toContain(invited.token);
    const account = {
      name: "Next",
      email: "wrong@example.test",
      password: "a valid long password",
      inviteToken: invited.token,
    };
    await expect(
      guest.experimental_auth.acceptInvite(account),
    ).rejects.toMatchObject({ status: 403, code: "invite_email_mismatch" });
    expect(
      (
        await guest.experimental_auth.acceptInvite({
          ...account,
          email: "next@example.test",
        })
      ).user.role,
    ).toBe("admin");
    await expect(
      guest.experimental_auth.acceptInvite({
        ...account,
        email: "next@example.test",
      }),
    ).rejects.toMatchObject({ status: 403, code: "invite_required" });
    expect((await admin.experimental_auth.listInvites()).invites).toHaveLength(
      0,
    );
    const revoked = await admin.experimental_auth.createInvite({});
    await admin.experimental_auth.revokeInvite({ id: revoked.id });
    await expect(
      guest.experimental_auth.acceptInvite({
        ...account,
        inviteToken: revoked.token,
      }),
    ).rejects.toMatchObject({ status: 403, code: "invite_required" });
    await expect(
      admin.experimental_auth.revokeInvite({ id: revoked.id }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("signed connect gate credentials", () => {
  const secret = "bbcred_tunnel-secret";
  const serverId = "srv_gate";
  function pair() {
    if (server === null) throw new Error("server not started");
    setPluginKvValue(
      server.db,
      "bb-account",
      "credential",
      JSON.stringify({
        credential: secret,
        serverId,
        baseUrl: "https://getbb.app",
        serverUrl: "https://team.getbb.app",
      }),
    );
  }
  async function gateToken(
    email: string,
    overrides: Partial<{ expiresAt: number; serverId: string }> = {},
    key = secret,
  ) {
    return signGateIdentity(
      {
        userId: "connect-account-id",
        email,
        serverId,
        expiresAt: Date.now() + 60_000,
        ...overrides,
      },
      key,
    );
  }

  it("maps existing users by email and preserves their local role on HTTP and WebSockets", async () => {
    server = await startTestServer({ authMode: "multi" });
    await bootstrapTeam();
    await installWirePlugin(server);
    pair();
    for (const [email, role] of [
      ["admin@example.test", "admin"],
      ["member@example.test", "member"],
    ]) {
      const token = await gateToken(email);
      const headers = { [GATE_IDENTITY_HEADER]: token };
      const response = await send(
        { method: "GET", path: "/api/v1/auth/session" },
        headers,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        principalKind: "user",
        user: { email, role },
      });
      expect(await websocketStatus("/ws", headers)).toBe(101);
      const echo = await send(
        { method: "GET", path: "/api/v1/plugins/wire/http/identity-header" },
        headers,
      );
      expect(echo.status).toBe(200);
      expect(await echo.json()).toEqual({ identity: null, userToken: null });
      expect(
        (await send({ method: "GET", path: "/api/v1/users" }, headers)).status,
      ).toBe(role === "admin" ? 200 : 403);
    }
  });

  it("consumes an email invite once and creates a member even for an admin invite", async () => {
    server = await startTestServer({ authMode: "multi" });
    const team = await bootstrapTeam();
    pair();
    const headers = {
      [GATE_IDENTITY_HEADER]: await gateToken("new@example.test"),
    };
    expect(
      (await send({ method: "GET", path: "/api/v1/projects" }, headers)).status,
    ).toBe(403);
    const invite = await send(
      {
        method: "POST",
        path: "/api/v1/auth/invites",
        body: { email: "new@example.test", role: "admin" },
      },
      { cookie: team.adminCookie },
    );
    const invited = await invite.json();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        send({ method: "GET", path: "/api/v1/auth/session" }, headers),
      ),
    );
    for (const response of responses)
      expect(await response.json()).toMatchObject({
        user: { email: "new@example.test", role: "member" },
      });
    const users = server.db
      .select()
      .from(authUsers)
      .where(eq(authUsers.email, "new@example.test"))
      .all();
    expect(users).toHaveLength(1);
    expect(users[0].id).not.toBe("connect-account-id");
    expect(
      server.db
        .select()
        .from(authVerifications)
        .where(eq(authVerifications.id, invited.id))
        .get(),
    ).toBeUndefined();
    server.db.delete(authUsers).where(eq(authUsers.id, users[0].id)).run();
    expect(
      (await send({ method: "GET", path: "/api/v1/projects" }, headers)).status,
    ).toBe(403);
  });

  it("rejects forgery, expiry, wrong audience, and old credentials after rotation", async () => {
    server = await startTestServer({ authMode: "multi" });
    await bootstrapTeam();
    pair();
    const valid = await gateToken("admin@example.test");
    const tokens = [
      "forged",
      `${valid.slice(0, -2)}aa`,
      await gateToken("admin@example.test", {}, "wrong-key"),
      await gateToken("admin@example.test", { expiresAt: Date.now() - 1 }),
      await gateToken("admin@example.test", { serverId: "other-server" }),
      await gateToken("admin@example.test", {
        expiresAt: Date.now() + 3600_000,
      }),
    ];
    for (const token of tokens) {
      const headers = { [GATE_IDENTITY_HEADER]: token };
      expect(
        (await send({ method: "GET", path: "/api/v1/projects" }, headers))
          .status,
      ).toBe(401);
      expect(await websocketStatus("/ws", headers)).toBe(401);
    }
    setPluginKvValue(
      server.db,
      "bb-account",
      "credential",
      JSON.stringify({ credential: "rotated", serverId }),
    );
    expect(
      (
        await send(
          { method: "GET", path: "/api/v1/projects" },
          { [GATE_IDENTITY_HEADER]: valid },
        )
      ).status,
    ).toBe(401);
  });

  it("does not admit new users through expired, revoked, generic, or mismatched invites", async () => {
    server = await startTestServer({ authMode: "multi" });
    const team = await bootstrapTeam();
    pair();
    const generic = await send(
      { method: "POST", path: "/api/v1/auth/invites", body: {} },
      { cookie: team.adminCookie },
    );
    expect(generic.status).toBe(201);
    const invite = await send(
      {
        method: "POST",
        path: "/api/v1/auth/invites",
        body: { email: "expired@example.test" },
      },
      { cookie: team.adminCookie },
    );
    const invited = await invite.json();
    server.db
      .update(authVerifications)
      .set({ expiresAt: new Date(0) })
      .where(eq(authVerifications.id, invited.id))
      .run();
    for (const email of ["expired@example.test", "mismatched@example.test"])
      expect(
        (
          await send(
            { method: "GET", path: "/api/v1/projects" },
            { [GATE_IDENTITY_HEADER]: await gateToken(email) },
          )
        ).status,
      ).toBe(403);
  });

  it("keeps local mode credentialless and strips the identity header", async () => {
    server = await startTestServer();
    expect(
      (
        await send(
          { method: "GET", path: "/api/v1/projects" },
          { [GATE_IDENTITY_HEADER]: "client-forgery" },
        )
      ).status,
    ).toBe(200);
  });
});

it("manages connect members through authenticated SDK routes and validates the gate response", async () => {
  server = await startTestServer({ authMode: "multi" });
  const team = await bootstrapTeam();
  const captured: {
    method: string;
    url: string;
    credential: string | string[] | undefined;
    body: string;
  }[] = [];
  let reply: "ok" | "invalid" | "forbidden" = "ok";
  const member = {
    userId: "connect-member",
    email: "remote@example.test",
    role: "member",
  };
  const gate = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    captured.push({
      method: request.method ?? "",
      url: request.url ?? "",
      credential: request.headers["x-bb-connect-machine"],
      body,
    });
    response.setHeader("content-type", "application/json");
    if (reply === "forbidden") {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "owner_required" }));
      return;
    }
    if (reply === "invalid") {
      response.end(JSON.stringify({ members: [{ email: "missing-fields" }] }));
      return;
    }
    response.end(
      JSON.stringify(
        request.method === "GET"
          ? { members: [member] }
          : request.method === "POST"
            ? { member }
            : { ok: true },
      ),
    );
  });
  await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
  const gateAddress = gate.address();
  if (gateAddress === null || typeof gateAddress === "string")
    throw new Error("gate listener unavailable");
  try {
    setPluginKvValue(
      server.db,
      "bb-account",
      "credential",
      JSON.stringify({
        credential: "bbcred_owner",
        serverId: "connect-server",
        serverUrl: `http://127.0.0.1:${gateAddress.port}`,
      }),
    );
    const sdk = createNodeBbSdk({
      baseUrl: server.baseUrl,
      context: { authToken: team.adminToken },
    });
    expect(await sdk.experimental_users.listConnectMembers()).toEqual({
      members: [member],
    });
    expect(
      await sdk.experimental_users.addConnectMember({ email: member.email }),
    ).toEqual({ member });
    expect(
      await sdk.experimental_users.removeConnectMember({
        userId: member.userId,
      }),
    ).toEqual({ ok: true });
    expect(captured).toEqual([
      {
        method: "GET",
        url: "/api/connect/server-members?serverId=connect-server",
        credential: "bbcred_owner",
        body: "",
      },
      {
        method: "POST",
        url: "/api/connect/server-members?serverId=connect-server",
        credential: "bbcred_owner",
        body: JSON.stringify({ email: member.email, role: "member" }),
      },
      {
        method: "DELETE",
        url: "/api/connect/server-members?serverId=connect-server&userId=connect-member",
        credential: "bbcred_owner",
        body: "",
      },
    ]);
    const denied = await send(
      { method: "GET", path: "/api/v1/users/connect-members" },
      { authorization: `Bearer ${team.memberToken}` },
    );
    expect(denied.status).toBe(403);
    expect(captured).toHaveLength(3);
    reply = "invalid";
    expect(
      (
        await send(
          { method: "GET", path: "/api/v1/users/connect-members" },
          { authorization: `Bearer ${team.adminToken}` },
        )
      ).status,
    ).toBe(502);
    reply = "forbidden";
    const forbidden = await send(
      { method: "GET", path: "/api/v1/users/connect-members" },
      { authorization: `Bearer ${team.adminToken}` },
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "owner_required" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      gate.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function openSocket(
  path: string,
  headers: Record<string, string>,
): Promise<WebSocket> {
  if (server === null) throw new Error("server not started");
  const url = new URL(path, server.baseUrl);
  url.protocol = "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.href, { headers });
    sockets.add(socket);
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`WebSocket upgrade failed: ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(-1);
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

async function memberTokenId(memberToken: string): Promise<string> {
  const response = await send(
    { method: "GET", path: "/api/v1/auth/tokens" },
    { authorization: `Bearer ${memberToken}` },
  );
  const body: unknown = await response.json();
  const tokens =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "tokens")
      : undefined;
  const id = Array.isArray(tokens) ? Reflect.get(tokens[0], "id") : undefined;
  if (typeof id !== "string") throw new Error("missing token id");
  return id;
}

describe("authenticated socket revocation", () => {
  it("closes realtime sockets when their token is revoked, their session signs out, or their user is removed", async () => {
    server = await startTestServer({ authMode: "multi" });
    const team = await bootstrapTeam();
    const adminSocket = await openSocket("/ws", {
      authorization: `Bearer ${team.adminToken}`,
    });
    const tokenSocket = await openSocket("/ws", {
      authorization: `Bearer ${team.memberToken}`,
    });
    const cookieSocket = await openSocket("/ws", {
      cookie: team.memberCookie,
    });

    const tokenClosed = closeCode(tokenSocket);
    expect(
      (
        await send(
          {
            method: "DELETE",
            path: `/api/v1/auth/tokens/${await memberTokenId(team.memberToken)}`,
          },
          { cookie: team.memberCookie },
        )
      ).status,
    ).toBe(200);
    expect(await tokenClosed).toBe(1008);
    expect(cookieSocket.readyState).toBe(WebSocket.OPEN);

    const cookieClosed = closeCode(cookieSocket);
    expect(
      (
        await send(
          { method: "POST", path: "/api/v1/auth/sign-out" },
          { cookie: team.memberCookie },
        )
      ).status,
    ).toBe(200);
    expect(await cookieClosed).toBe(1008);

    const signedIn = await send({
      method: "POST",
      path: "/api/v1/auth/sign-in",
      body: { email: "member@example.test", password: "another long password" },
    });
    expect(signedIn.status).toBe(200);
    const memberCookie = cookieHeader(signedIn);
    const memberSocket = await openSocket("/ws", { cookie: memberCookie });
    const me = await send(
      { method: "GET", path: "/api/v1/me" },
      { cookie: memberCookie },
    );
    const meBody: unknown = await me.json();
    const memberId =
      typeof meBody === "object" && meBody !== null
        ? Reflect.get(Reflect.get(meBody, "user"), "id")
        : undefined;
    if (typeof memberId !== "string") throw new Error("missing member id");
    const memberClosed = closeCode(memberSocket);
    expect(
      (
        await send(
          { method: "DELETE", path: `/api/v1/users/${memberId}` },
          { cookie: team.adminCookie },
        )
      ).status,
    ).toBe(200);
    expect(await memberClosed).toBe(1008);
    expect(adminSocket.readyState).toBe(WebSocket.OPEN);
  });

  it("closes sockets whose user changes role so they reconnect with the new role", async () => {
    server = await startTestServer({ authMode: "multi" });
    const team = await bootstrapTeam();
    const memberSocket = await openSocket("/ws", {
      authorization: `Bearer ${team.memberToken}`,
    });
    const me = await send(
      { method: "GET", path: "/api/v1/me" },
      { authorization: `Bearer ${team.memberToken}` },
    );
    const meBody: unknown = await me.json();
    const memberId =
      typeof meBody === "object" && meBody !== null
        ? Reflect.get(Reflect.get(meBody, "user"), "id")
        : undefined;
    if (typeof memberId !== "string") throw new Error("missing member id");
    const closed = closeCode(memberSocket);
    expect(
      (
        await send(
          {
            method: "PUT",
            path: `/api/v1/users/${memberId}/role`,
            body: { role: "admin" },
          },
          { cookie: team.adminCookie },
        )
      ).status,
    ).toBe(200);
    expect(await closed).toBe(1008);
    expect(
      await websocketStatus("/ws", {
        authorization: `Bearer ${team.memberToken}`,
      }),
    ).toBe(101);
  });
});

describe("session cookie security", () => {
  it("marks session cookies Secure when the app URL is HTTPS", async () => {
    server = await startTestServer({
      authMode: "multi",
      appUrl: "https://bb.example.test",
    });
    const registered = await signUp({
      email: "admin@example.test",
      name: "Admin",
      password: "correct horse battery",
    });
    expect(registered.status).toBe(201);
    const [cookie] = registered.headers.getSetCookie();
    expect(cookie).toMatch(/^__Secure-bb\.session_token=/u);
    expect(cookie).toMatch(/;\s*Secure/iu);
    expect(cookie).toMatch(/;\s*HttpOnly/iu);
    expect(
      (
        await send(
          { method: "GET", path: "/api/v1/projects" },
          { cookie: cookieHeader(registered) },
        )
      ).status,
    ).toBe(200);
  });

  it("keeps plain cookies for HTTP app URLs so loopback browsers can sign in", async () => {
    server = await startTestServer({
      authMode: "multi",
      appUrl: "http://localhost:5173",
    });
    const registered = await signUp({
      email: "admin@example.test",
      name: "Admin",
      password: "correct horse battery",
    });
    const [cookie] = registered.headers.getSetCookie();
    expect(cookie).toMatch(/^bb\.session_token=/u);
    expect(cookie).not.toMatch(/;\s*Secure/iu);
  });
});

describe("sign-in throttling", () => {
  it("limits repeated password guesses for one account without locking out others", async () => {
    server = await startTestServer({ authMode: "multi" });
    await bootstrapTeam();
    const attempt = (email: string, password: string) =>
      send({
        method: "POST",
        path: "/api/v1/auth/sign-in",
        body: { email, password },
      });
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push(
        (await attempt("member@example.test", `wrong password ${index}`))
          .status,
      );
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
    const locked = await attempt(
      "Member@Example.test",
      "another long password",
    );
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ code: "rate_limited" });
    expect(
      (await attempt("admin@example.test", "correct horse battery")).status,
    ).toBe(200);
  });
});

const ROLES_PLUGIN_SOURCE = `
  const passthrough = {
    "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
  };
  export default function plugin(bb: any) {
    bb.rpc.register(
      {
        read: { input: passthrough, output: passthrough },
        write: { experimental_requiredRole: "admin", input: passthrough, output: passthrough },
      },
      { read: () => ({ read: true }), write: () => ({ written: true }) },
    );
    bb.cli.register({
      name: "roles",
      summary: "Echo the caller role",
      run: (_argv: string[], ctx: any) => ({ exitCode: 0, stdout: String(ctx.experimental_callerRole) }),
    });
  }
`;

describe("plugin admin operations", () => {
  it("refuses admin-only RPC methods to members and passes the caller role to plugin CLIs", async () => {
    server = await startTestServer({ authMode: "multi" });
    const rootDir = join(server.config.dataDir, "fixtures", "bb-plugin-roles");
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-roles",
        version: "0.1.0",
        bb: {
          name: "Roles fixture",
          description: "Plugin role fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(join(rootDir, "server.ts"), ROLES_PLUGIN_SOURCE);
    expect((await server.pluginService.installPath(rootDir)).status).toBe(
      "running",
    );
    const team = await bootstrapTeam();
    const member = { authorization: `Bearer ${team.memberToken}` };
    const admin = { authorization: `Bearer ${team.adminToken}` };
    const rpc = (method: string, headers: Record<string, string>) =>
      send(
        {
          method: "POST",
          path: `/api/v1/plugins/roles/rpc/${method}`,
          body: {},
        },
        headers,
      );

    const refused = await rpc("write", member);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await (await rpc("read", member)).json()).toEqual({
      ok: true,
      result: { read: true },
    });
    expect(await (await rpc("write", admin)).json()).toEqual({
      ok: true,
      result: { written: true },
    });

    for (const [headers, role] of [
      [member, "member"],
      [admin, "admin"],
    ] as const) {
      const response = await send(
        {
          method: "POST",
          path: "/api/v1/plugins/roles/cli",
          body: { argv: [] },
        },
        headers,
      );
      expect(await response.json()).toMatchObject({
        exitCode: 0,
        stdout: role,
      });
    }
  });
});
