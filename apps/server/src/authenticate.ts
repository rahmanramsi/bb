import { GATE_IDENTITY_HEADER } from "@bb/tunnel-contract";
import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors.js";
import { setRequestPrincipal } from "./request-context.js";
import {
  LOCAL_OWNER_PRINCIPAL,
  UserAuthError,
  type AuthenticatedCredential,
  type RequestPrincipal,
} from "./services/user-auth.js";
import type { ServerAppDeps } from "./types.js";

type AuthenticateDeps = Pick<ServerAppDeps, "config" | "userAuth">;
const PLUGIN_WIRE_HTTP_PATH = /^\/api\/v1\/plugins\/[^/]+\/http(?:\/|$)/u;
const PLUGIN_USER_TOKEN_HEADER = "x-bb-user-token";

declare module "hono" {
  interface ContextVariableMap {
    bbAuthenticatedCredential: AuthenticatedCredential | undefined;
  }
}

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

const LOCAL_OWNER_CREDENTIAL: AuthenticatedCredential = {
  principal: LOCAL_OWNER_PRINCIPAL,
  isActive: async () => true,
};

async function authenticateCredential(
  deps: AuthenticateDeps,
  headers: Headers,
): Promise<AuthenticatedCredential | null> {
  if (deps.config.authMode === "local") {
    headers.delete(GATE_IDENTITY_HEADER);
    return LOCAL_OWNER_CREDENTIAL;
  }
  try {
    return await deps.userAuth.authenticate(headers);
  } catch (error) {
    if (error instanceof UserAuthError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}

export async function resolveRequestPrincipal(
  deps: AuthenticateDeps,
  headers: Headers,
): Promise<RequestPrincipal | null> {
  return (await authenticateCredential(deps, headers))?.principal ?? null;
}

export function authenticateApiRequests(
  deps: AuthenticateDeps,
): MiddlewareHandler {
  return async (context, next) => {
    const headers = context.req.raw.headers;
    const userToken = headers.get(PLUGIN_USER_TOKEN_HEADER);
    headers.delete(PLUGIN_USER_TOKEN_HEADER);
    const authenticationHeaders =
      userToken !== null && PLUGIN_WIRE_HTTP_PATH.test(context.req.path)
        ? new Headers(headers)
        : headers;
    if (authenticationHeaders !== headers) {
      authenticationHeaders.set("authorization", `Bearer ${userToken}`);
    }
    const credential = await authenticateCredential(
      deps,
      authenticationHeaders,
    );
    headers.delete(GATE_IDENTITY_HEADER);
    const principal = credential?.principal ?? null;
    context.set("bbAuthenticatedCredential", credential ?? undefined);
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
): Promise<AuthenticatedCredential> {
  const credential = await authenticateCredential(
    deps,
    context.req.raw.headers,
  );
  if (credential === null) {
    throw new ApiError(401, "unauthorized", "Unauthorized", false);
  }
  setRequestPrincipal(context, credential.principal);
  return credential;
}
