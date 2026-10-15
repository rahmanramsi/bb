import { getTerminalSession, type DbConnection } from "@bb/db";
import type { MiddlewareHandler } from "hono";
import { ApiError } from "../../errors.js";
import { getRequestPrincipal } from "../../request-context.js";
import type { RequestPrincipal } from "../user-auth.js";
import {
  assertCanViewEnvironmentId,
  assertCanViewProjectId,
  assertCanViewThreadId,
  projectAccessScopeFor,
} from "./project-access.js";

const SCOPED_PATH_PATTERN =
  /^\/api\/v1\/(projects|threads|environments|terminals)\/([^/]+)/u;
const PROJECT_REFERENCE_KEYS = ["projectId", "sourceProjectId"] as const;
const THREAD_REFERENCE_KEYS = [
  "threadId",
  "parentThreadId",
  "sourceThreadId",
] as const;
const ENVIRONMENT_REFERENCE_KEYS = ["environmentId"] as const;
const JSON_BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const REFERENCE_INSPECTION_PATH_PATTERN =
  /^\/api\/v1\/(projects|threads|environments|terminals|queued-messages|plugins|prompt-history|hosts|system)(\/|$)/u;
const MAX_REFERENCE_DEPTH = 8;

interface ProjectAccessGuardDeps {
  db: DbConnection;
}

interface ScopedReference {
  kind: "project" | "thread" | "environment" | "terminal";
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectReferences(
  value: unknown,
  references: ScopedReference[],
  depth: number,
): void {
  if (depth > MAX_REFERENCE_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, references, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of PROJECT_REFERENCE_KEYS) {
    const id = value[key];
    if (typeof id === "string" && id.length > 0) {
      references.push({ kind: "project", id });
    }
  }
  for (const key of THREAD_REFERENCE_KEYS) {
    const id = value[key];
    if (typeof id === "string" && id.length > 0) {
      references.push({ kind: "thread", id });
    }
  }
  for (const key of ENVIRONMENT_REFERENCE_KEYS) {
    const id = value[key];
    if (typeof id === "string" && id.length > 0) {
      references.push({ kind: "environment", id });
    }
  }
  for (const nested of Object.values(value)) {
    collectReferences(nested, references, depth + 1);
  }
}

function pathReference(path: string): ScopedReference | null {
  const match = SCOPED_PATH_PATTERN.exec(path);
  if (match === null) {
    return null;
  }
  const [, segment, rawId] = match;
  if (segment === undefined || rawId === undefined) {
    return null;
  }
  const id = decodeURIComponent(rawId);
  switch (segment) {
    case "projects":
      return id.startsWith("proj_") ? { kind: "project", id } : null;
    case "threads":
      return id.startsWith("thr_") ? { kind: "thread", id } : null;
    case "environments":
      return id.startsWith("env_") ? { kind: "environment", id } : null;
    case "terminals":
      return id.startsWith("term_") ? { kind: "terminal", id } : null;
    default:
      return null;
  }
}

export function assertCanViewReference(
  db: DbConnection,
  reference: ScopedReference,
  principal: RequestPrincipal,
): void {
  switch (reference.kind) {
    case "project":
      assertCanViewProjectId(db, reference.id, principal);
      return;
    case "thread":
      assertCanViewThreadId(db, reference.id, principal);
      return;
    case "environment":
      assertCanViewEnvironmentId(db, reference.id, principal);
      return;
    case "terminal":
      assertCanViewTerminalId(db, reference.id, principal);
      return;
  }
}

export function assertCanViewTerminalId(
  db: DbConnection,
  terminalId: string,
  principal: RequestPrincipal,
): void {
  if (projectAccessScopeFor(principal).kind === "unrestricted") {
    return;
  }
  const terminal = getTerminalSession(db, { kind: "terminal", terminalId });
  if (terminal === null) {
    return;
  }
  try {
    if (terminal.threadId !== null) {
      assertCanViewThreadId(db, terminal.threadId, principal);
    }
    if (terminal.environmentId !== null) {
      assertCanViewEnvironmentId(db, terminal.environmentId, principal);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(404, "terminal_not_found", "Terminal not found");
    }
    throw error;
  }
}

async function readBodyReferences(
  context: Parameters<MiddlewareHandler>[0],
  references: ScopedReference[],
): Promise<void> {
  if (!JSON_BODY_METHODS.has(context.req.method)) {
    return;
  }
  const text = await context.req.raw
    .clone()
    .text()
    .catch(() => "");
  if (text.length === 0) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    collectReferences(parsed, references, 0);
  } catch {
    return;
  }
}

export function enforceProjectAccess(
  deps: ProjectAccessGuardDeps,
): MiddlewareHandler {
  return async (context, next) => {
    const principal = getRequestPrincipal(context);
    if (
      principal === null ||
      projectAccessScopeFor(principal).kind === "unrestricted"
    ) {
      return next();
    }
    const references: ScopedReference[] = [];
    const fromPath = pathReference(context.req.path);
    if (fromPath !== null) {
      references.push(fromPath);
    }
    if (REFERENCE_INSPECTION_PATH_PATTERN.test(context.req.path)) {
      collectReferences(context.req.query(), references, 0);
      await readBodyReferences(context, references);
    }
    for (const reference of references) {
      assertCanViewReference(deps.db, reference, principal);
    }
    return next();
  };
}
