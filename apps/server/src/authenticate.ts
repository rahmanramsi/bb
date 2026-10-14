import { GATE_IDENTITY_HEADER } from "@bb/tunnel-contract";
import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors.js";
import { setRequestPrincipal } from "./request-context.js";
import {
  LOCAL_OWNER_PRINCIPAL,
  UserAuthError,
  type RequestPrincipal,
} from "./services/user-auth.js";
import type { ServerAppDeps } from "./types.js";

type AuthenticateDeps = Pick<ServerAppDeps, "config" | "userAuth">;

const AUTH_OPTIONAL_API_PATHS = new Set([
  "/api/v1/auth/session",
  "/api/v1/auth/invites/accept",
  "/api/v1/auth/sign-in",
  "/api/v1/auth/sign-out",
  "/api/v1/auth/sign-up",
]);

function normalizeApiPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

export function isAuthOptionalApiPath(path: string): boolean {
  return AUTH_OPTIONAL_API_PATHS.has(normalizeApiPath(path));
}

export async function resolveRequestPrincipal(
  deps: AuthenticateDeps,
  headers: Headers,
): Promise<RequestPrincipal | null> {
  if (deps.config.authMode === "local") {
    headers.delete(GATE_IDENTITY_HEADER);
    return LOCAL_OWNER_PRINCIPAL;
  }
  try {
    return await deps.userAuth.resolvePrincipal(headers);
  } catch (error) {
    if (error instanceof UserAuthError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}

export function authenticateApiRequests(
  deps: AuthenticateDeps,
): MiddlewareHandler {
  return async (context, next) => {
    const principal = await resolveRequestPrincipal(
      deps,
      context.req.raw.headers,
    );
    setRequestPrincipal(context, principal);
    if (principal === null && !isAuthOptionalApiPath(context.req.path)) {
      throw new ApiError(401, "unauthorized", "Unauthorized");
    }
    return next();
  };
}

export async function authenticateRequest(
  deps: AuthenticateDeps,
  context: Parameters<MiddlewareHandler>[0],
): Promise<RequestPrincipal> {
  const principal = await resolveRequestPrincipal(
    deps,
    context.req.raw.headers,
  );
  if (principal === null) {
    throw new ApiError(401, "unauthorized", "Unauthorized", false);
  }
  setRequestPrincipal(context, principal);
  return principal;
}
