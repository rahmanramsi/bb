import { getConnInfo } from "@hono/node-server/conninfo";
import {
  APP_SURFACE_API,
  APP_SURFACE_HEADER_NAME,
  parseRequestAppSurface,
  type RequestAppSurface,
} from "@bb/config/app-surface";
import type { Context } from "hono";
import { TEAM_THREAD_VIEWER_ID, type RoleCeiling } from "@bb/domain";
import { ApiError } from "./errors.js";
import type { RequestPrincipal } from "./services/user-auth.js";

export const TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY = "bbTrustedRemoteAddress";
export const PRINCIPAL_CONTEXT_KEY = "bbPrincipal";
const GATE_AUTH_HEADER_NAME = "x-bb-gate-auth";
const GATE_MACHINE_ID_HEADER_NAME = "x-bb-gate-machine-id";
type GateAuthKind = "machine" | "session";

export interface GateAuthHeaderReader {
  req: { header(name: string): string | undefined };
}

interface TrustedRemoteAddressReader {
  get(key: typeof TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY): string | undefined;
}

export interface PrincipalReader {
  get(key: typeof PRINCIPAL_CONTEXT_KEY): RequestPrincipal | undefined;
}

declare module "hono" {
  interface ContextVariableMap {
    [TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY]: string | undefined;
    [PRINCIPAL_CONTEXT_KEY]: RequestPrincipal | undefined;
  }
}

export function setRequestPrincipal(
  context: Context,
  principal: RequestPrincipal | null,
): void {
  context.set(PRINCIPAL_CONTEXT_KEY, principal ?? undefined);
}

export function getRequestPrincipal(
  context: PrincipalReader,
): RequestPrincipal | null {
  return context.get(PRINCIPAL_CONTEXT_KEY) ?? null;
}

export function requirePrincipal(context: PrincipalReader): RequestPrincipal {
  const principal = getRequestPrincipal(context);
  if (principal === null) {
    throw new ApiError(401, "unauthorized", "Unauthorized");
  }
  return principal;
}

export function requireTurnAuthor(context: PrincipalReader): {
  authorRoleCeiling: RoleCeiling | null;
  authorUserId: string;
} {
  const principal = requirePrincipal(context);
  return {
    authorRoleCeiling: principal.roleCeiling,
    authorUserId: principal.userId,
  };
}

export function requireThreadViewerId(context: PrincipalReader): string {
  const principal = requirePrincipal(context);
  return principal.kind === "machine"
    ? TEAM_THREAD_VIEWER_ID
    : principal.userId;
}

export function assertAdmin(context: PrincipalReader): RequestPrincipal {
  const principal = requirePrincipal(context);
  if (principal.role !== "admin") {
    throw new ApiError(
      403,
      "admin_required",
      "This action requires an admin account",
    );
  }
  return principal;
}

export function captureTrustedRemoteAddress(context: Context): void {
  try {
    context.set(
      TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY,
      getConnInfo(context).remote.address,
    );
  } catch {
    context.set(TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY, undefined);
  }
}

export function getTrustedRemoteAddress(
  context: TrustedRemoteAddressReader,
): string | undefined {
  return context.get(TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY);
}

export function getGateAuthKind(
  context: GateAuthHeaderReader,
): GateAuthKind | null {
  const value = context.req.header(GATE_AUTH_HEADER_NAME);
  return value === "machine" || value === "session" ? value : null;
}

export function getGateMachineId(context: GateAuthHeaderReader): string | null {
  const value = context.req.header(GATE_MACHINE_ID_HEADER_NAME)?.trim();
  return value ? value : null;
}

export function resolveRequestAppSurface(context: Context): RequestAppSurface {
  return (
    parseRequestAppSurface(context.req.header(APP_SURFACE_HEADER_NAME)) ??
    APP_SURFACE_API
  );
}
