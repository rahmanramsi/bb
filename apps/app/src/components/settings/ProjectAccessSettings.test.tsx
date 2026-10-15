// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthSessionResponse,
  AuthUser,
  ProjectMembersResponse,
  ProjectResponse,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { AuthContext } from "@/hooks/useAuth";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeProjectResponse } from "@/test/fixtures/projects";
import { ProjectAccessSettings } from "./ProjectAccessSettings";

const owner: AuthUser = {
  id: "usr_owner",
  name: "Olivia",
  email: "olivia@example.com",
  role: "member",
};
const member: AuthUser = {
  id: "usr_member",
  name: "Sam",
  email: "sam@example.com",
  role: "member",
};
const outsider: AuthUser = {
  id: "usr_outsider",
  name: "Riley",
  email: "riley@example.com",
  role: "member",
};

function session(
  user: AuthUser,
  authMode: "multi" | "local" = "multi",
): AuthSessionResponse {
  return {
    user,
    authMode,
    needsBootstrap: false,
    principalKind: authMode === "local" ? "local" : "user",
  };
}

function membersResponse(members: readonly AuthUser[]): ProjectMembersResponse {
  return {
    owner: {
      userId: owner.id,
      name: owner.name,
      email: owner.email,
      addedAt: 0,
    },
    members: members.map((user) => ({
      userId: user.id,
      name: user.name,
      email: user.email,
      addedAt: 1,
    })),
  };
}

function privateProject(overrides: Partial<ProjectResponse> = {}) {
  return makeProjectResponse({
    id: "proj_secret",
    name: "Secret",
    visibility: "private",
    ownerUserId: owner.id,
    viewerCanManage: true,
    ...overrides,
  });
}

function mount(project: ProjectResponse, auth: AuthSessionResponse) {
  const { wrapper: QueryWrapper } = createQueryClientTestHarness();
  render(
    <QueryWrapper>
      <AuthContext.Provider value={auth}>
        <ProjectAccessSettings project={project} />
      </AuthContext.Provider>
    </QueryWrapper>,
  );
}

beforeEach(() => {
  vi.spyOn(sdk.experimental_users, "directory").mockResolvedValue({
    users: [owner, member, outsider],
  });
  vi.spyOn(sdk.projects.experimental_members, "list").mockResolvedValue(
    membersResponse([member]),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectAccessSettings", () => {
  it("renders nothing in single-user mode", () => {
    mount(privateProject(), session(owner, "local"));

    expect(screen.queryByText("Access")).toBeNull();
    expect(sdk.projects.experimental_members.list).not.toHaveBeenCalled();
  });

  it("shows the owner and members", async () => {
    mount(privateProject(), session(owner));

    expect(await screen.findByText("Sam")).toBeTruthy();
    expect(screen.getByText("olivia@example.com")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Project visibility" }).textContent,
    ).toContain("Private");
  });

  it("lets a manager switch visibility", async () => {
    const update = vi
      .spyOn(sdk.projects, "update")
      .mockResolvedValue(privateProject({ visibility: "public" }));
    mount(privateProject(), session(owner));

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Project visibility" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Public/u }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        projectId: "proj_secret",
        visibility: "public",
      }),
    );
  });

  it("adds a member from the user directory, skipping the owner and existing members", async () => {
    const add = vi
      .spyOn(sdk.projects.experimental_members, "add")
      .mockResolvedValue(membersResponse([member, outsider]));
    mount(privateProject(), session(owner));
    await screen.findByText("Sam");

    const trigger = screen.getByRole("button", { name: "Add member" });
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    fireEvent.pointerDown(trigger, { button: 0 });
    const options = await screen.findAllByRole("menuitem");
    expect(options.map((option) => option.textContent)).toEqual([
      "Rileyriley@example.com",
    ]);
    fireEvent.click(options[0]!);

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        projectId: "proj_secret",
        userId: outsider.id,
      }),
    );
    expect(await screen.findByText("Riley")).toBeTruthy();
  });

  it("removes a member", async () => {
    const remove = vi
      .spyOn(sdk.projects.experimental_members, "remove")
      .mockResolvedValue(membersResponse([]));
    mount(privateProject(), session(owner));

    fireEvent.click(await screen.findByRole("button", { name: "Remove Sam" }));

    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith({
        projectId: "proj_secret",
        userId: member.id,
      }),
    );
    expect(
      await screen.findByText("No members yet.", { exact: false }),
    ).toBeTruthy();
  });

  it("shows read-only access to users who cannot manage the project", async () => {
    mount(privateProject({ viewerCanManage: false }), session(member));

    expect(await screen.findByText("Sam")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Project visibility" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Sam" })).toBeNull();
    expect(
      screen.getByText("Only the project owner or an admin can change access."),
    ).toBeTruthy();
  });

  it("labels team projects without an owner", async () => {
    vi.mocked(sdk.projects.experimental_members.list).mockResolvedValue({
      owner: null,
      members: [],
    });
    mount(privateProject({ ownerUserId: null }), session(owner));

    expect(
      await screen.findByText("Team project, managed by admins"),
    ).toBeTruthy();
  });
});
