import { AsyncLocalStorage } from "node:async_hooks";
import type { DbConnection } from "@bb/db";
import type { RoleCeiling, UserRole } from "@bb/domain";
import type { ExperimentalPluginCaller } from "@get-bb/plugin-sdk";
import { pluginCallerAuthority } from "@get-bb/plugin-sdk/internal/host-policy";
import { readUserRole, type RequestPrincipal } from "../user-auth.js";

export interface PluginCallerIdentity {
  authority: UserRole;
  caller: ExperimentalPluginCaller;
}

export const SYSTEM_PLUGIN_CALLER: PluginCallerIdentity = {
  authority: "admin",
  caller: { kind: "system" },
};

export function pluginCallerForPrincipal(
  db: DbConnection,
  principal: RequestPrincipal,
  pluginCaller: ExperimentalPluginCaller | null,
): PluginCallerIdentity {
  if (pluginCaller !== null) {
    return { authority: principal.role, caller: pluginCaller };
  }
  if (principal.kind === "machine") return SYSTEM_PLUGIN_CALLER;
  const role =
    principal.roleCeiling === null && principal.delegatedPluginId === null
      ? principal.role
      : (readUserRole(db, principal.userId) ?? principal.role);
  return {
    authority: principal.role,
    caller: {
      kind: "client",
      userId: principal.userId,
      role,
      roleCeiling: principal.roleCeiling,
      effectiveRole: principal.role,
    },
  };
}

export function pluginCallerForTurnAuthor(
  db: DbConnection,
  author: { roleCeiling: RoleCeiling | null; userId: string } | null,
): PluginCallerIdentity {
  const role = author === null ? null : readUserRole(db, author.userId);
  if (author === null || role === null) {
    return { authority: "member", caller: { kind: "system" } };
  }
  const effectiveRole =
    author.roleCeiling === null && role === "admin" ? "admin" : "member";
  return {
    authority: effectiveRole,
    caller: {
      kind: "client",
      userId: author.userId,
      role,
      roleCeiling: author.roleCeiling,
      effectiveRole,
    },
  };
}

export interface PluginInvocation {
  readonly authority: UserRole;
  readonly caller: ExperimentalPluginCaller;
  readonly pluginId: string;
  isLive(): boolean;
  onEnd(hook: () => void): void;
  end(): void;
}

const currentInvocation = new AsyncLocalStorage<PluginInvocation>();
const invocationsByCaller = new WeakMap<object, PluginInvocation>();

export function createPluginInvocation(
  pluginId: string,
  args: PluginCallerIdentity,
): PluginInvocation {
  const caller = Object.freeze({ ...args.caller });
  const endHooks: Array<() => void> = [];
  let live = true;
  const invocation: PluginInvocation = {
    authority:
      args.authority === "admin" && pluginCallerAuthority(caller) === "admin"
        ? "admin"
        : "member",
    caller,
    pluginId,
    isLive: () => live,
    onEnd(hook) {
      if (live) endHooks.push(hook);
      else hook();
    },
    end() {
      if (!live) return;
      live = false;
      for (const hook of endHooks.splice(0)) hook();
    },
  };
  invocationsByCaller.set(caller, invocation);
  return invocation;
}

export function runInPluginInvocation<T>(
  invocation: PluginInvocation,
  run: () => T,
): T {
  return currentInvocation.run(invocation, run);
}

export async function runPluginInvocation<T>(
  invocation: PluginInvocation,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await currentInvocation.run(invocation, run);
  } finally {
    invocation.end();
  }
}

export function currentPluginInvocation(): PluginInvocation | null {
  return currentInvocation.getStore() ?? null;
}

export function pluginInvocationForCaller(
  pluginId: string,
  caller: object,
): PluginInvocation | null {
  const invocation = invocationsByCaller.get(caller);
  return invocation !== undefined &&
    invocation.pluginId === pluginId &&
    invocation.isLive()
    ? invocation
    : null;
}
