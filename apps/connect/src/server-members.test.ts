import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  decodeFrame,
  encodeFrame,
  GATE_IDENTITY_HEADER,
} from "@bb/tunnel-contract";
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { applyConnectDbMigrationsToD1 } from "@bb/connect-db/testing";
import { handleServerMembers } from "./server-members.js";
import type { Env } from "./tunnel-do.js";

let script: string;
beforeAll(async () => {
  const bundled = await build({
    entryPoints: [
      fileURLToPath(new URL("../test/identity-fixture.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    target: "esnext",
    conditions: ["workerd", "worker", "browser"],
    write: false,
  });
  script = bundled.outputFiles[0].text;
});
let mf: Miniflare;
let db: D1Database;
let env: Env;
let credential: string;
let sessionToken: string;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script,
    durableObjects: { TUNNEL_DO: "IdentityTunnelDO" },
    d1Databases: ["DB"],
    bindings: {
      BASE_DOMAIN: "bb.localhost",
      ACCOUNT_APP_URL: "http://bb.localhost",
      CLOUD_DEV: "true",
      BETTER_AUTH_SECRET: "test-secret",
    },
  });
  db = await mf.getD1Database("DB");
  await applyConnectDbMigrationsToD1(db);
  for (const id of ["owner", "member", "outsider"])
    await db
      .prepare(
        "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?, ?, ?, 1, 1, 1)",
      )
      .bind(id, id, `${id}@example.com`)
      .run();
  credential = randomUUID();
  const { sha256Hex } = await import("@bb/connect-db");
  await db
    .prepare(
      "INSERT INTO server (id,user_id,subdomain,credential_hash,created_at) VALUES ('srv','owner','shared',?,1)",
    )
    .bind(await sha256Hex(credential))
    .run();
  sessionToken = randomUUID();
  await db
    .prepare(
      "INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,'member',?,1,1)",
    )
    .bind(sessionToken, sessionToken, Date.now() + 30 * 24 * 60 * 60 * 1000)
    .run();
  env = {
    DB: db,
    BASE_DOMAIN: "getbb.app",
    BETTER_AUTH_SECRET: "test-secret",
  } as Env;
});
afterEach(async () => mf.dispose());

async function request(
  method: string,
  options: {
    body?: unknown;
    query?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return handleServerMembers(
    new Request(
      `https://shared.getbb.app/api/connect/server-members${options.query ?? ""}`,
      {
        method,
        headers: { "x-bb-connect-machine": credential, ...options.headers },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      },
    ),
    env,
  );
}

it("lets the owner add, list, change roles, and remove a member without changing ownership", async () => {
  expect(
    (
      await request("POST", {
        body: { email: " MEMBER@example.com ", role: "member" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request("POST", {
        body: { email: "member@example.com", role: "admin" },
      })
    ).status,
  ).toBe(200);
  expect(await (await request("GET")).json()).toEqual({
    members: [{ userId: "member", email: "member@example.com", role: "admin" }],
  });
  const page = await request("GET", { headers: { accept: "text/html" } });
  expect(await page.text()).toContain("Server access");
  expect((await request("DELETE", { query: "?userId=member" })).status).toBe(
    200,
  );
  expect(await (await request("GET")).json()).toEqual({ members: [] });
  expect(
    await db
      .prepare("SELECT user_id FROM server WHERE id='srv'")
      .first("user_id"),
  ).toBe("owner");
});

it("rejects nonowners even when they are gate admins and rejects cross-origin owner mutations", async () => {
  await request("POST", {
    body: { email: "member@example.com", role: "admin" },
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(sessionToken),
  );
  const cookie = encodeURIComponent(
    `${sessionToken}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
  );
  const headers = {
    "x-bb-connect-machine": "",
    cookie: `__Secure-better-auth.session_token=${cookie}`,
  };
  for (const method of ["GET", "POST", "DELETE"])
    expect(
      (
        await request(method, {
          headers,
          query: "?userId=member",
          body:
            method === "POST"
              ? { email: "outsider@example.com", role: "member" }
              : undefined,
        })
      ).status,
    ).toBe(403);
  expect(
    (
      await request("POST", {
        headers: { origin: "https://another.getbb.app" },
        body: { email: "outsider@example.com", role: "member" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("POST", {
        body: { email: "owner@example.com", role: "member" },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request("POST", {
        body: { email: "missing@example.com", role: "member" },
      })
    ).status,
  ).toBe(404);
});

it("binds a server credential to its own server even when the owner has another server", async () => {
  await db
    .prepare(
      "INSERT INTO server (id,user_id,name,subdomain,credential_hash,created_at) VALUES ('srv-other','owner','other','other',?,1)",
    )
    .bind("other-hash")
    .run();
  expect(
    (
      await request("POST", {
        query: "?serverId=srv-other",
        body: { email: "outsider@example.com", role: "member" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await request("GET", { query: "?serverId=srv-other" })).status,
  ).toBe(403);
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM server_members")
      .first("n"),
  ).toBe(0);
  expect(
    (
      await request("POST", {
        query: "?serverId=srv",
        body: { email: "member@example.com", role: "member" },
      })
    ).status,
  ).toBe(200);
});

it("forwards a signed member identity over a real tunnel authenticated by its handshake", async () => {
  expect(
    (
      await request("POST", {
        body: { email: "member@example.com", role: "member" },
      })
    ).status,
  ).toBe(200);
  const dial = await mf.dispatchFetch("https://shared.getbb.app/__tunnel?v=1", {
    headers: {
      host: "shared.getbb.app",
      "x-bb-cloud-dev-host": "shared",
      upgrade: "websocket",
      authorization: `Bearer ${credential}`,
    },
  });
  const tunnel = dial.webSocket;
  if (tunnel === null)
    throw new Error(
      `Tunnel handshake failed: ${dial.status} ${await dial.text()}`,
    );
  tunnel.accept();
  const cookie = encodeURIComponent(
    `${sessionToken}.${createHmac("sha256", "test-secret").update(sessionToken).digest("base64")}`,
  );
  let identityToken: string | null = null;
  tunnel.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    const frame = decodeFrame(event.data);
    if (frame.type !== "open-http") return;
    identityToken =
      frame.headers.find(([name]) => name === GATE_IDENTITY_HEADER)?.[1] ??
      null;
    tunnel.send(
      new Uint8Array(
        encodeFrame({
          type: "resp-head",
          streamId: frame.streamId,
          status: 200,
          headers: [],
        }),
      ),
    );
    tunnel.send(
      new Uint8Array(
        encodeFrame({ type: "body-end", streamId: frame.streamId }),
      ),
    );
  });
  try {
    const response = await mf.dispatchFetch(
      "https://shared.getbb.app/api/v1/projects",
      {
        headers: {
          host: "shared.getbb.app",
          "x-bb-cloud-dev-host": "shared",
          cookie: `better-auth.session_token=${cookie}`,
          [GATE_IDENTITY_HEADER]: "client-forgery",
        },
      },
    );
    expect(response.status, await response.text()).toBe(200);
    if (identityToken === null) throw new Error("Missing signed gate identity");
    const [payload, signature] = String(identityToken).split(".");
    expect(signature).toBe(
      createHmac("sha256", credential)
        .update(`bb-connect-identity.v1.${payload}`)
        .digest("base64url"),
    );
    expect(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    ).toMatchObject({
      userId: "member",
      email: "member@example.com",
      serverId: "srv",
    });
  } finally {
    tunnel.close();
  }
});
