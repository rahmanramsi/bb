// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSessionResponse, AuthUser } from "@bb/server-contract";
import type { ReactNode } from "react";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { AuthContext } from "@/hooks/useAuth";
import { AccountSettings } from "@/components/settings/AccountSettings";
import { ThreadCreator } from "@/components/thread/ThreadCreator";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AUTHENTICATION_REQUIRED_EVENT } from "@/lib/app-surface";
import { AuthGate } from "./AuthGate";
import { UserMenu } from "./UserMenu";
import { AdminSettingsGate } from "./AdminSettingsGate";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { wsManager } from "@/lib/ws";

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
  useLocalHostDaemonAccess: () => ({ accessState: "unavailable" }),
}));

const admin: AuthUser = {
  id: "usr_admin",
  name: "Alex",
  email: "alex@example.com",
  role: "admin",
};
const member: AuthUser = {
  id: "usr_member",
  name: "Sam",
  email: "sam@example.com",
  role: "member",
};

function session(
  user: AuthUser | null,
  authMode: "multi" | "local" = "multi",
  needsBootstrap = false,
): AuthSessionResponse {
  return {
    user,
    authMode,
    needsBootstrap,
    principalKind:
      user === null ? null : authMode === "local" ? "local" : "user",
    effectiveRole: user?.role ?? null,
    roleCeiling: null,
  };
}

function mount(
  children: ReactNode,
  auth: AuthSessionResponse | null = null,
  path = "/",
) {
  const harness = createQueryClientTestHarness();
  const { wrapper: QueryWrapper } = harness;
  render(
    <QueryWrapper>
      <MemoryRouter initialEntries={[path]}>
        <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
      </MemoryRouter>
    </QueryWrapper>,
  );
  return harness;
}

beforeEach(() => {
  vi.spyOn(sdk.experimental_auth, "listTokens").mockResolvedValue({
    tokens: [],
  });
  vi.spyOn(sdk.experimental_auth, "listInvites").mockResolvedValue({
    invites: [],
  });
  vi.spyOn(sdk.experimental_users, "list").mockResolvedValue({
    users: [admin, member],
  });
  vi.spyOn(sdk.experimental_users, "listPluginGrants").mockResolvedValue({
    grants: [],
  });
  vi.spyOn(sdk.experimental_users, "directory").mockResolvedValue({
    users: [admin, member],
  });
  vi.spyOn(sdk.plugins, "list").mockResolvedValue({ plugins: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("authentication boundary", () => {
  it.each([
    { auth: session(admin, "local", true), heading: null, app: true },
    {
      auth: session(null, "multi", true),
      heading: "Create your admin account",
      app: false,
    },
    { auth: session(null), heading: "Sign in to bb", app: false },
    { auth: session(member), heading: null, app: true },
  ])(
    "renders the server's auth mode and bootstrap state: $auth.authMode, $auth.needsBootstrap",
    async ({ auth, heading, app }) => {
      vi.spyOn(sdk.experimental_auth, "session").mockResolvedValue(auth);
      mount(
        <AuthGate>
          <p>Shared projects</p>
        </AuthGate>,
      );
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
      expect(screen.queryByText("Shared projects") !== null).toBe(app);
      if (heading !== null)
        expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
      else expect(screen.queryByLabelText("Password")).toBeNull();
    },
  );

  it("keeps the app closed when checking authentication fails and retries", async () => {
    const check = vi
      .spyOn(sdk.experimental_auth, "session")
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(session(member));
    mount(
      <AuthGate>
        <p>Shared projects</p>
      </AuthGate>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Shared projects")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Shared projects")).toBeTruthy();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("returns to sign-in when a protected API reports an expired session", async () => {
    const disconnect = vi.spyOn(wsManager, "disconnect");
    const check = vi
      .spyOn(sdk.experimental_auth, "session")
      .mockResolvedValue(session(member));
    mount(
      <AuthGate>
        <p>Shared projects</p>
      </AuthGate>,
    );
    await screen.findByText("Shared projects");
    check.mockResolvedValue(session(null));
    window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
    expect(
      await screen.findByRole("heading", { name: "Sign in to bb" }),
    ).toBeTruthy();
    expect(screen.queryByText("Shared projects")).toBeNull();
    expect(disconnect).toHaveBeenCalled();
  });

  it("submits credentials and keeps sign-in errors recoverable", async () => {
    vi.spyOn(sdk.experimental_auth, "session").mockResolvedValue(session(null));
    const signIn = vi
      .spyOn(sdk.experimental_auth, "signIn")
      .mockRejectedValue(new Error("Invalid email or password"));
    mount(
      <AuthGate>
        <p>Shared projects</p>
      </AuthGate>,
    );
    await screen.findByLabelText("Email");
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: member.email },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Sign in" }).closest("form")!,
    );
    expect(await screen.findByText("Invalid email or password")).toBeTruthy();
    expect(signIn).toHaveBeenCalledWith({
      email: member.email,
      password: "wrong-password",
    });
    expect(screen.queryByText("Shared projects")).toBeNull();
  });

  it("uses the invite acceptance API with the link token", async () => {
    vi.spyOn(sdk.experimental_auth, "session").mockResolvedValue(session(null));
    const accept = vi
      .spyOn(sdk.experimental_auth, "acceptInvite")
      .mockRejectedValue(new Error("Invite expired"));
    mount(
      <AuthGate>
        <p>Shared projects</p>
      </AuthGate>,
      null,
      "/invite?token=inv_test",
    );
    await screen.findByLabelText("Name");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: member.name },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: member.email },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "test-password" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Create account" }).closest("form")!,
    );
    expect(await screen.findByText("Invite expired")).toBeTruthy();
    expect(accept).toHaveBeenCalledWith({
      name: member.name,
      email: member.email,
      password: "test-password",
      inviteToken: "inv_test",
    });
  });

  it("explains missing invite links without offering unusable registration", async () => {
    vi.spyOn(sdk.experimental_auth, "session").mockResolvedValue(session(null));
    mount(
      <AuthGate>
        <p>Shared projects</p>
      </AuthGate>,
      null,
      "/invite",
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "This invite link is missing its token. Ask an admin for a new link.",
    );
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });
});

describe("account visibility and actions", () => {
  it("opens the compact user menu after realizing its drawer without hiding the app root", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    mount(
      <CompactViewportOverrideProvider isCompactViewport>
        <main data-testid="app-root">
          <UserMenu />
        </main>
      </CompactViewportOverrideProvider>,
      session(member),
    );
    const root = screen.getByTestId("app-root");
    fireEvent.click(screen.getByRole("button", { name: "User menu for Sam" }));
    expect(
      document
        .querySelector("[data-persistent-drawer-content]")
        ?.getAttribute("data-state"),
    ).toBe("open");
    expect(screen.queryByText("Sign out")).toBeNull();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(root.getAttribute("aria-hidden")).toBeNull();
    act(() => frames.splice(0).forEach((frame) => frame(0)));
    expect(screen.queryByText("Sign out")).toBeNull();
    act(() => frames.splice(0).forEach((frame) => frame(16)));
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(root.getAttribute("aria-hidden")).toBeNull();
  });
  it.each([admin, member])(
    "shows personal tokens and limits administration for $role",
    async (user) => {
      mount(<AccountSettings />, session(user));
      expect(
        await screen.findByText("You have no personal access tokens."),
      ).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Users" }) !== null).toBe(
        user.role === "admin",
      );
      expect(screen.queryByRole("heading", { name: "Invites" }) !== null).toBe(
        user.role === "admin",
      );
      expect(sdk.experimental_users.list).toHaveBeenCalledTimes(
        user.role === "admin" ? 1 : 0,
      );
      expect(sdk.experimental_auth.listInvites).toHaveBeenCalledTimes(
        user.role === "admin" ? 1 : 0,
      );
    },
  );

  it("hides account controls in local mode", () => {
    mount(
      <>
        <AccountSettings />
        <UserMenu />
      </>,
      session(admin, "local"),
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(sdk.experimental_auth.listTokens).not.toHaveBeenCalled();
  });

  it.each([admin, member])(
    "filters settings navigation for $role",
    async (user) => {
      mount(
        <SidebarProvider>
          <SettingsSidebar isResizing={false} onResizeMouseDown={() => {}} />
        </SidebarProvider>,
        session(user),
        "/settings/account",
      );
      expect(screen.getByRole("link", { name: "Account" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Appearance" })).toBeTruthy();
      for (const name of [
        "General",
        "Providers",
        "Machines",
        "Environment variables",
        "Installed plugins",
      ]) {
        expect(screen.queryByRole("link", { name }) !== null).toBe(
          user.role === "admin",
        );
      }
    },
  );

  it("treats an admin acting through a member-capped credential as a member", () => {
    mount(
      <SidebarProvider>
        <SettingsSidebar isResizing={false} onResizeMouseDown={() => {}} />
      </SidebarProvider>,
      { ...session(admin), effectiveRole: "member", roleCeiling: "member" },
      "/settings/account",
    );
    expect(screen.getByRole("link", { name: "Appearance" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Machines" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Installed plugins" }),
    ).toBeNull();
  });

  it("blocks a member opening machine settings directly", async () => {
    mount(
      <Routes>
        <Route
          path="/settings/machines/host_1"
          element={
            <AdminSettingsGate>
              <p>Machine administration</p>
            </AdminSettingsGate>
          }
        />
        <Route
          path="/settings/appearance"
          element={<p>Appearance settings</p>}
        />
      </Routes>,
      session(member),
      "/settings/machines/host_1",
    );
    expect(await screen.findByText("Appearance settings")).toBeTruthy();
    expect(screen.queryByText("Machine administration")).toBeNull();
  });

  it("displays a newly created PAT once and removes the secret on Done", async () => {
    const create = vi
      .spyOn(sdk.experimental_auth, "createToken")
      .mockResolvedValue({
        token: "bbpat_test",
        summary: {
          id: "pat_1",
          name: "Laptop",
          start: "bbpat_",
          createdAt: 1,
          lastUsedAt: null,
        },
      });
    mount(<AccountSettings />, session(member));
    fireEvent.change(screen.getByLabelText("Token name"), {
      target: { value: "Laptop" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Create token" }).closest("form")!,
    );
    expect(
      await screen.findByLabelText("New personal access token"),
    ).toHaveProperty("value", "bbpat_test");
    expect(create).toHaveBeenCalledWith({ name: "Laptop" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("New personal access token")).toBeNull();
  });

  it("creates a shareable invite link with the selected role and email", async () => {
    const create = vi
      .spyOn(sdk.experimental_auth, "createInvite")
      .mockResolvedValue({
        id: "inv_1",
        token: "inv_test",
        role: "member",
        email: member.email,
        expiresAt: 1,
      });
    mount(<AccountSettings />, session(admin));
    fireEvent.change(screen.getByLabelText("Email (optional)"), {
      target: { value: member.email },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Create invite" }).closest("form")!,
    );
    const link = await screen.findByLabelText("New invite link");
    expect(link).toHaveProperty(
      "value",
      `${window.location.origin}/invite?token=inv_test`,
    );
    expect(create).toHaveBeenCalledWith({
      email: member.email,
      role: "member",
    });
  });

  it("does not revoke tokens before confirmation", async () => {
    vi.mocked(sdk.experimental_auth.listTokens).mockResolvedValue({
      tokens: [
        {
          id: "pat_1",
          name: "Laptop",
          start: "bbpat_",
          createdAt: 1,
          lastUsedAt: null,
        },
      ],
    });
    const revoke = vi
      .spyOn(sdk.experimental_auth, "revokeToken")
      .mockResolvedValue({ ok: true });
    mount(<AccountSettings />, session(member));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith({ id: "pat_1" }));
  });

  it("lists the signed-in user's plugin grants and revokes one after confirmation", async () => {
    vi.mocked(sdk.experimental_users.listPluginGrants).mockResolvedValue({
      grants: [
        {
          id: "grant_1",
          pluginId: "automations",
          userId: member.id,
          maxRole: "member",
          purpose: 'Automation "Nightly"',
          createdAt: 1,
          expiresAt: null,
        },
        {
          id: "grant_2",
          pluginId: "automations",
          userId: member.id,
          maxRole: "member",
          purpose: 'Automation "Weekly"',
          createdAt: 1,
          expiresAt: 2,
        },
      ],
    });
    const revoke = vi
      .spyOn(sdk.experimental_users, "revokePluginGrant")
      .mockResolvedValue({ ok: true });
    vi.mocked(sdk.experimental_auth.listTokens).mockResolvedValue({
      tokens: [],
    });
    mount(<AccountSettings />, session(member));

    expect(await screen.findByText('Automation "Nightly"')).toBeTruthy();
    expect(screen.getByText(/Never expires\./)).toBeTruthy();
    expect(screen.getByText(/Expired /)).toBeTruthy();
    expect(sdk.experimental_users.listPluginGrants).toHaveBeenCalledWith(
      expect.objectContaining({ userId: member.id }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith({
        userId: member.id,
        grantId: "grant_1",
      }),
    );
  });

  it("shows creators in multi mode, including a server with one account", async () => {
    vi.mocked(sdk.experimental_users.directory).mockResolvedValue({
      users: [member],
    });
    mount(<ThreadCreator userId={member.id} />, session(member));
    expect(await screen.findByText("by Sam")).toHaveProperty(
      "title",
      "Created by Sam",
    );
  });

  it("keeps local thread titles free of attribution", () => {
    mount(<ThreadCreator userId={admin.id} />, session(admin, "local"));
    expect(screen.queryByText("by Alex")).toBeNull();
    expect(sdk.experimental_users.directory).not.toHaveBeenCalled();
  });
});
