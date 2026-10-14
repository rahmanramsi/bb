import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { issueThreadShellToken } from "../../src/services/user-auth.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function signUp(
  harness: TestAppHarness,
  body: Record<string, string>,
): Promise<{ cookie: string; id: string }> {
  const response = await harness.app.request("/api/v1/auth/sign-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const { user } = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await response.json());
  return { cookie: cookieHeader(response), id: user.id };
}

async function bootstrapTeam(harness: TestAppHarness) {
  const admin = await signUp(harness, {
    email: "alice@example.test",
    name: "Alice",
    password: "correct horse battery",
  });
  const invite = await harness.app.request("/api/v1/auth/invites", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ role: "member" }),
  });
  const { token } = z.object({ token: z.string() }).parse(await invite.json());
  const member = await signUp(harness, {
    email: "bob@example.test",
    inviteToken: token,
    name: "Bob",
    password: "bob long enough password",
  });
  return { admin, member };
}

async function session(
  harness: TestAppHarness,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await harness.app.request("/api/v1/auth/session", {
    headers,
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("the auth session reports the caller's effective role", () => {
  it("reports the local owner as an uncapped admin in local mode", async () => {
    await withTestHarness(async (harness) => {
      expect(await session(harness)).toEqual({
        authMode: "local",
        needsBootstrap: false,
        principalKind: "local",
        user: {
          id: "usr_local_owner",
          name: "Local owner",
          email: "local-owner@bb.internal",
          role: "admin",
        },
        effectiveRole: "admin",
        roleCeiling: null,
      });
    });
  });

  it("reports each signed-in user with only their own identity and role", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin, member } = await bootstrapTeam(harness);

      expect(await session(harness, { cookie: member.cookie })).toMatchObject({
        user: { id: member.id, name: "Bob", role: "member" },
        effectiveRole: "member",
        roleCeiling: null,
      });
      expect(await session(harness, { cookie: admin.cookie })).toMatchObject({
        user: { id: admin.id, name: "Alice", role: "admin" },
        effectiveRole: "admin",
        roleCeiling: null,
      });
      expect(await session(harness)).toEqual({
        authMode: "multi",
        needsBootstrap: false,
        principalKind: null,
        user: null,
        effectiveRole: null,
        roleCeiling: null,
      });
    });
  });

  it("reports a member-capped admin credential as acting with member rights", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin } = await bootstrapTeam(harness);
      const capped = await issueThreadShellToken(harness.deps.config.dataDir, {
        userId: admin.id,
        roleCeiling: "member",
      });

      expect(
        await session(harness, { authorization: `Bearer ${capped}` }),
      ).toMatchObject({
        user: { id: admin.id, role: "admin" },
        effectiveRole: "member",
        roleCeiling: "member",
      });
    });
  });

  it("broadcasts a users change when a role changes so clients refetch who they are", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin, member } = await bootstrapTeam(harness);
      const notifySystem = vi.spyOn(harness.hub, "notifySystem");

      const response = await harness.app.request(
        `/api/v1/users/${member.id}/role`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: admin.cookie },
          body: JSON.stringify({ role: "admin" }),
        },
      );

      expect(response.status).toBe(200);
      expect(notifySystem).toHaveBeenCalledWith(["users-changed"]);
      expect(await session(harness, { cookie: member.cookie })).toMatchObject({
        user: { id: member.id, role: "admin" },
        effectiveRole: "admin",
      });
    });
  });
});
