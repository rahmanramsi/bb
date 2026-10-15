import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getThread, turnRequestAuthors } from "@bb/db";
import { LOCAL_OWNER_USER_ID } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { availableModelFixture } from "../helpers/available-models.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
} from "../helpers/host-rpc.js";
import { seedThreadFixture, seedThreadRuntimeState } from "../helpers/seed.js";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

let server: RunningTestServer | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server !== null) {
    await server.pluginService.stop();
    await server.close();
    server = null;
  }
});

const GRANTS_PLUGIN_SOURCE = `
  const passthrough = {
    "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
  };
  async function attempt(run: () => Promise<unknown>) {
    try {
      return { ok: true, value: await run() };
    } catch (error: any) {
      return { ok: false, status: error?.status ?? null, code: error?.code ?? null, message: String(error?.message ?? error) };
    }
  }
  export default function plugin(bb: any) {
    bb.rpc.register(
      {
        grant: { input: passthrough, output: passthrough },
        use: { input: passthrough, output: passthrough },
        revoke: { input: passthrough, output: passthrough },
        spawnAsCaller: { input: passthrough, output: passthrough },
      },
      {
        grant: (input: any, ctx: any) =>
          attempt(() => bb.sdk.experimental_createCallerGrant(ctx, input)),
        async use(input: any) {
          let sdk: any;
          try {
            sdk = bb.sdk.experimental_asGrant(input.grantId);
          } catch (error: any) {
            return { ok: false, refused: true, message: String(error?.message ?? error) };
          }
          if (input.op === "same") return { ok: true, value: sdk === bb.sdk };
          if (input.op === "users") return attempt(() => sdk.experimental_users.list());
          if (input.op === "token") return attempt(() => sdk.experimental_auth.createToken({ name: "escalate" }));
          if (input.op === "grant") return attempt(async () => sdk.experimental_createCallerGrant({}, { purpose: "nested" }));
          if (input.op === "grantViaRpc") {
            return attempt(() => sdk.plugins.callRpc({
              pluginId: "grants",
              method: "grant",
              input: { purpose: "laundered" },
              outputSchema: { parse: (value: unknown) => value },
            }));
          }
          if (input.op === "spawn") return attempt(() => sdk.threads.spawn(input.spawn));
          return attempt(() => sdk.experimental_auth.me());
        },
        revoke: (input: any) => bb.sdk.experimental_revokeCallerGrant(input.grantId).then(() => null),
        spawnAsCaller: (input: any, ctx: any) =>
          attempt(() => bb.sdk.experimental_asCaller(ctx).threads.spawn(input.spawn)),
      },
    );
  }
`;

const THIEF_PLUGIN_SOURCE = `
  export default function plugin(bb: any) {
    const passthrough = {
      "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
    };
    bb.rpc.register(
      { steal: { input: passthrough, output: passthrough } },
      {
        async steal(input: any) {
          try {
            bb.sdk.experimental_asGrant(input.grantId);
            return "used";
          } catch (error: any) {
            return String(error?.message ?? error);
          }
        },
      },
    );
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
        description: "Caller grant fixture.",
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
  await installFixture(started, "grants", GRANTS_PLUGIN_SOURCE);
  await installFixture(started, "thief", THIEF_PLUGIN_SOURCE);
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

async function rpc(
  method: string,
  input: unknown,
  headers: Record<string, string>,
  pluginId = "grants",
): Promise<any> {
  const response = await request(
    "POST",
    `/api/v1/plugins/${pluginId}/rpc/${method}`,
    headers,
    input,
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.result;
}

async function mintGrant(
  headers: Record<string, string>,
  request: Record<string, unknown> = { purpose: "Nightly triage" },
): Promise<string> {
  const result = await rpc("grant", request, headers);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return z.object({ grantId: z.string() }).parse(result.value).grantId;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

interface Person {
  headers: Record<string, string>;
  id: string;
}

interface Team {
  admin: Person;
  member: Person;
  otherAdmin: Person;
}

async function signUp(body: Record<string, string>): Promise<Person> {
  const response = await request("POST", "/api/v1/auth/sign-up", {}, body);
  expect(response.status).toBe(201);
  const id: string = (await response.json()).user.id;
  return { headers: { cookie: cookieHeader(response) }, id };
}

async function invite(admin: Person, role: "admin" | "member") {
  const response = await request(
    "POST",
    "/api/v1/auth/invites",
    admin.headers,
    {
      role,
    },
  );
  expect(response.status).toBe(201);
  return (await response.json()).token as string;
}

async function bootstrapTeam(): Promise<Team> {
  const admin = await signUp({
    email: "admin@example.test",
    name: "Admin",
    password: "correct horse battery",
  });
  const member = await signUp({
    email: "member@example.test",
    inviteToken: await invite(admin, "member"),
    name: "Member",
    password: "another long password",
  });
  const otherAdmin = await signUp({
    email: "other@example.test",
    inviteToken: await invite(admin, "admin"),
    name: "Other admin",
    password: "a third long password",
  });
  return { admin, member, otherAdmin };
}

async function setRole(
  actor: Person,
  userId: string,
  role: "admin" | "member",
): Promise<void> {
  const response = await request(
    "PUT",
    `/api/v1/users/${userId}/role`,
    actor.headers,
    { role },
  );
  expect(response.status).toBe(200);
}

async function cappedAdminHeaders(adminId: string) {
  const { issueThreadShellToken } =
    await import("../../src/services/user-auth.js");
  const token = await issueThreadShellToken(server!.config.dataDir, {
    grantId: null,
    userId: adminId,
    roleCeiling: "member",
  });
  return { authorization: `Bearer ${token}` };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("caller grants in multi-user mode", () => {
  it("never lets a member's grant act as an admin, even after promotion", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();
    const grantId = await mintGrant(team.member.headers);

    expect(await rpc("use", { grantId }, team.admin.headers)).toMatchObject({
      ok: true,
      value: {
        user: { id: team.member.id },
        effectiveRole: "member",
        roleCeiling: "member",
      },
    });

    await setRole(team.admin, team.member.id, "admin");

    expect(await rpc("use", { grantId }, team.admin.headers)).toMatchObject({
      ok: true,
      value: { effectiveRole: "member", roleCeiling: "member" },
    });
    expect(
      await rpc("use", { grantId, op: "users" }, team.admin.headers),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("caps an admin's grant at member once the admin is demoted, and a capped token's grant from the start", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();
    const adminGrant = await mintGrant(team.admin.headers);
    const cappedGrant = await mintGrant(
      await cappedAdminHeaders(team.admin.id),
    );

    expect(
      await rpc("use", { grantId: adminGrant }, team.member.headers),
    ).toMatchObject({
      ok: true,
      value: { effectiveRole: "admin", roleCeiling: null },
    });
    expect(
      await rpc("use", { grantId: cappedGrant }, team.member.headers),
    ).toMatchObject({
      ok: true,
      value: { effectiveRole: "member", roleCeiling: "member" },
    });

    await setRole(team.otherAdmin, team.admin.id, "member");

    expect(
      await rpc(
        "use",
        { grantId: adminGrant, op: "users" },
        team.member.headers,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await rpc("use", { grantId: adminGrant }, team.member.headers),
    ).toMatchObject({ ok: true, value: { effectiveRole: "member" } });
  });

  it("refuses a grant after revocation, expiry, or the user's removal, including credentials minted earlier", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const auth = started.deps.userAuth;
    const credentialFor = (grantId: string, userId: string) =>
      auth.issuePluginCallerCredential({
        derivedGrantId: null,
        grantId,
        maxRole: "member",
        pluginId: "grants",
        roleCeiling: "member",
        userId,
      }).token;
    const principalOf = (token: string) =>
      auth.resolvePrincipal(new Headers(bearer(token)));

    const revokedByPlugin = await mintGrant(team.member.headers);
    const earlier = credentialFor(revokedByPlugin, team.member.id);
    expect(await principalOf(earlier)).not.toBeNull();
    await rpc("revoke", { grantId: revokedByPlugin }, team.admin.headers);
    expect(await principalOf(earlier)).toBeNull();
    expect(
      await rpc("use", { grantId: revokedByPlugin }, team.admin.headers),
    ).toMatchObject({ ok: false, refused: true });

    const revokedByUser = await mintGrant(team.member.headers);
    const response = await request(
      "DELETE",
      `/api/v1/users/${team.member.id}/plugin-grants/${revokedByUser}`,
      team.member.headers,
    );
    expect(response.status).toBe(200);
    expect(
      await rpc("use", { grantId: revokedByUser }, team.admin.headers),
    ).toMatchObject({ ok: false, refused: true });

    const expiring = await mintGrant(team.member.headers, {
      purpose: "One day",
      expiresInDays: 1,
    });
    const beforeExpiry = credentialFor(expiring, team.member.id);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2 * 24 * 60 * 60 * 1000);
    expect(await principalOf(beforeExpiry)).toBeNull();
    expect(
      await rpc("use", { grantId: expiring }, team.admin.headers),
    ).toMatchObject({ ok: false, refused: true, message: /expired/ });
    vi.restoreAllMocks();

    const removed = await mintGrant(team.member.headers);
    const beforeRemoval = credentialFor(removed, team.member.id);
    const removal = await request(
      "DELETE",
      `/api/v1/users/${team.member.id}`,
      team.admin.headers,
    );
    expect(removal.status).toBe(200);
    expect(await principalOf(beforeRemoval)).toBeNull();
    expect(
      await rpc("use", { grantId: removed }, team.admin.headers),
    ).toMatchObject({ ok: false, refused: true });
  });

  it("keeps a grant to the plugin that created it", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const grantId = await mintGrant(team.admin.headers);

    expect(
      await rpc("steal", { grantId }, team.admin.headers, "thief"),
    ).toMatch(/does not exist or was revoked/);
    const forged = started.deps.userAuth.issuePluginCallerCredential({
      derivedGrantId: null,
      grantId,
      maxRole: "admin",
      pluginId: "thief",
      roleCeiling: null,
      userId: team.admin.id,
    });
    expect(
      await started.deps.userAuth.resolvePrincipal(
        new Headers(bearer(forged.token)),
      ),
    ).toBeNull();

    await started.pluginService.remove("grants");
    expect(
      await started.deps.userAuth.listPluginCallerGrants(team.admin.id),
    ).toEqual([]);
  });

  it("refuses to mint tokens or grants from a grant", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();
    const grantId = await mintGrant(team.admin.headers);

    expect(
      await rpc("use", { grantId, op: "token" }, team.member.headers),
    ).toMatchObject({ ok: false, status: 403, code: "credential_delegated" });
    expect(
      await rpc("use", { grantId, op: "grant" }, team.member.headers),
    ).toMatchObject({
      ok: false,
      message: /not available on a grant-bound SDK/,
    });
    const laundered = await rpc(
      "use",
      { grantId, op: "grantViaRpc" },
      team.member.headers,
    );
    expect(laundered, JSON.stringify(laundered)).toMatchObject({
      ok: true,
      value: { ok: false },
    });
    expect(laundered.value.message).toMatch(/cannot act as a plugin caller/);
    expect(
      await rpc(
        "grant",
        { purpose: "from the service token" },
        { authorization: `Bearer ${server!.deps.userAuth.serviceToken}` },
      ),
    ).toMatchObject({ ok: false, message: /cannot act as a system caller/ });
  });

  it("permanently lowers an admin's grant to member on demotion, so promotion does not restore it", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const auth = started.deps.userAuth;
    const adminGrant = await mintGrant(team.admin.headers);
    const memberGrant = await mintGrant(team.member.headers);
    const mintedBeforeDemotion = auth.issuePluginCallerCredential({
      derivedGrantId: null,
      grantId: adminGrant,
      maxRole: "admin",
      pluginId: "grants",
      roleCeiling: null,
      userId: team.admin.id,
    }).token;

    await setRole(team.otherAdmin, team.admin.id, "member");
    expect(auth.listPluginCallerGrants(team.admin.id)).toEqual([
      expect.objectContaining({ id: adminGrant, maxRole: "member" }),
    ]);
    expect(auth.listPluginCallerGrants(team.member.id)).toEqual([
      expect.objectContaining({ id: memberGrant, maxRole: "member" }),
    ]);

    await setRole(team.otherAdmin, team.admin.id, "admin");
    expect(auth.listPluginCallerGrants(team.admin.id)).toEqual([
      expect.objectContaining({ id: adminGrant, maxRole: "member" }),
    ]);
    expect(
      await rpc("use", { grantId: adminGrant }, team.member.headers),
    ).toMatchObject({
      ok: true,
      value: { effectiveRole: "member", roleCeiling: "member" },
    });
    expect(
      await rpc(
        "use",
        { grantId: adminGrant, op: "users" },
        team.member.headers,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await auth.resolvePrincipal(new Headers(bearer(mintedBeforeDemotion))),
    ).toMatchObject({ role: "member", roleCeiling: "member" });

    const fresh = await mintGrant(team.admin.headers);
    expect(
      await rpc("use", { grantId: fresh }, team.member.headers),
    ).toMatchObject({
      ok: true,
      value: { effectiveRole: "admin", roleCeiling: null },
    });
  });

  it("expires grants after 90 days by default and only skips expiry when asked", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const before = Date.now();
    const defaulted = await mintGrant(team.member.headers);
    const unbounded = await mintGrant(team.member.headers, {
      purpose: "Indefinite",
      expiresInDays: null,
    });
    const explicit = await mintGrant(team.member.headers, {
      purpose: "Ten days",
      expiresInDays: 10,
    });
    const day = 24 * 60 * 60 * 1000;

    const response = await request(
      "GET",
      `/api/v1/users/${team.member.id}/plugin-grants`,
      team.member.headers,
    );
    expect(response.status).toBe(200);
    const grants = z
      .object({
        grants: z.array(
          z.object({
            id: z.string(),
            createdAt: z.number(),
            expiresAt: z.number().nullable(),
          }),
        ),
      })
      .parse(await response.json()).grants;
    const byId = new Map(grants.map((grant) => [grant.id, grant]));
    expect(byId.get(defaulted)?.expiresAt).toBe(
      byId.get(defaulted)!.createdAt + 90 * day,
    );
    expect(byId.get(defaulted)!.createdAt).toBeGreaterThanOrEqual(before);
    expect(byId.get(unbounded)?.expiresAt).toBeNull();
    expect(byId.get(explicit)?.expiresAt).toBe(
      byId.get(explicit)!.createdAt + 10 * day,
    );

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 91 * day);
    expect(
      await rpc("use", { grantId: defaulted }, team.admin.headers),
    ).toMatchObject({ ok: false, refused: true, message: /expired/ });
    expect(
      await rpc("use", { grantId: unbounded }, team.admin.headers),
    ).toMatchObject({ ok: true });
    vi.restoreAllMocks();
    void started;
  });

  it("validates the purpose and expiry", async () => {
    await startServer("multi");
    const team = await bootstrapTeam();

    for (const invalid of [
      { purpose: "" },
      { purpose: "x".repeat(201) },
      { purpose: "ok", expiresInDays: 0 },
      { purpose: "ok", expiresInDays: 1.5 },
      { purpose: "ok", expiresInDays: 3651 },
      { purpose: "ok", expiresInDays: "never" },
    ]) {
      expect(await rpc("grant", invalid, team.member.headers)).toMatchObject({
        ok: false,
      });
    }
  });

  it("lets people list and revoke their own grants and admins anyone's", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const memberGrant = await mintGrant(team.member.headers, {
      purpose: "Member automation",
      expiresInDays: 30,
    });
    const adminGrant = await mintGrant(team.admin.headers);
    const list = async (userId: string, headers: Record<string, string>) =>
      request("GET", `/api/v1/users/${userId}/plugin-grants`, headers);

    const own = await list(team.member.id, team.member.headers);
    expect(own.status).toBe(200);
    expect((await own.json()).grants).toEqual([
      {
        id: memberGrant,
        pluginId: "grants",
        userId: team.member.id,
        maxRole: "member",
        purpose: "Member automation",
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
      },
    ]);
    expect((await list(team.admin.id, team.member.headers)).status).toBe(403);
    expect(
      (
        await request(
          "DELETE",
          `/api/v1/users/${team.admin.id}/plugin-grants/${adminGrant}`,
          team.member.headers,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "DELETE",
          `/api/v1/users/${team.member.id}/plugin-grants/${adminGrant}`,
          team.member.headers,
        )
      ).status,
    ).toBe(404);
    expect(
      (await list(team.member.id, await cappedAdminHeaders(team.admin.id)))
        .status,
    ).toBe(403);

    const delegated = started.deps.userAuth.issuePluginCallerCredential({
      derivedGrantId: null,
      grantId: null,
      maxRole: "admin",
      pluginId: "grants",
      roleCeiling: null,
      userId: team.admin.id,
    });
    expect((await list(team.admin.id, bearer(delegated.token))).status).toBe(
      403,
    );

    expect((await list(team.member.id, team.admin.headers)).status).toBe(200);
    expect(
      (
        await request(
          "DELETE",
          `/api/v1/users/${team.member.id}/plugin-grants/${memberGrant}`,
          team.admin.headers,
        )
      ).status,
    ).toBe(200);
    expect(
      (await (await list(team.member.id, team.member.headers)).json()).grants,
    ).toEqual([]);
  });
});

describe("caller grants in local mode", () => {
  it("records the local owner's grant and acts through bb.sdk", async () => {
    await startServer("local");
    const grantId = await mintGrant({});

    expect(await rpc("use", { grantId, op: "same" }, {})).toEqual({
      ok: true,
      value: true,
    });
    const listed = await request(
      "GET",
      `/api/v1/users/${LOCAL_OWNER_USER_ID}/plugin-grants`,
      {},
    );
    expect((await listed.json()).grants).toMatchObject([
      { id: grantId, userId: LOCAL_OWNER_USER_ID, maxRole: "admin" },
    ]);
  });
});

describe("threads started for a person by a plugin", () => {
  type Fixture = ReturnType<typeof seedThreadFixture>;

  function respondAsReadyDaemon(target: RunningTestServer, fixture: Fixture) {
    return registerHostRpcResponder(target, {
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      handle: (rpcRequest) => {
        switch (rpcRequest.command.type) {
          case "provider.list_models":
            return {
              ok: true,
              result: {
                models: [availableModelFixture({ model: "test-model" })],
                selectedOnlyModels: [],
              },
            };
          case "provider.health":
            return {
              ok: true,
              result: {
                supported: true,
                health: {
                  status: "ready",
                  statusMessage: null,
                  accountEmail: null,
                  planLabel: null,
                  installedVersion: null,
                  minimumSupportedVersion: null,
                  canInstall: false,
                  canUpdate: false,
                  loginCommand: null,
                },
              },
            };
          case "host.read_workspace_agent_context":
            return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
          default:
            return {
              ok: false,
              errorCode: "test_unhandled",
              errorMessage: rpcRequest.command.type,
            };
        }
      },
    });
  }

  async function firstTurnToken(
    daemon: ReturnType<typeof respondAsReadyDaemon>,
    threadId: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const command = daemon.requests.find(
        (entry) =>
          entry.command.type === "thread.start" &&
          entry.command.threadId === threadId,
      )?.command;
      if (command !== undefined) {
        const env = z
          .object({
            contributedEnv: z.array(
              z.object({ name: z.string(), value: z.unknown() }),
            ),
          })
          .parse(command).contributedEnv;
        return z
          .string()
          .parse(env.find((entry) => entry.name === "BB_TOKEN")?.value);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no thread.start dispatched for ${threadId}`);
  }

  async function expectCappedAfterPromotion(
    team: Team,
    token: string,
  ): Promise<void> {
    await setRole(team.admin, team.member.id, "admin");
    expect((await request("GET", "/api/v1/users", bearer(token))).status).toBe(
      403,
    );
    const pat = await request("POST", "/api/v1/auth/tokens", bearer(token), {
      name: "escalate",
    });
    expect(pat.status).toBe(403);
  }

  function spawnArgs(fixture: Fixture) {
    return {
      projectId: fixture.project.id,
      providerId: "codex",
      model: "test-model",
      environment: { type: "reuse", environmentId: fixture.environment.id },
      prompt: "Run bb whoami",
    };
  }

  it("caps the turn token of a member's thread started through asCaller", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const fixture = seedThreadFixture(started, {
      environment: { status: "ready" },
    });
    const daemon = respondAsReadyDaemon(started, fixture);

    const result = await rpc(
      "spawnAsCaller",
      { spawn: spawnArgs(fixture) },
      team.member.headers,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const thread = getThread(started.db, result.value.id);
    expect(thread).toMatchObject({
      createdByUserId: team.member.id,
    });
    const token = await firstTurnToken(daemon, result.value.id);
    expect(
      await started.deps.userAuth.resolvePrincipal(new Headers(bearer(token))),
    ).toMatchObject({
      userId: team.member.id,
      role: "member",
      roleCeiling: "member",
    });
    await expectCappedAfterPromotion(team, token);
  });

  it("runs a thread started through a member's grant as that member with a capped token", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const fixture = seedThreadFixture(started, {
      environment: { status: "ready" },
    });
    const daemon = respondAsReadyDaemon(started, fixture);
    const grantId = await mintGrant(team.member.headers);

    const result = await rpc(
      "use",
      { grantId, op: "spawn", spawn: spawnArgs(fixture) },
      team.admin.headers,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(getThread(started.db, result.value.id)).toMatchObject({
      createdByUserId: team.member.id,
      originPluginId: "grants",
    });
    const token = await firstTurnToken(daemon, result.value.id);
    expect(
      await started.deps.userAuth.resolvePrincipal(new Headers(bearer(token))),
    ).toMatchObject({ userId: team.member.id, roleCeiling: "member" });
    await expectCappedAfterPromotion(team, token);
  });

  async function grantTurn(
    started: RunningTestServer,
    daemon: ReturnType<typeof respondAsReadyDaemon>,
    fixture: Fixture,
    person: Person,
    actor: Person,
    grantRequest: Record<string, unknown> = { purpose: "Nightly triage" },
  ) {
    const grantId = await mintGrant(person.headers, grantRequest);
    const result = await rpc(
      "use",
      { grantId, op: "spawn", spawn: spawnArgs(fixture) },
      actor.headers,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const threadId: string = result.value.id;
    const token = await firstTurnToken(daemon, threadId);
    const authors = started.db
      .select()
      .from(turnRequestAuthors)
      .where(eq(turnRequestAuthors.threadId, threadId))
      .all();
    expect(authors.length).toBeGreaterThan(0);
    for (const author of authors) {
      expect(author).toMatchObject({
        authorUserId: person.id,
        authorGrantId: grantId,
      });
    }
    return { grantId, threadId, token };
  }

  async function whoami(token: string): Promise<number> {
    return (await request("GET", "/api/v1/me", bearer(token))).status;
  }

  it("stops a grant turn's BB_TOKEN once the grant is revoked, expires, or its plugin or person is removed", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const fixture = seedThreadFixture(started, {
      environment: { status: "ready" },
    });
    const daemon = respondAsReadyDaemon(started, fixture);

    const asCaller = await rpc(
      "spawnAsCaller",
      { spawn: spawnArgs(fixture) },
      team.member.headers,
    );
    expect(asCaller.ok, JSON.stringify(asCaller)).toBe(true);
    const callerToken = await firstTurnToken(daemon, asCaller.value.id);
    expect(
      await started.deps.userAuth.resolvePrincipal(
        new Headers(bearer(callerToken)),
      ),
    ).toMatchObject({ userId: team.member.id, grantId: null });

    const revoked = await grantTurn(
      started,
      daemon,
      fixture,
      team.member,
      team.admin,
    );
    expect(await whoami(revoked.token)).toBe(200);
    expect(
      await started.deps.userAuth.resolvePrincipal(
        new Headers(bearer(revoked.token)),
      ),
    ).toMatchObject({
      userId: team.member.id,
      roleCeiling: "member",
      grantId: revoked.grantId,
    });
    const revocation = await request(
      "DELETE",
      `/api/v1/users/${team.member.id}/plugin-grants/${revoked.grantId}`,
      team.member.headers,
    );
    expect(revocation.status).toBe(200);
    expect(await whoami(revoked.token)).toBe(401);
    expect(await whoami(callerToken)).toBe(200);

    const expiring = await grantTurn(
      started,
      daemon,
      fixture,
      team.member,
      team.admin,
      { purpose: "One day", expiresInDays: 1 },
    );
    expect(await whoami(expiring.token)).toBe(200);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2 * 24 * 60 * 60 * 1000);
    expect(
      await started.deps.userAuth.resolvePrincipal(
        new Headers(bearer(expiring.token)),
      ),
    ).toBeNull();
    vi.restoreAllMocks();

    const pluginRemoved = await grantTurn(
      started,
      daemon,
      fixture,
      team.member,
      team.admin,
    );
    expect(await whoami(pluginRemoved.token)).toBe(200);
    await started.pluginService.remove("grants");
    expect(await whoami(pluginRemoved.token)).toBe(401);
    expect(await whoami(callerToken)).toBe(200);

    const removal = await request(
      "DELETE",
      `/api/v1/users/${team.member.id}`,
      team.admin.headers,
    );
    expect(removal.status).toBe(200);
    expect(await whoami(callerToken)).toBe(401);
  });

  it("refuses to let a person's removal leave their grant turn token working", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const fixture = seedThreadFixture(started, {
      environment: { status: "ready" },
    });
    const daemon = respondAsReadyDaemon(started, fixture);
    const turn = await grantTurn(
      started,
      daemon,
      fixture,
      team.member,
      team.admin,
    );
    expect(await whoami(turn.token)).toBe(200);

    const removal = await request(
      "DELETE",
      `/api/v1/users/${team.member.id}`,
      team.admin.headers,
    );
    expect(removal.status).toBe(200);
    expect(await whoami(turn.token)).toBe(401);
  });

  it("caps an admin grant's turn token after demotion and never lets it mint a PAT or grant", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const fixture = seedThreadFixture(started, {
      environment: { status: "ready" },
    });
    const daemon = respondAsReadyDaemon(started, fixture);
    const turn = await grantTurn(
      started,
      daemon,
      fixture,
      team.admin,
      team.member,
    );
    const principal = await started.deps.userAuth.resolvePrincipal(
      new Headers(bearer(turn.token)),
    );
    expect(principal).toMatchObject({
      userId: team.admin.id,
      role: "admin",
      roleCeiling: null,
      grantId: turn.grantId,
      delegatedPluginId: null,
    });
    expect(
      (await request("GET", "/api/v1/users", bearer(turn.token))).status,
    ).toBe(200);

    const pat = await request(
      "POST",
      "/api/v1/auth/tokens",
      bearer(turn.token),
      { name: "escape" },
    );
    expect(pat.status).toBe(403);
    expect(await pat.json()).toMatchObject({ code: "credential_delegated" });
    const grants = await request(
      "GET",
      `/api/v1/users/${team.admin.id}/plugin-grants`,
      bearer(turn.token),
    );
    expect(grants.status).toBe(403);
    expect(
      await rpc("grant", { purpose: "laundered" }, bearer(turn.token)),
    ).toMatchObject({ ok: false, message: /acting through a grant/ });

    await setRole(team.otherAdmin, team.admin.id, "member");
    await setRole(team.otherAdmin, team.admin.id, "admin");
    expect(
      await started.deps.userAuth.resolvePrincipal(
        new Headers(bearer(turn.token)),
      ),
    ).toMatchObject({ role: "member", roleCeiling: "member" });
    expect(
      (await request("GET", "/api/v1/users", bearer(turn.token))).status,
    ).toBe(403);
  });

  it("keeps threads a grant turn starts through asCaller bound to the grant", async () => {
    const started = await startServer("multi");
    const team = await bootstrapTeam();
    const fixture = seedThreadFixture(started, {
      environment: { status: "ready" },
    });
    const daemon = respondAsReadyDaemon(started, fixture);
    const turn = await grantTurn(
      started,
      daemon,
      fixture,
      team.member,
      team.admin,
    );

    const derived = await rpc(
      "spawnAsCaller",
      { spawn: spawnArgs(fixture) },
      bearer(turn.token),
    );
    expect(derived.ok, JSON.stringify(derived)).toBe(true);
    const derivedToken = await firstTurnToken(daemon, derived.value.id);
    expect(
      await started.deps.userAuth.resolvePrincipal(
        new Headers(bearer(derivedToken)),
      ),
    ).toMatchObject({ userId: team.member.id, grantId: turn.grantId });

    await rpc("revoke", { grantId: turn.grantId }, team.admin.headers);
    expect(await whoami(derivedToken)).toBe(401);
  });

  it("caps a member's side chat fork created through asCaller", async () => {
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

    const result = await rpc(
      "createSideChat",
      { sourceThreadId: source.thread.id, anchorText: "Explain this" },
      team.member.headers,
      "side-chat",
    );

    expect(getThread(started.db, result.threadId)).toMatchObject({
      createdByUserId: team.member.id,
    });
    const authors = started.db
      .select()
      .from(turnRequestAuthors)
      .where(eq(turnRequestAuthors.threadId, result.threadId))
      .all();
    expect(authors.length).toBeGreaterThan(0);
    for (const author of authors) {
      expect(author).toMatchObject({
        authorUserId: team.member.id,
        authorRoleCeiling: "member",
      });
    }
  });
});

describe("automations run as the person who saved them", () => {
  async function startAutomationsTeam() {
    const started = await startServer("multi");
    const entry = await started.pluginService.install("builtin:automations", {
      kind: "root",
    });
    expect(entry.status, entry.statusDetail ?? undefined).toBe("running");
    const team = await bootstrapTeam();
    const fixture = seedThreadFixture(started, {
      environment: { status: "ready" },
    });
    const daemon = registerHostRpcResponder(started, {
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      handle: (rpcRequest) => {
        switch (rpcRequest.command.type) {
          case "provider.list_models":
            return {
              ok: true,
              result: {
                models: [availableModelFixture({ model: "test-model" })],
                selectedOnlyModels: [],
              },
            };
          case "provider.health":
            return {
              ok: true,
              result: {
                supported: true,
                health: {
                  status: "ready",
                  statusMessage: null,
                  accountEmail: null,
                  planLabel: null,
                  installedVersion: null,
                  minimumSupportedVersion: null,
                  canInstall: false,
                  canUpdate: false,
                  loginCommand: null,
                },
              },
            };
          case "host.read_workspace_agent_context":
            return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
          default:
            return {
              ok: false,
              errorCode: "test_unhandled",
              errorMessage: rpcRequest.command.type,
            };
        }
      },
    });
    return { started, team, fixture, daemon };
  }

  async function createMemberAutomation(
    team: Team,
    fixture: ReturnType<typeof seedThreadFixture>,
  ) {
    return rpc(
      "automations_create",
      {
        projectId: fixture.project.id,
        name: "Member digest",
        enabled: true,
        trigger: { triggerType: "once", runAt: Date.now() + 60_000 },
        execution: {
          mode: "agent",
          prompt: "Run bb whoami",
          providerId: "codex",
          model: "test-model",
          permissionMode: "full",
          environment: {
            type: "reuse",
            environmentId: fixture.environment.id,
          },
        },
        origin: "human",
      },
      team.member.headers,
      "automations",
    );
  }

  async function runDueAndReadToken(
    started: RunningTestServer,
    daemon: ReturnType<typeof registerHostRpcResponder>,
    automationId: string,
  ) {
    started.pluginService
      .getApi("automations")!
      .storage.database()
      .prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
      .run(Date.now() - 1, automationId);
    await started.pluginService.reload("automations");

    let threadId: string | undefined;
    for (let attempt = 0; attempt < 500 && threadId === undefined; attempt++) {
      const command = daemon.requests.find(
        (entry) => entry.command.type === "thread.start",
      )?.command;
      threadId =
        command?.type === "thread.start" ? command.threadId : undefined;
      if (threadId === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(threadId).toBeDefined();
    const command = daemon.requests.find(
      (entry) =>
        entry.command.type === "thread.start" &&
        entry.command.threadId === threadId,
    )!.command;
    const token = z.string().parse(
      z
        .object({
          contributedEnv: z.array(
            z.object({ name: z.string(), value: z.unknown() }),
          ),
        })
        .parse(command)
        .contributedEnv.find((env) => env.name === "BB_TOKEN")?.value,
    );
    return { threadId: threadId!, token };
  }

  it("runs a member's scheduled automation with the member's capped token and attribution", async () => {
    const { started, team, fixture, daemon } = await startAutomationsTeam();
    const created = await createMemberAutomation(team, fixture);
    expect(created).toMatchObject({ runsAsCreator: true });
    expect(
      started.deps.userAuth.listPluginCallerGrants(team.member.id),
    ).toMatchObject([
      {
        pluginId: "automations",
        maxRole: "member",
        purpose: 'Automation "Member digest"',
      },
    ]);
    await setRole(team.admin, team.member.id, "admin");

    const { threadId, token } = await runDueAndReadToken(
      started,
      daemon,
      created.id,
    );
    expect(getThread(started.db, threadId)).toMatchObject({
      createdByUserId: team.member.id,
      originPluginId: "automations",
    });
    expect(
      await started.deps.userAuth.resolvePrincipal(new Headers(bearer(token))),
    ).toMatchObject({
      kind: "user",
      userId: team.member.id,
      role: "member",
      roleCeiling: "member",
    });
    expect((await request("GET", "/api/v1/users", bearer(token))).status).toBe(
      403,
    );
  });

  it("keeps running as the member after an admin renames or reschedules it, and runs as the admin only after explicit adoption", async () => {
    const { started, team, fixture, daemon } = await startAutomationsTeam();
    const created = await createMemberAutomation(team, fixture);
    const target = { projectId: fixture.project.id, automationId: created.id };

    const renamed = await rpc(
      "automations_update",
      {
        ...target,
        name: "Renamed by admin",
        trigger: { triggerType: "once", runAt: Date.now() + 120_000 },
      },
      team.admin.headers,
      "automations",
    );
    expect(renamed).toMatchObject({
      runsAsUserId: team.member.id,
      executionRevision: 1,
    });

    const refused = await request(
      "POST",
      "/api/v1/plugins/automations/rpc/automations_update",
      team.admin.headers,
      { ...target, agent: { prompt: "Run bb user list" } },
    );
    expect(refused.status).not.toBe(200);
    expect(JSON.stringify(await refused.json())).toContain(
      "automation_adoption_required",
    );
    const stale = await request(
      "POST",
      "/api/v1/plugins/automations/rpc/automations_adopt",
      team.admin.headers,
      { ...target, expectedRevision: 2 },
    );
    expect(stale.status).not.toBe(200);
    expect(JSON.stringify(await stale.json())).toContain(
      "automation_revision_stale",
    );
    expect(started.deps.userAuth.listPluginCallerGrants(team.admin.id)).toEqual(
      [],
    );
    expect(
      started.deps.userAuth.listPluginCallerGrants(team.member.id),
    ).toHaveLength(1);

    const { threadId, token } = await runDueAndReadToken(
      started,
      daemon,
      created.id,
    );
    expect(getThread(started.db, threadId)).toMatchObject({
      createdByUserId: team.member.id,
    });
    expect(
      await started.deps.userAuth.resolvePrincipal(new Headers(bearer(token))),
    ).toMatchObject({
      userId: team.member.id,
      role: "member",
      roleCeiling: "member",
    });

    const adopted = await rpc(
      "automations_adopt",
      { ...target, expectedRevision: 1 },
      team.admin.headers,
      "automations",
    );
    expect(adopted).toMatchObject({
      runsAsUserId: team.admin.id,
      execution: { prompt: "Run bb whoami" },
    });
    expect(
      started.deps.userAuth.listPluginCallerGrants(team.member.id),
    ).toEqual([]);
    expect(
      started.deps.userAuth.listPluginCallerGrants(team.admin.id),
    ).toMatchObject([{ pluginId: "automations", maxRole: "admin" }]);
  });
});
