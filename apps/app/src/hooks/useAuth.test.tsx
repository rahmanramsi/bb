// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthSessionResponse, AuthUser } from "@bb/server-contract";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import {
  AuthContext,
  useActsAsMember,
  useCurrentUser,
  useUserStorageKey,
} from "./useAuth";

afterEach(cleanup);

const LOCAL_OWNER: AuthUser = {
  id: "usr_local_owner",
  name: "Local owner",
  email: "local-owner@bb.internal",
  role: "admin",
};
const ALEX: AuthUser = {
  id: "usr_alex",
  name: "Alex",
  email: "alex@example.com",
  role: "admin",
};
const SAM: AuthUser = {
  id: "usr_sam",
  name: "Sam",
  email: "sam@example.com",
  role: "member",
};

function multiSession(
  user: AuthUser | null,
  roleCeiling: "member" | null = null,
): AuthSessionResponse {
  return {
    authMode: "multi",
    needsBootstrap: false,
    principalKind: user === null ? null : "user",
    user,
    effectiveRole: user === null ? null : (roleCeiling ?? user.role),
    roleCeiling,
  };
}

const LOCAL_SESSION: AuthSessionResponse = {
  authMode: "local",
  needsBootstrap: false,
  principalKind: "local",
  user: LOCAL_OWNER,
  effectiveRole: "admin",
  roleCeiling: null,
};

function renderWithSession<T>(
  hook: () => T,
  initial: AuthSessionResponse | null,
) {
  let auth = initial;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
  );
  const view = renderHook(hook, { wrapper });
  return {
    ...view,
    setSession(next: AuthSessionResponse | null) {
      auth = next;
      view.rerender();
    },
  };
}

describe("useCurrentUser", () => {
  it("is the hook plugins receive as experimental_useCurrentUser", () => {
    expect(pluginSdkAppImplementation.experimental_useCurrentUser).toBe(
      useCurrentUser,
    );
    expect(pluginSdkAppImplementation.experimental_useUserStorageKey).toBe(
      useUserStorageKey,
    );
  });

  it("reports the local owner as an admin in local mode without its placeholder email", () => {
    const { result } = renderWithSession(useCurrentUser, LOCAL_SESSION);

    expect(result.current).toEqual({
      userId: "usr_local_owner",
      displayName: "Local owner",
      email: null,
      role: "admin",
      effectiveRole: "admin",
      roleCeiling: null,
    });
  });

  it("reports whichever user the session belongs to", () => {
    const alex = renderWithSession(useCurrentUser, multiSession(ALEX));
    const sam = renderWithSession(useCurrentUser, multiSession(SAM));

    expect(alex.result.current).toMatchObject({
      userId: "usr_alex",
      displayName: "Alex",
      email: "alex@example.com",
      effectiveRole: "admin",
    });
    expect(sam.result.current).toMatchObject({
      userId: "usr_sam",
      displayName: "Sam",
      effectiveRole: "member",
    });
  });

  it("reports a member-capped admin credential as acting with member rights", () => {
    const { result } = renderWithSession(
      useCurrentUser,
      multiSession(ALEX, "member"),
    );

    expect(result.current).toMatchObject({
      role: "admin",
      effectiveRole: "member",
      roleCeiling: "member",
    });
  });

  it("updates when the refreshed session carries a new role and returns null after sign-out", () => {
    const view = renderWithSession(
      () => ({ user: useCurrentUser(), member: useActsAsMember() }),
      multiSession(SAM),
    );
    expect(view.result.current.member).toBe(true);

    view.setSession(multiSession({ ...SAM, role: "admin" }));
    expect(view.result.current.user?.effectiveRole).toBe("admin");
    expect(view.result.current.member).toBe(false);

    view.setSession(multiSession(null));
    expect(view.result.current.user).toBeNull();
    expect(view.result.current.member).toBe(false);
  });
});

describe("useUserStorageKey", () => {
  it("keeps local-mode keys unchanged", () => {
    const { result } = renderWithSession(
      () => useUserStorageKey("bb.palette.recents"),
      LOCAL_SESSION,
    );

    expect(result.current).toBe("bb.palette.recents");
  });

  it("gives each signed-in user a separate key and none while signed out", () => {
    const view = renderWithSession(
      () => useUserStorageKey("bb.palette.recents"),
      multiSession(ALEX),
    );
    expect(view.result.current).toBe("bb.palette.recents:user:usr_alex");

    view.setSession(multiSession(SAM));
    expect(view.result.current).toBe("bb.palette.recents:user:usr_sam");

    view.setSession(multiSession(null));
    expect(view.result.current).toBeNull();
  });

  it("has no key until the session is known, then scopes it by mode", () => {
    const view = renderWithSession(
      () => useUserStorageKey("bb.palette.recents"),
      null,
    );
    expect(view.result.current).toBeNull();

    view.setSession(multiSession(SAM));
    expect(view.result.current).toBe("bb.palette.recents:user:usr_sam");

    view.setSession(null);
    expect(view.result.current).toBeNull();

    view.setSession(LOCAL_SESSION);
    expect(view.result.current).toBe("bb.palette.recents");
  });
});
