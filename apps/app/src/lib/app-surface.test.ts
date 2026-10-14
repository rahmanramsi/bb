import { APP_SURFACE_HEADER_NAME } from "@bb/config/app-surface";
import {
  buildBridgeInjectionScript,
  type NativeShellHandshake,
} from "@bb/mobile-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import { resetNativeShellForTests } from "@/lib/native-shell";
import {
  appSurfaceRequestInit,
  getAppSurface,
  fetchWithAppSurface,
  AUTHENTICATION_REQUIRED_EVENT,
} from "./app-surface";

const mobileHandshake: NativeShellHandshake = {
  bridgeVersion: 1,
  appVersion: "0.39.0",
  platform: "ios",
  profileMode: "connect",
  secureContext: true,
  safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
  capabilities: ["haptic", "badge", "share", "open-external", "safe-area"],
};

const desktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
} as const;

describe("app surface request metadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNativeShellForTests();
  });

  it("defaults browser requests to the web app surface", () => {
    const init = appSurfaceRequestInit({
      headers: { "x-existing": "kept" },
    });

    const headers = new Headers(init.headers);
    expect(getAppSurface()).toBe("web");
    expect(headers.get(APP_SURFACE_HEADER_NAME)).toBe("web");
    expect(headers.get("x-existing")).toBe("kept");
  });

  it("keeps API requests out of the browser HTTP cache unless the caller chooses a mode", () => {
    expect(appSurfaceRequestInit().cache).toBe("no-store");
    expect(appSurfaceRequestInit({ cache: "force-cache" }).cache).toBe(
      "force-cache",
    );
  });

  it("marks Electron preload requests as desktop", () => {
    vi.stubGlobal("window", {
      bbDesktop: createBbDesktopApi(desktopInfo),
    });

    const init = appSurfaceRequestInit();

    expect(getAppSurface()).toBe("desktop");
    expect(new Headers(init.headers).get(APP_SURFACE_HEADER_NAME)).toBe(
      "desktop",
    );
  });

  it("marks requests from the bb mobile shell as mobile", () => {
    const fakeWindow: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: () => {} },
    };
    // eslint-disable-next-line no-new-func
    new Function("window", buildBridgeInjectionScript(mobileHandshake))(
      fakeWindow,
    );
    vi.stubGlobal("window", fakeWindow);
    resetNativeShellForTests();

    const init = appSurfaceRequestInit();

    expect(getAppSurface()).toBe("mobile");
    expect(new Headers(init.headers).get(APP_SURFACE_HEADER_NAME)).toBe(
      "mobile",
    );
  });
});

describe("expired browser authentication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetNativeShellForTests();
  });

  it.each([
    { path: "/api/v1/threads", status: 401, refresh: true },
    { path: "/api/v1/auth/tokens", status: 401, refresh: true },
    { path: "/api/v1/auth/invites", status: 401, refresh: true },
    { path: "/api/v1/auth/sign-in", status: 401, refresh: false },
    { path: "/api/v1/auth/session", status: 401, refresh: false },
    { path: "/api/v1/auth/invites/accept", status: 401, refresh: false },
    { path: "/api/v1/threads", status: 403, refresh: false },
  ])(
    "refreshes the session only for protected unauthorized requests: $path, $status",
    async ({ path, status, refresh }) => {
      const browserWindow = Object.assign(new EventTarget(), {
        location: { origin: "http://localhost" },
      });
      vi.stubGlobal("window", browserWindow);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status })),
      );
      const listener = vi.fn();
      browserWindow.addEventListener(AUTHENTICATION_REQUIRED_EVENT, listener);
      const response = await fetchWithAppSurface(path);
      expect(response.status).toBe(status);
      expect(listener).toHaveBeenCalledTimes(refresh ? 1 : 0);
    },
  );
});
