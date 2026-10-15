import {
  createPromptHistoryEntry,
  createThreadSection,
  getThread,
  getProject,
  listProjectMemberUserIds,
  pinThread,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { projectAccessScopeFor } from "../../src/services/projects/project-access.js";
import { onClientSocketOpen } from "../../src/ws/client-protocol.js";
import { readJson } from "../helpers/json.js";
import {
  seedHost,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
  seedThreadFixture,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface Member {
  cookie: string;
  id: string;
}

interface Team {
  admin: Member;
  bob: Member;
  carol: Member;
}

interface ProjectView {
  id: string;
  name: string;
  ownerUserId: string | null;
  viewerCanManage: boolean;
  visibility: "public" | "private";
}

interface MembersView {
  members: Array<{ userId: string; email: string; name: string }>;
  owner: { userId: string } | null;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function signUp(
  harness: TestAppHarness,
  body: Record<string, string>,
): Promise<Member> {
  const response = await harness.app.request("/api/v1/auth/sign-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const { user } = (await response.json()) as { user: { id: string } };
  return { cookie: cookieHeader(response), id: user.id };
}

async function invite(harness: TestAppHarness, admin: Member) {
  const response = await harness.app.request("/api/v1/auth/invites", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function bootstrapTeam(harness: TestAppHarness): Promise<Team> {
  const admin = await signUp(harness, {
    email: "admin@example.test",
    name: "Admin",
    password: "correct horse battery",
  });
  const bob = await signUp(harness, {
    email: "bob@example.test",
    inviteToken: await invite(harness, admin),
    name: "Bob",
    password: "another long password",
  });
  const carol = await signUp(harness, {
    email: "carol@example.test",
    inviteToken: await invite(harness, admin),
    name: "Carol",
    password: "yet another password",
  });
  return { admin, bob, carol };
}

function request(
  harness: TestAppHarness,
  member: Member,
  path: string,
  init: { body?: unknown; method?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    harness.app.request(path, {
      method: init.method ?? "GET",
      headers: {
        cookie: member.cookie,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

async function json<T>(response: Promise<Response>): Promise<T> {
  const resolved = await response;
  expect(resolved.status).toBeLessThan(300);
  return (await readJson(resolved)) as T;
}

async function expectStatus(
  response: Promise<Response>,
  status: number,
  code?: string,
): Promise<void> {
  const resolved = await response;
  expect(resolved.status).toBe(status);
  if (code !== undefined) {
    expect(((await readJson(resolved)) as { code: string }).code).toBe(code);
  }
}

async function createProject(
  harness: TestAppHarness,
  member: Member,
  body: Record<string, unknown>,
): Promise<ProjectView> {
  const host = seedHost(harness.deps, { id: `host-${crypto.randomUUID()}` });
  seedPrimaryHost(harness.deps, host.id);
  const response = await request(harness, member, "/api/v1/projects", {
    method: "POST",
    body: {
      name: "Private work",
      source: { type: "local_path", hostId: host.id, path: "/tmp/private" },
      ...body,
    },
  });
  expect(response.status).toBe(201);
  return (await readJson(response)) as ProjectView;
}

async function listProjectIds(
  harness: TestAppHarness,
  member: Member,
  query = "",
): Promise<string[]> {
  return (
    await json<ProjectView[]>(
      request(harness, member, `/api/v1/projects${query}`),
    )
  ).map((project) => project.id);
}

function seedPrivateProjectThread(
  harness: TestAppHarness,
  ownerUserId: string,
) {
  const fixture = seedThreadFixture(harness, {
    thread: { title: "Quarterly roadmap secrets" },
  });
  harness.db.$client
    .prepare(
      "UPDATE projects SET visibility = 'private', owner_user_id = ? WHERE id = ?",
    )
    .run(ownerUserId, fixture.project.id);
  return fixture;
}

describe("project visibility and members", () => {
  it("creates owned private projects with members and filters lists by visibility", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin, bob, carol } = await bootstrapTeam(harness);
      const publicProject = seedThreadFixture(harness).project;
      const created = await createProject(harness, bob, {
        visibility: "private",
        memberUserIds: [carol.id, bob.id],
      });
      expect(created).toMatchObject({
        visibility: "private",
        ownerUserId: bob.id,
        viewerCanManage: true,
      });
      expect(listProjectMemberUserIds(harness.db, created.id)).toEqual([
        carol.id,
      ]);

      const outsider = await signUp(harness, {
        email: "dave@example.test",
        inviteToken: await invite(harness, admin),
        name: "Dave",
        password: "dave has a password",
      });
      expect(await listProjectIds(harness, outsider)).toEqual([
        publicProject.id,
      ]);
      expect(await listProjectIds(harness, carol)).toEqual([
        publicProject.id,
        created.id,
      ]);
      expect(await listProjectIds(harness, admin)).toContain(created.id);
      expect(await listProjectIds(harness, bob, "?visibility=private")).toEqual(
        [created.id],
      );
      expect(await listProjectIds(harness, bob, "?visibility=public")).toEqual([
        publicProject.id,
      ]);
      expect(
        await listProjectIds(
          harness,
          bob,
          "?visibility=private&includePersonal=true",
        ),
      ).toEqual([created.id]);
      await expectStatus(
        request(harness, bob, "/api/v1/projects?visibility=secret"),
        400,
      );

      const carolView = await json<ProjectView>(
        request(harness, carol, `/api/v1/projects/${created.id}`),
      );
      expect(carolView.viewerCanManage).toBe(false);
      const adminView = await json<ProjectView>(
        request(harness, admin, `/api/v1/projects/${created.id}`),
      );
      expect(adminView.viewerCanManage).toBe(true);

      const bootstrap = (member: Member, query = "") =>
        json<{ projects: Array<{ id: string }> }>(
          request(harness, member, `/api/v1/sidebar-bootstrap${query}`),
        );
      expect((await bootstrap(outsider)).projects.map((p) => p.id)).toEqual([
        publicProject.id,
      ]);
      expect(
        (await bootstrap(carol, "?visibility=private")).projects.map(
          (p) => p.id,
        ),
      ).toEqual([created.id]);
    });
  });

  it("hides private projects and their threads from users without access", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin, bob, carol } = await bootstrapTeam(harness);
      const { project, thread, environment } = seedPrivateProjectThread(
        harness,
        bob.id,
      );
      const hiddenPaths = [
        `/api/v1/projects/${project.id}`,
        `/api/v1/projects/${project.id}/members`,
        `/api/v1/projects/${project.id}/prompt-history`,
        `/api/v1/threads/${thread.id}`,
        `/api/v1/threads/${thread.id}/timeline`,
        `/api/v1/environments/${environment.id}`,
        `/api/v1/threads?projectId=${project.id}`,
      ];
      for (const path of hiddenPaths) {
        const response = await request(harness, carol, path);
        expect(response.status, path).toBe(404);
      }
      await expectStatus(
        request(harness, carol, `/api/v1/projects/${project.id}`),
        404,
        "project_not_found",
      );
      await expectStatus(
        request(harness, carol, `/api/v1/threads/${thread.id}`),
        404,
        "thread_not_found",
      );
      await expectStatus(
        request(harness, carol, "/api/v1/threads", {
          method: "POST",
          body: {
            origin: "app",
            projectId: project.id,
            providerId: "codex",
            input: [{ type: "text", text: "Sneak in", mentions: [] }],
            sendAt: Date.now() + 600_000,
            environment: { type: "reuse", environmentId: environment.id },
          },
        }),
        404,
      );

      const threadIds = async (member: Member, path: string) =>
        (await json<Array<{ id: string }>>(request(harness, member, path))).map(
          (entry) => entry.id,
        );
      expect(await threadIds(carol, "/api/v1/threads")).toEqual([]);
      expect(await threadIds(carol, "/api/v1/threads?archived=true")).toEqual(
        [],
      );
      expect(await threadIds(bob, "/api/v1/threads")).toEqual([thread.id]);
      expect(await threadIds(admin, "/api/v1/threads")).toEqual([thread.id]);

      const search = (member: Member) =>
        json<{ active: { total: number } }>(
          request(harness, member, "/api/v1/threads/search?query=roadmap"),
        );
      expect((await search(carol)).active.total).toBe(0);
      expect((await search(bob)).active.total).toBe(1);

      expect(
        await json<{ total: number }>(
          request(harness, carol, "/api/v1/threads/count"),
        ),
      ).toEqual({ total: 0 });
      expect(
        await json(
          request(harness, carol, "/api/v1/threads/resolve-mentions", {
            method: "POST",
            body: { threadIds: [thread.id] },
          }),
        ),
      ).toEqual([]);
      expect(
        (
          await json<Array<{ id: string }>>(
            request(harness, carol, "/api/v1/environments"),
          )
        ).map((entry) => entry.id),
      ).not.toContain(environment.id);
      expect(
        (
          await json<{ projects: Array<{ id: string }> }>(
            request(harness, carol, "/api/v1/sidebar-bootstrap"),
          )
        ).projects,
      ).toEqual([]);

      await json(
        request(
          harness,
          bob,
          `/api/v1/projects/${project.id}/members/${carol.id}`,
          {
            method: "PUT",
          },
        ),
      );
      expect(
        (
          await json<{ id: string }>(
            request(harness, carol, `/api/v1/threads/${thread.id}`),
          )
        ).id,
      ).toBe(thread.id);
      expect((await search(carol)).active.total).toBe(1);
    });
  });

  it("lets only the owner or an admin manage visibility and members", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin, bob, carol } = await bootstrapTeam(harness);
      const project = await createProject(harness, bob, {
        visibility: "private",
        memberUserIds: [carol.id],
      });
      const projectPath = `/api/v1/projects/${project.id}`;

      await expectStatus(
        request(harness, carol, projectPath, {
          method: "PATCH",
          body: { visibility: "public" },
        }),
        403,
        "project_manage_forbidden",
      );
      await expectStatus(
        request(harness, carol, projectPath, {
          method: "PATCH",
          body: { name: "Renamed by member" },
        }),
        403,
      );
      await expectStatus(
        request(harness, carol, `${projectPath}/members/${admin.id}`, {
          method: "PUT",
        }),
        403,
      );
      await expectStatus(
        request(harness, carol, projectPath, { method: "DELETE" }),
        403,
      );
      await expectStatus(
        request(harness, bob, `${projectPath}/members/usr_missing`, {
          method: "PUT",
        }),
        404,
        "user_not_found",
      );

      const afterOwnerAdd = await json<MembersView>(
        request(harness, bob, `${projectPath}/members/${bob.id}`, {
          method: "PUT",
        }),
      );
      expect(afterOwnerAdd.owner?.userId).toBe(bob.id);
      expect(afterOwnerAdd.members.map((member) => member.userId)).toEqual([
        carol.id,
      ]);

      const afterRemove = await json<MembersView>(
        request(harness, admin, `${projectPath}/members/${carol.id}`, {
          method: "DELETE",
        }),
      );
      expect(afterRemove.members).toEqual([]);
      await expectStatus(request(harness, carol, projectPath), 404);

      const updated = await json<ProjectView>(
        request(harness, bob, projectPath, {
          method: "PATCH",
          body: { visibility: "public" },
        }),
      );
      expect(updated.visibility).toBe("public");
      expect(
        await json<ProjectView>(request(harness, carol, projectPath)),
      ).toMatchObject({ visibility: "public", viewerCanManage: false });

      await expectStatus(
        request(harness, admin, "/api/v1/projects/proj_personal", {
          method: "PATCH",
          body: { visibility: "private" },
        }),
        404,
      );
    });
  });

  it("blocks indirect routes into private projects", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { bob, carol } = await bootstrapTeam(harness);
      const hidden = seedPrivateProjectThread(harness, bob.id);
      harness.db.$client
        .prepare("UPDATE threads SET status = 'active' WHERE id = ?")
        .run(hidden.thread.id);
      const { project: openProject } = seedProjectWithSource(harness.deps, {
        hostId: hidden.host.id,
        name: "Open project",
        path: "/tmp/open-project",
      });
      const openThread = seedThread(harness.deps, {
        projectId: openProject.id,
        title: "Open parent",
      });

      const plainText = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { cookie: carol.cookie, "content-type": "text/plain" },
        body: JSON.stringify({ projectId: hidden.project.id }),
      });
      expect(plainText.status).toBe(404);

      await expectStatus(
        request(harness, carol, `/api/v1/threads/${openThread.id}/messages`, {
          method: "POST",
          body: {
            input: [
              {
                type: "localFile",
                path: "attachments/secret.txt",
                sourceProjectId: hidden.project.id,
              },
            ],
          },
        }),
        404,
        "project_not_found",
      );
      await expectStatus(
        request(harness, carol, "/api/v1/plugins/any-plugin/rpc/list", {
          method: "POST",
          body: { threadId: hidden.thread.id },
        }),
        404,
        "thread_not_found",
      );
      await expectStatus(
        request(
          harness,
          carol,
          `/api/v1/hosts/${hidden.host.id}/clone-default-path?projectId=${hidden.project.id}`,
        ),
        404,
        "project_not_found",
      );
      for (const path of [
        "/tmp/test-project/secret.txt",
        "/tmp/test-environment",
      ]) {
        await expectStatus(
          request(harness, carol, "/api/v1/files/read", {
            method: "POST",
            body: { hostId: hidden.host.id, path },
          }),
          404,
          "ENOENT",
        );
      }
      await expectStatus(
        request(harness, carol, "/api/v1/files/read", {
          method: "POST",
          body: {
            hostId: hidden.host.id,
            rootPath: "/tmp",
            path: "test-project/secret.txt",
          },
        }),
        404,
        "ENOENT",
      );

      const runningIds = async (member: Member) =>
        (
          await json<Array<{ id: string }>>(
            request(harness, member, "/api/v1/threads/running"),
          )
        ).map((entry) => entry.id);
      expect(await runningIds(carol)).toEqual([]);
      expect(await runningIds(bob)).toEqual([hidden.thread.id]);

      createPromptHistoryEntry(harness.db, {
        input: [
          { type: "text", text: "remember the launch codes", mentions: [] },
        ],
        projectId: hidden.project.id,
        requestSequence: 1,
        scope: "thread",
        threadId: hidden.thread.id,
        userId: carol.id,
      });
      expect(
        (
          await json<{ entries: unknown[] }>(
            request(harness, carol, "/api/v1/prompt-history"),
          )
        ).entries,
      ).toEqual([]);

      const section = createThreadSection(harness.db, harness.deps.hub, {
        name: "Secret section",
      });
      if (section.status !== "created") {
        throw new Error("section was not created");
      }
      harness.db.$client
        .prepare("UPDATE threads SET section_id = ? WHERE id = ?")
        .run(section.section.id, hidden.thread.id);
      const sectionNames = async (member: Member) =>
        (
          await json<Array<{ name: string }>>(
            request(harness, member, "/api/v1/thread-sections"),
          )
        ).map((entry) => entry.name);
      expect(await sectionNames(carol)).toEqual([]);
      expect(await sectionNames(bob)).toEqual(["Secret section"]);
      await expectStatus(
        request(harness, carol, "/api/v1/thread-sections", {
          method: "DELETE",
          body: { id: section.section.id },
        }),
        404,
        "section_not_found",
      );
      harness.db.$client
        .prepare("UPDATE threads SET section_id = ? WHERE id = ?")
        .run(section.section.id, openThread.id);
      expect(await sectionNames(carol)).toEqual(["Secret section"]);
      await expectStatus(
        request(harness, carol, "/api/v1/thread-sections", {
          method: "PATCH",
          body: { id: section.section.id, name: "Renamed" },
        }),
        409,
        "section_in_use",
      );

      for (const threadId of [hidden.thread.id, openThread.id]) {
        pinThread(harness.db, harness.deps.hub, { threadId, userId: carol.id });
      }
      const pinned = await json<Array<{ id: string }>>(
        request(harness, carol, `/api/v1/threads/${openThread.id}/pin-order`, {
          method: "PATCH",
          body: { previousThreadId: null, nextThreadId: null },
        }),
      );
      expect(pinned.map((entry) => entry.id)).toEqual([openThread.id]);

      const hiddenChild = seedThread(harness.deps, {
        projectId: hidden.project.id,
        parentThreadId: openThread.id,
        title: "Hidden child",
      });
      await expectStatus(
        request(
          harness,
          carol,
          `/api/v1/threads/${openThread.id}/archive-all`,
          {
            method: "POST",
          },
        ),
        409,
      );
      expect(getThread(harness.db, hiddenChild.id)?.archivedAt).toBeNull();
      expect(getThread(harness.db, openThread.id)?.archivedAt).toBeNull();
    });
  });

  it("refuses to reuse a registered folder with different access settings", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { bob, carol } = await bootstrapTeam(harness);
      const host = seedHost(harness.deps, { id: "host-shared-folder" });
      seedPrimaryHost(harness.deps, host.id);
      const create = (member: Member, body: Record<string, unknown>) =>
        request(harness, member, "/api/v1/projects", {
          method: "POST",
          body: {
            name: "Shared folder",
            source: {
              type: "local_path",
              hostId: host.id,
              path: "/tmp/shared",
            },
            ...body,
          },
        });
      const original = await json<ProjectView>(create(bob, {}));
      await expectStatus(
        create(carol, { visibility: "private" }),
        409,
        "project_access_conflict",
      );
      await expectStatus(
        create(carol, { memberUserIds: [carol.id] }),
        409,
        "project_access_conflict",
      );
      expect(
        (await json<ProjectView>(create(carol, { visibility: "public" }))).id,
      ).toBe(original.id);
      expect(getProject(harness.db, original.id)).toMatchObject({
        ownerUserId: bob.id,
        visibility: "public",
      });
    });
  });

  it("sends private project realtime changes only to users with access", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin, bob, carol } = await bootstrapTeam(harness);
      const { project, thread } = seedPrivateProjectThread(harness, bob.id);
      const received = new Map<string, string[]>();
      const connect = (
        name: string,
        member: Member,
        role: "admin" | "member",
      ) => {
        const socket = {
          close() {},
          send(data: string) {
            received.set(name, [...(received.get(name) ?? []), data]);
          },
        };
        onClientSocketOpen(
          harness.deps.hub,
          socket,
          member.id,
          projectAccessScopeFor({
            delegatedPluginId: null,
            grantId: null,
            kind: "user",
            role,
            roleCeiling: null,
            userId: member.id,
          }),
        );
        harness.deps.hub.subscribe(socket, { kind: "project-list" });
        harness.deps.hub.subscribe(socket, { kind: "thread-list" });
      };
      connect("admin", admin, "admin");
      connect("bob", bob, "member");
      connect("carol", carol, "member");

      harness.deps.hub.notifyProject(project.id, ["project-updated"]);
      harness.deps.hub.notifyThread(thread.id, ["status-changed"]);
      expect(received.get("admin")).toHaveLength(2);
      expect(received.get("bob")).toHaveLength(2);
      expect(received.get("carol")).toBeUndefined();

      let accessChanges = 0;
      harness.deps.hub.onProjectAccessChanged(() => {
        accessChanges += 1;
      });
      harness.deps.hub.notifyProjectAccessChanged(project.id);
      expect(received.get("carol")).toBeUndefined();
      expect(received.get("bob")).toHaveLength(3);
      harness.deps.hub.notifyProjectAccessChanged(project.id, [carol.id]);
      expect(received.get("carol")).toHaveLength(1);
      harness.deps.hub.notifyProjectAccessChanged(project.id, "everyone");
      expect(received.get("carol")).toHaveLength(2);
      expect(accessChanges).toBe(3);
    });
  });

  it("keeps owned projects and drops memberships when a user is removed", async () => {
    await withTestHarness({ authMode: "multi" }, async (harness) => {
      const { admin, bob, carol } = await bootstrapTeam(harness);
      const owned = await createProject(harness, bob, {
        visibility: "private",
        memberUserIds: [carol.id],
      });
      const shared = await createProject(harness, admin, {
        visibility: "private",
        memberUserIds: [bob.id],
      });

      await json(
        request(harness, admin, `/api/v1/users/${bob.id}`, {
          method: "DELETE",
        }),
      );

      expect(getProject(harness.db, owned.id)).toMatchObject({
        ownerUserId: null,
        visibility: "private",
      });
      expect(listProjectMemberUserIds(harness.db, owned.id)).toEqual([
        carol.id,
      ]);
      expect(listProjectMemberUserIds(harness.db, shared.id)).toEqual([]);
      expect(await listProjectIds(harness, carol)).toContain(owned.id);
      expect(
        await json<ProjectView>(
          request(harness, admin, `/api/v1/projects/${owned.id}`),
        ),
      ).toMatchObject({ ownerUserId: null, viewerCanManage: true });
    });
  });

  it("leaves local mode unrestricted", async () => {
    await withTestHarness(async (harness) => {
      const { project, thread } = seedThreadFixture(harness);
      harness.db.$client
        .prepare("UPDATE projects SET visibility = 'private' WHERE id = ?")
        .run(project.id);
      const projects = (await readJson(
        await harness.app.request("/api/v1/projects"),
      )) as ProjectView[];
      expect(projects).toEqual([
        expect.objectContaining({
          id: project.id,
          visibility: "private",
          ownerUserId: null,
          viewerCanManage: true,
        }),
      ]);
      expect(
        (await harness.app.request(`/api/v1/threads/${thread.id}`)).status,
      ).toBe(200);
      const created = (await readJson(
        await harness.app.request("/api/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Local project",
            source: {
              type: "local_path",
              hostId: seedLocalHost(harness),
              path: "/tmp/local-project",
            },
          }),
        }),
      )) as ProjectView;
      expect(created).toMatchObject({
        visibility: "public",
        ownerUserId: null,
      });
    });
  });
});

function seedLocalHost(harness: TestAppHarness): string {
  const host = seedHost(harness.deps, { id: "host-local-visibility" });
  seedPrimaryHost(harness.deps, host.id);
  return host.id;
}
