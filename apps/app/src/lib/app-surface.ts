import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_HEADER_NAME,
  APP_SURFACE_WEB,
  type RequestAppSurface,
} from "@bb/config/app-surface";
import { isInsideNativeShell } from "@/lib/native-shell";

const APP_SURFACE_MOBILE: RequestAppSurface = "mobile";
export const AUTHENTICATION_REQUIRED_EVENT = "bb:authentication-required";
const PUBLIC_AUTH_PATHS = new Set([
  "/api/v1/auth/session",
  "/api/v1/auth/sign-in",
  "/api/v1/auth/sign-up",
  "/api/v1/auth/invites/accept",
]);

export function getAppSurface(): RequestAppSurface {
  if (typeof window !== "undefined" && window.bbDesktop !== undefined) {
    return APP_SURFACE_DESKTOP;
  }
  if (isInsideNativeShell()) {
    return APP_SURFACE_MOBILE;
  }
  return APP_SURFACE_WEB;
}

export function appSurfaceRequestInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(APP_SURFACE_HEADER_NAME, getAppSurface());
  return {
    ...init,
    cache: init?.cache ?? "no-store",
    headers,
  };
}

export async function fetchWithAppSurface(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): ReturnType<typeof fetch> {
  const response = await fetch(input, appSurfaceRequestInit(init));
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (
    response.status === 401 &&
    typeof window !== "undefined" &&
    !PUBLIC_AUTH_PATHS.has(new URL(url, window.location.origin).pathname)
  ) {
    window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
  }
  return response;
}
