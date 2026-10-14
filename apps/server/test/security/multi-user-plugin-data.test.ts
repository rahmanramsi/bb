import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginUserKv, pluginUserSettings, setPluginKvValue } from "@bb/db";
import { LOCAL_OWNER_USER_ID } from "@bb/domain";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
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

const DATA_PLUGIN_SOURCE = `
  const passthrough = {
    "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
  };
  export default function plugin(bb: any) {
    const settings = bb.settings.define({
      density: {
        type: "select",
        label: "Density",
        options: ["compact", "cozy"],
        default: "cozy",
        experimental_scope: "user",
      },
      teamName: { type: "string", label: "Team name", default: "eng" },
    });
    const mine = (context: any) => bb.storage.experimental_forUser(context.experimental_callerUserId);
    bb.rpc.register(
      {
        whoami: { input: passthrough, output: passthrough },
        saveMine: { input: passthrough, output: passthrough },
        readMine: { input: passthrough, output: passthrough },
        readTeam: { input: passthrough, output: passthrough },
        storageFor: { input: passthrough, output: passthrough },
        mySettings: { input: passthrough, output: passthrough },
        teamSettings: { input: passthrough, output: passthrough },
        publishMine: { input: passthrough, output: passthrough },
        publishTeam: { input: passthrough, output: passthrough },
      },
      {
        whoami: (_input: any, context: any) => ({ userId: context.experimental_callerUserId }),
        saveMine: async (input: any, context: any) => {
          await mine(context).kv.set(input.key, input.value);
          return null;
        },
        readMine: async (input: any, context: any) => ({
          value: (await mine(context).kv.get(input.key)) ?? null,
          keys: await mine(context).kv.list(),
        }),
        readTeam: async (input: any) => ({ value: (await bb.storage.kv.get(input.key)) ?? null }),
        storageFor: async (input: any) => {
          try {
            return { value: (await bb.storage.experimental_forUser(input.userId).kv.get("k")) ?? null };
          } catch (error: any) {
            return { error: error.message };
          }
        },
        mySettings: (_input: any, context: any) => bb.settings.experimental_getForUser(context.experimental_callerUserId),
        teamSettings: () => settings.get(),
        publishMine: (input: any, context: any) => {
          bb.realtime.publish("prefs", input, { experimental_userId: context.experimental_callerUserId });
          return null;
        },
        publishTeam: (input: any) => {
          bb.realtime.publish("prefs", input);
          return null;
        },
      },
    );
  }
`;

async function installDataPlugin(target: RunningTestServer): Promise<void> {
  const rootDir = join(target.config.dataDir, "fixtures", "bb-plugin-data");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-data",
      version: "0.1.0",
      bb: {
        name: "User data fixture",
        description: "Per-user plugin data fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), DATA_PLUGIN_SOURCE);
  const entry = await target.pluginService.installPath(rootDir);
  expect(entry.status, entry.statusDetail ?? undefined).toBe("running");
}

async function request(
  method: "DELETE" | "GET" | "POST" | "PUT",
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
): Promise<unknown> {
  const response = await request(
    "POST",
    `/api/v1/plugins/data/rpc/${method}`,
    headers,
    input,
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  if (typeof body !== "object" || body === null) {
    throw new Error("rpc response is not an object");
  }
  return Reflect.get(body, "result");
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

interface Team {
  admin: Record<string, string>;
  member: Record<string, string>;
  adminId: string;
  memberId: string;
}

async function userId(headers: Record<string, string>): Promise<string> {
  const result = await rpc("whoami", null, headers);
  const id =
    typeof result === "object" && result !== null
      ? Reflect.get(result, "userId")
      : undefined;
  if (typeof id !== "string") throw new Error("whoami returned no user id");
  return id;
}

async function bootstrapTeam(): Promise<Team> {
  const admin = await request("POST", "/api/v1/auth/sign-up", {}, {
    email: "admin@example.test",
    name: "Admin",
    password: "correct horse battery",
  });
  expect(admin.status).toBe(201);
  const adminCookie = cookieHeader(admin);
  const invite = await request(
    "POST",
    "/api/v1/auth/invites",
    { cookie: adminCookie },
    {},
  );
  const inviteBody: unknown = await invite.json();
  const inviteToken =
    typeof inviteBody === "object" && inviteBody !== null
      ? Reflect.get(inviteBody, "token")
      : undefined;
  if (typeof inviteToken !== "string") throw new Error("missing invite");
  const member = await request("POST", "/api/v1/auth/sign-up", {}, {
    email: "member@example.test",
    inviteToken,
    name: "Member",
    password: "another long password",
  });
  expect(member.status).toBe(201);
  const adminHeaders = { cookie: adminCookie };
  const memberHeaders = { cookie: cookieHeader(member) };
  return {
    admin: adminHeaders,
    member: memberHeaders,
    adminId: await userId(adminHeaders),
    memberId: await userId(memberHeaders),
  };
}

interface SignalSocket {
  signals: unknown[];
  next(): Promise<unknown>;
}

function openSignalSocket(headers: Record<string, string>): Promise<SignalSocket> {
  if (server === null) throw new Error("server not started");
  const url = new URL("/ws", server.baseUrl);
  url.protocol = "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.href, { headers });
    sockets.add(socket);
    const signals: unknown[] = [];
    const waiters: Array<(signal: unknown) => void> = [];
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(String(data));
      if (
        typeof message !== "object" ||
        message === null ||
        Reflect.get(message, "type") !== "plugin-signal"
      ) {
        return;
      }
      signals.push(message);
      waiters.shift()?.(message);
    });
    socket.once("open", () =>
      resolve({
        signals,
        next: () =>
          new Promise((resolveSignal) => {
            waiters.push(resolveSignal);
          }),
      }),
    );
    socket.once("error", reject);
  });
}

describe("user-scoped plugin storage", () => {
  it("keeps each user's rows private, leaves team kv alone, and deletes them with the account", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installDataPlugin(server);
    const team = await bootstrapTeam();
    setPluginKvValue(server.deps.db, "data", "sort", JSON.stringify("team"));

    await rpc("saveMine", { key: "sort", value: "alpha" }, team.admin);
    await rpc(
      "saveMine",
      { key: "sort", value: "updated", userId: team.adminId },
      team.member,
    );

    expect(await rpc("readMine", { key: "sort" }, team.admin)).toEqual({
      value: "alpha",
      keys: ["sort"],
    });
    expect(await rpc("readMine", { key: "sort" }, team.member)).toEqual({
      value: "updated",
      keys: ["sort"],
    });
    expect(await rpc("readTeam", { key: "sort" }, team.member)).toEqual({
      value: "team",
    });
    expect(
      await rpc("storageFor", { userId: "usr_nobody" }, team.admin),
    ).toEqual({ error: expect.stringContaining('unknown user "usr_nobody"') });

    const removed = await request(
      "DELETE",
      `/api/v1/users/${team.memberId}`,
      team.admin,
    );
    expect(removed.status).toBe(200);
    expect(
      server.deps.db
        .select()
        .from(pluginUserKv)
        .where(eq(pluginUserKv.userId, team.memberId))
        .all(),
    ).toEqual([]);
    expect(await rpc("readMine", { key: "sort" }, team.admin)).toEqual({
      value: "alpha",
      keys: ["sort"],
    });
  });
});

describe("user-scoped plugin settings", () => {
  it("lets members change only their own per-user settings and keeps team settings admin-only", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installDataPlugin(server);
    const team = await bootstrapTeam();

    const memberWrite = await request(
      "PUT",
      "/api/v1/plugins/data/settings",
      team.member,
      { values: { density: "compact" } },
    );
    expect(memberWrite.status).toBe(200);
    expect(await memberWrite.json()).toMatchObject({
      ok: true,
      schema: { density: { experimental_scope: "user" } },
      values: { density: "compact", teamName: "eng" },
    });

    const adminView = await request(
      "GET",
      "/api/v1/plugins/data/settings",
      team.admin,
    );
    expect(await adminView.json()).toMatchObject({
      values: { density: "cozy", teamName: "eng" },
    });
    const memberView = await request(
      "GET",
      "/api/v1/plugins/data/settings",
      team.member,
    );
    expect(await memberView.json()).toMatchObject({
      values: { density: "compact" },
    });

    for (const values of [{ teamName: "ops" }, { density: "cozy", teamName: "ops" }]) {
      const refused = await request(
        "PUT",
        "/api/v1/plugins/data/settings",
        team.member,
        { values },
      );
      expect(refused.status).toBe(403);
    }
    expect(await rpc("mySettings", null, team.member)).toEqual({
      density: "compact",
      teamName: "eng",
    });

    const adminWrite = await request(
      "PUT",
      "/api/v1/plugins/data/settings",
      team.admin,
      { values: { teamName: "ops", density: "compact" } },
    );
    expect(adminWrite.status).toBe(200);
    await request("PUT", "/api/v1/plugins/data/settings", team.admin, {
      values: { density: null },
    });

    expect(await rpc("mySettings", null, team.admin)).toEqual({
      density: "cozy",
      teamName: "ops",
    });
    expect(await rpc("mySettings", null, team.member)).toEqual({
      density: "compact",
      teamName: "ops",
    });
    expect(await rpc("teamSettings", null, team.member)).toEqual({
      density: "cozy",
      teamName: "ops",
    });

    const removed = await request(
      "DELETE",
      `/api/v1/users/${team.memberId}`,
      team.admin,
    );
    expect(removed.status).toBe(200);
    expect(
      server.deps.db
        .select()
        .from(pluginUserSettings)
        .where(eq(pluginUserSettings.userId, team.memberId))
        .all(),
    ).toEqual([]);
  });
});

describe("targeted plugin realtime", () => {
  it("delivers a user-targeted signal only to that user's sockets and broadcasts the rest", async () => {
    server = await startTestServer({ authMode: "multi" });
    await installDataPlugin(server);
    const team = await bootstrapTeam();
    const adminSocket = await openSignalSocket(team.admin);
    const memberSocket = await openSignalSocket(team.member);
    const secondMemberSocket = await openSignalSocket(team.member);

    const memberSignal = memberSocket.next();
    const secondMemberSignal = secondMemberSocket.next();
    await rpc("publishMine", { n: 1 }, team.member);
    const expected = {
      type: "plugin-signal",
      pluginId: "data",
      channel: "prefs",
      payload: { n: 1 },
    };
    await expect(memberSignal).resolves.toEqual(expected);
    await expect(secondMemberSignal).resolves.toEqual(expected);

    const adminSignal = adminSocket.next();
    await rpc("publishTeam", { n: 2 }, team.member);
    await expect(adminSignal).resolves.toMatchObject({ payload: { n: 2 } });
    expect(adminSocket.signals).toEqual([
      { ...expected, payload: { n: 2 } },
    ]);
    await expect.poll(() => memberSocket.signals.length).toBe(2);
  });
});

describe("local mode", () => {
  it("acts as the local owner for per-user storage, settings, and signals", async () => {
    server = await startTestServer();
    await installDataPlugin(server);
    const local = { origin: server.baseUrl };

    expect(await rpc("whoami", null, local)).toEqual({
      userId: LOCAL_OWNER_USER_ID,
    });
    await rpc("saveMine", { key: "sort", value: "alpha" }, local);
    expect(await rpc("readMine", { key: "sort" }, local)).toEqual({
      value: "alpha",
      keys: ["sort"],
    });
    const write = await request(
      "PUT",
      "/api/v1/plugins/data/settings",
      local,
      { values: { density: "compact", teamName: "ops" } },
    );
    expect(write.status).toBe(200);
    expect(await rpc("mySettings", null, local)).toEqual({
      density: "compact",
      teamName: "ops",
    });
    const socket = await openSignalSocket(local);
    const signal = socket.next();
    await rpc("publishMine", { n: 1 }, local);
    await expect(signal).resolves.toMatchObject({ payload: { n: 1 } });
  });
});
