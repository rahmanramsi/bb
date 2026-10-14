import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthenticatedSocketRegistry,
  REVOKED_SOCKET_CLOSE_CODE,
  type AuthenticatedSocketRegistry,
} from "../../src/ws/authenticated-sockets.js";

function fakeSocket() {
  const closes: Array<{ code?: number; reason?: string }> = [];
  return {
    closes,
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
  };
}

let registry: AuthenticatedSocketRegistry | null = null;

afterEach(() => {
  registry?.dispose();
  registry = null;
});

describe("authenticated socket registry", () => {
  it("closes and marks only sockets whose credential stopped authorizing", async () => {
    registry = createAuthenticatedSocketRegistry();
    let terminalActive = true;
    const terminal = fakeSocket();
    const realtime = fakeSocket();
    const failing = fakeSocket();
    registry.track(terminal, async () => terminalActive);
    registry.track(realtime, async () => true);
    registry.track(failing, async () => {
      throw new Error("lookup failed");
    });

    await registry.revalidate();
    expect(terminal.closes).toEqual([]);
    expect(failing.closes).toEqual([
      { code: REVOKED_SOCKET_CLOSE_CODE, reason: "Unauthorized" },
    ]);
    expect(registry.isRevoked(failing)).toBe(true);

    terminalActive = false;
    await registry.revalidate();
    await registry.revalidate();
    expect(terminal.closes).toHaveLength(1);
    expect(registry.isRevoked(terminal)).toBe(true);
    expect(realtime.closes).toEqual([]);
    expect(registry.isRevoked(realtime)).toBe(false);
  });

  it("reruns a sweep requested while one is in flight and ignores untracked sockets", async () => {
    registry = createAuthenticatedSocketRegistry();
    let active = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const socket = fakeSocket();
    const untracked = fakeSocket();
    registry.track(socket, async () => {
      await gate;
      return active;
    });
    registry.track(untracked, async () => false);
    registry.untrack(untracked);
    const first = registry.revalidate();
    active = false;
    const second = registry.revalidate();
    release();
    await Promise.all([first, second]);
    expect(socket.closes).toHaveLength(1);
    expect(untracked.closes).toEqual([]);
  });
});
