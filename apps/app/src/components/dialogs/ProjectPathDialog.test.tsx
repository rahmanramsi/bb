// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeHost as host } from "@bb/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSessionResponse } from "@bb/server-contract";
import { AuthContext } from "@/hooks/useAuth";
import { ProjectPathDialog } from "./ProjectPathDialog";

vi.mock("@/components/dialogs/RemotePathBrowser", () => ({
  RemotePathBrowser: ({
    hostId,
    allowCreateFolder,
    onDirectoryChange,
  }: {
    hostId: string;
    allowCreateFolder: boolean;
    onDirectoryChange: (directory: string) => void;
  }) => (
    <button
      type="button"
      data-allow-create-folder={String(allowCreateFolder)}
      onClick={() =>
        onDirectoryChange(
          hostId === "host_kunst"
            ? "/Users/amadad/projects/reachy_mini"
            : hostId === "host_long"
              ? `/home/deploy/repos/${"long-project-name-".repeat(20)}`
              : "/home/deploy/repos/givecare",
        )
      }
    >
      Choose folder on {hostId}
    </button>
  ),
}));

const atum = host({ id: "host_atum", name: "atum" });
const kunst = host({ id: "host_kunst", name: "Kunst" });
const offline = host({
  id: "host_offline",
  name: "Offline Mac",
  status: "disconnected",
});
const offlineKunst = host({ ...kunst, status: "disconnected" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectPathDialog machine selection", () => {
  it("creates a project from a folder on the selected connected machine", () => {
    const onSubmit = vi.fn();
    render(
      <ProjectPathDialog
        target={{ kind: "create" }}
        platform="linux"
        hostId={atum.id}
        hostName={atum.name}
        hosts={[atum, kunst, offline]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Machine" });
    expect(trigger.textContent).toContain("atum");
    expect(
      screen
        .getByRole("button", { name: "Choose folder on host_atum" })
        .getAttribute("data-allow-create-folder"),
    ).toBe("true");

    fireEvent.pointerDown(trigger, { button: 0 });
    expect(
      screen
        .getByRole("menuitem", { name: /Offline Mac/u })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("menuitem", { name: /Kunst/u }));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose folder on host_kunst" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "create" },
      "/Users/amadad/projects/reachy_mini",
      "host_kunst",
    );
  });

  it("preserves the direct single-machine folder flow", () => {
    const onSubmit = vi.fn();
    render(
      <ProjectPathDialog
        target={{ kind: "create" }}
        platform="linux"
        hostId={atum.id}
        hostName={atum.name}
        hosts={[atum]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.queryByRole("button", { name: "Machine" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose folder on host_atum" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "create" },
      "/home/deploy/repos/givecare",
      "host_atum",
    );
  });

  it("includes provider-made hosts in the project setup machine picker", () => {
    render(
      <ProjectPathDialog
        target={{ kind: "create" }}
        platform="linux"
        hostId={atum.id}
        hostName={atum.name}
        hosts={[
          atum,
          kunst,
          host({
            id: "host_modal",
            name: "Modal sandbox 3f9a",
          }),
        ]}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Machine" }), {
      button: 0,
    });

    expect(screen.getByRole("menuitem", { name: /Kunst/u })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Modal sandbox 3f9a/u }),
    ).toBeTruthy();
  });

  it("uses a provider-made host as the only project machine", () => {
    const onSubmit = vi.fn();
    render(
      <ProjectPathDialog
        target={{ kind: "create" }}
        platform="linux"
        hostId="host_modal"
        hostName="Modal sandbox 3f9a"
        hosts={[
          host({
            id: "host_modal",
            name: "Modal sandbox 3f9a",
          }),
        ]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose folder on host_modal" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "create" },
      "/home/deploy/repos/givecare",
      "host_modal",
    );
  });

  it("blocks submission when every listed machine is offline", () => {
    const onSubmit = vi.fn();
    render(
      <ProjectPathDialog
        target={{ kind: "create" }}
        platform="linux"
        hostId={null}
        hostName={null}
        hosts={[offline, offlineKunst]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.queryByLabelText("Project path")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Add project" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

function authSession(authMode: "multi" | "local"): AuthSessionResponse {
  return {
    user: {
      id: "usr_sam",
      name: "Sam",
      email: "sam@example.com",
      role: "member",
    },
    authMode,
    needsBootstrap: false,
    principalKind: authMode === "local" ? "local" : "user",
  };
}

describe("ProjectPathDialog project access", () => {
  function renderCreateDialog(authMode: "multi" | "local") {
    const onSubmit = vi.fn();
    render(
      <AuthContext.Provider value={authSession(authMode)}>
        <ProjectPathDialog
          target={{ kind: "create" }}
          platform="linux"
          hostId={atum.id}
          hostName={atum.name}
          hosts={[atum]}
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />
      </AuthContext.Provider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose folder on host_atum" }),
    );
    return onSubmit;
  }

  it("submits a public project by default on a multi-user server", () => {
    const onSubmit = renderCreateDialog("multi");

    expect(
      screen
        .getByRole("radio", { name: "Public" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "create", visibility: "public" },
      "/home/deploy/repos/givecare",
      "host_atum",
    );
  });

  it("submits the private choice", () => {
    const onSubmit = renderCreateDialog("multi");

    fireEvent.click(screen.getByRole("radio", { name: "Private" }));
    expect(
      screen.getByText(
        "Only you, members you add, and admins can see this project.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "create", visibility: "private" },
      "/home/deploy/repos/givecare",
      "host_atum",
    );
  });

  it("hides the access choice in single-user mode", () => {
    const onSubmit = renderCreateDialog("local");

    expect(screen.queryByRole("group", { name: "Project access" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Private" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "create" },
      "/home/deploy/repos/givecare",
      "host_atum",
    );
  });
});
