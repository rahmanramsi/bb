import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerLoginCommand,
  registerLogoutCommand,
  registerWhoamiCommand,
  registerInviteCommands,
  registerTokenCommands,
} from "../commands/auth.js";
import { registerUserCommands } from "../commands/user.js";
import { cliFetch } from "../client.js";
import { resolveCliAuthToken } from "../auth-store.js";

let dataDir: string;
const requests: Request[] = [];
const user = {
  id: "u",
  name: "User",
  email: "user@example.test",
  role: "admin",
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "bb-cli-auth-"));
  vi.stubEnv("BB_DATA_DIR", dataDir);
  vi.stubEnv("BB_TOKEN", undefined);
  requests.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/auth/session"))
        return Response.json({ authMode: "multi" });
      if (request.url.endsWith("/me"))
        return Response.json({
          user,
          effectiveRole: "member",
          roleCeiling: "member",
        });
      if (
        request.url.endsWith("/users") ||
        request.url.endsWith("/users/directory")
      )
        return Response.json({ users: [user] });
      return Response.json({
        user,
        ok: true,
        tokens: [],
        invites: [],
        token: "bbpat_created",
        summary: { id: "pat", name: "CLI" },
      });
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  const getUrl = () => "http://server";
  registerLoginCommand(program, getUrl);
  registerLogoutCommand(program, getUrl);
  registerWhoamiCommand(program, getUrl);
  registerInviteCommands(program, getUrl);
  registerTokenCommands(program, getUrl);
  registerUserCommands(program, getUrl);
  await program.parseAsync(["node", "bb", ...args]);
}

describe("CLI authentication", () => {
  it("saves a validated PAT per origin, preserves host settings, prefers BB_TOKEN, and logs out only that profile", async () => {
    await writeFile(
      join(dataDir, "client.json"),
      JSON.stringify({
        servers: {
          "http://server": { hosts: { host: { sshAuthority: "devbox" } } },
          "http://other": { authToken: "bbpat_other", hosts: {} },
        },
      }),
    );
    await run(["login", "--token", "bbpat_saved", "--json"]);
    expect(requests[0].headers.get("authorization")).toBe("Bearer bbpat_saved");
    expect((await stat(join(dataDir, "client.json"))).mode & 0o777).toBe(0o600);
    expect(resolveCliAuthToken("http://server/a")).toBe("bbpat_saved");
    await run(["whoami", "--json"]);
    expect(requests.at(-1)?.headers.get("authorization")).toBe(
      "Bearer bbpat_saved",
    );
    vi.stubEnv("BB_TOKEN", "bbshell_injected");
    await cliFetch("http://server/api/v1/plugins");
    expect(requests.at(-1)?.headers.get("authorization")).toBe(
      "Bearer bbshell_injected",
    );
    await run(["logout", "--json"]);
    vi.stubEnv("BB_TOKEN", undefined);
    expect(resolveCliAuthToken("http://server")).toBeUndefined();
    const stored = JSON.parse(
      await readFile(join(dataDir, "client.json"), "utf8"),
    );
    expect(stored.servers["http://server"].hosts.host.sshAuthority).toBe(
      "devbox",
    );
    expect(stored.servers["http://other"].authToken).toBe("bbpat_other");
  });

  it("shows the effective role of a capped credential and keeps login output to the user", async () => {
    const log = vi.mocked(console.log);
    await run(["whoami"]);
    expect(log).toHaveBeenLastCalledWith(
      "u  user@example.test  member (credential capped at member; account role admin)",
    );
    await run(["login", "--token", "bbpat_saved", "--json"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ user });
  });

  it.each([
    { argv: ["user", "list"], method: "GET", path: "/users", body: null },
    {
      argv: ["user", "role", "u", "member"],
      method: "PUT",
      path: "/users/u/role",
      body: { role: "member" },
    },
    {
      argv: ["user", "remove", "u"],
      method: "DELETE",
      path: "/users/u",
      body: null,
    },
    {
      argv: [
        "invite",
        "create",
        "--role",
        "admin",
        "--email",
        "new@example.test",
      ],
      method: "POST",
      path: "/auth/invites",
      body: { role: "admin", email: "new@example.test" },
    },
    {
      argv: ["user", "grants", "list", "u2"],
      method: "GET",
      path: "/users/u2/plugin-grants",
      body: null,
    },
    {
      argv: ["user", "grants", "revoke", "grant_1", "--user", "u2"],
      method: "DELETE",
      path: "/users/u2/plugin-grants/grant_1",
      body: null,
    },
    {
      argv: ["invite", "list"],
      method: "GET",
      path: "/auth/invites",
      body: null,
    },
    {
      argv: ["invite", "revoke", "i"],
      method: "DELETE",
      path: "/auth/invites/i",
      body: null,
    },
    {
      argv: ["token", "create", "Automation"],
      method: "POST",
      path: "/auth/tokens",
      body: { name: "Automation" },
    },
    {
      argv: ["token", "list"],
      method: "GET",
      path: "/auth/tokens",
      body: null,
    },
    {
      argv: ["token", "revoke", "t"],
      method: "DELETE",
      path: "/auth/tokens/t",
      body: null,
    },
  ])(
    "parses $argv and sends the authenticated request",
    async ({ argv, method, path, body }) => {
      vi.stubEnv("BB_TOKEN", "bbpat_env");
      await run([...argv, "--json"]);
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe(method);
      expect(requests[0].url).toBe(`http://server/api/v1${path}`);
      expect(requests[0].headers.get("authorization")).toBe("Bearer bbpat_env");
      if (body !== null) expect(await requests[0].json()).toEqual(body);
    },
  );

  it("lists and revokes the signed-in user's plugin grants by default", async () => {
    vi.stubEnv("BB_TOKEN", "bbpat_env");
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/me")) {
        return Response.json({
          user,
          effectiveRole: "admin",
          roleCeiling: null,
        });
      }
      if (request.method === "DELETE") return Response.json({ ok: true });
      return Response.json({
        grants: [
          {
            id: "grant_1",
            pluginId: "automations",
            userId: "u",
            maxRole: "member",
            purpose: 'Automation "Nightly"',
            createdAt: 1,
            expiresAt: null,
          },
          {
            id: "grant_2",
            pluginId: "automations",
            userId: "u",
            maxRole: "member",
            purpose: 'Automation "Weekly"',
            createdAt: 1,
            expiresAt: Date.parse("2001-02-03T00:00:00.000Z"),
          },
        ],
      });
    });
    const log = vi.mocked(console.log);

    await run(["user", "grants", "list"]);
    expect(requests.map((request) => request.url)).toEqual([
      "http://server/api/v1/me",
      "http://server/api/v1/users/u/plugin-grants",
    ]);
    const table = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(table).toContain("grant_1");
    expect(table).toContain('Automation "Nightly"');
    expect(table).toContain("never");
    expect(table).toContain("expired 2001-02-03T00:00:00.000Z");

    requests.length = 0;
    await run(["user", "grants", "revoke", "grant_1"]);
    expect(
      requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual([
      "GET http://server/api/v1/me",
      "DELETE http://server/api/v1/users/u/plugin-grants/grant_1",
    ]);
    expect(log).toHaveBeenLastCalledWith("Revoked grant_1");
  });

  it("creates a PAT using the sign-in cookie and clears the temporary session", async () => {
    const passwordFile = join(dataDir, "password");
    await writeFile(passwordFile, "a long account password\n");
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/auth/sign-in"))
        return Response.json(
          { user },
          {
            headers: {
              "set-cookie": "bb.session_token=session; HttpOnly; Path=/",
            },
          },
        );
      if (request.url.endsWith("/auth/tokens"))
        return Response.json({ token: "bbpat_new", summary: { id: "pat" } });
      return Response.json({ user, ok: true });
    });
    await run([
      "login",
      "--email",
      user.email,
      "--password-file",
      passwordFile,
      "--json",
    ]);
    expect(await requests[0].json()).toEqual({
      email: user.email,
      password: "a long account password",
    });
    expect(requests[1].headers.get("cookie")).toBe("bb.session_token=session");
    expect(requests[2].url).toBe("http://server/api/v1/auth/sign-out");
    expect(requests[2].headers.get("cookie")).toBe("bb.session_token=session");
    expect(requests[3].headers.get("authorization")).toBe("Bearer bbpat_new");
    expect(resolveCliAuthToken("http://server")).toBe("bbpat_new");
  });

  it("accepts an invite without sending an existing account credential", async () => {
    vi.stubEnv("BB_TOKEN", "bbpat_existing");
    const passwordFile = join(dataDir, "password");
    await writeFile(passwordFile, "a long account password\n");
    await run([
      "invite",
      "accept",
      "bbinv_invited",
      "--email",
      user.email,
      "--name",
      user.name,
      "--password-file",
      passwordFile,
      "--json",
    ]);
    expect(requests[0].url).toBe("http://server/api/v1/auth/invites/accept");
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(await requests[0].json()).toEqual({
      inviteToken: "bbinv_invited",
      email: user.email,
      name: user.name,
      password: "a long account password",
    });
  });
});
