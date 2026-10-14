// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExperimentalCurrentUser } from "../../app-contract.js";
import { installTestPluginRuntime, renderSlot } from "../app.js";

installTestPluginRuntime();
const { experimental_useCurrentUser, experimental_useUserStorageKey } =
  await import("../../app.js");

const BOB: ExperimentalCurrentUser = {
  userId: "usr_bob",
  displayName: "Bob",
  email: "bob@example.test",
  role: "member",
  effectiveRole: "member",
  roleCeiling: null,
};

function CurrentUserProbe() {
  const user = experimental_useCurrentUser();
  const storageKey = experimental_useUserStorageKey("prefs");
  return (
    <div>
      <p>user: {user === null ? "signed out" : user.displayName}</p>
      <p>role: {user?.effectiveRole ?? "none"}</p>
      <p>email: {user === null ? "none" : (user.email ?? "hidden")}</p>
      <p>key: {storageKey ?? "none"}</p>
    </div>
  );
}

afterEach(() => cleanup());

describe("experimental_useCurrentUser test runtime", () => {
  it("defaults to the local owner admin with unscoped storage keys", () => {
    const slot = renderSlot({ component: CurrentUserProbe }, {});

    expect(slot.getByText("user: Local owner")).toBeTruthy();
    expect(slot.getByText("role: admin")).toBeTruthy();
    expect(slot.getByText("email: hidden")).toBeTruthy();
    expect(slot.getByText("key: prefs")).toBeTruthy();
  });

  it("reports the signed-in user and scopes storage keys to them", () => {
    const bob = renderSlot(
      { component: CurrentUserProbe },
      {},
      { experimental_currentUser: BOB },
    );
    expect(bob.getByText("user: Bob")).toBeTruthy();
    expect(bob.getByText("role: member")).toBeTruthy();
    expect(bob.getByText("key: prefs:user:usr_bob")).toBeTruthy();
    bob.unmount();

    const carol = renderSlot(
      { component: CurrentUserProbe },
      {},
      {
        experimental_currentUser: {
          ...BOB,
          userId: "usr_carol",
          displayName: "Carol",
        },
      },
    );
    expect(carol.getByText("key: prefs:user:usr_carol")).toBeTruthy();
  });

  it("re-renders when the user's role changes or they sign out", async () => {
    const slot = renderSlot(
      { component: CurrentUserProbe },
      {},
      { experimental_currentUser: BOB },
    );

    await slot.behavior.experimental_setCurrentUser({
      ...BOB,
      role: "admin",
      effectiveRole: "admin",
    });
    expect(slot.getByText("role: admin")).toBeTruthy();

    await slot.behavior.experimental_setCurrentUser(null);
    expect(slot.getByText("user: signed out")).toBeTruthy();
    expect(slot.getByText("key: none")).toBeTruthy();
  });
});
