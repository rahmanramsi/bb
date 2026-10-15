import {
  createThreadSection,
  deleteThreadSection,
  getThreadSectionAccess,
  listThreadSections,
  normalizeThreadSectionName,
  renameThreadSection,
} from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requirePrincipal, type PrincipalReader } from "../request-context.js";
import { projectAccessScopeFor } from "../services/projects/project-access.js";

function requireSectionName(name: string): string {
  const normalized = normalizeThreadSectionName(name);
  if (!normalized) {
    throw new ApiError(400, "invalid_request", "Section name cannot be empty");
  }
  return normalized;
}

function throwDuplicateSectionName(): never {
  throw new ApiError(
    409,
    "section_name_conflict",
    "Section name already exists",
  );
}

function throwSectionNotFound(): never {
  throw new ApiError(404, "section_not_found", "Section not found");
}

export function registerThreadSectionRoutes(app: Hono, deps: AppDeps): void {
  const { del, get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.threadSections;

  const assertCanChangeSection = (
    context: PrincipalReader,
    id: string,
  ): void => {
    const access = getThreadSectionAccess(deps.db, {
      id,
      projectAccess: projectAccessScopeFor(requirePrincipal(context)),
    });
    if (access === "hidden") {
      throwSectionNotFound();
    }
    if (access === "shared_with_hidden") {
      throw new ApiError(
        409,
        "section_in_use",
        "This section is also used by threads in projects you cannot access",
      );
    }
  };

  get(routes.list, (context) =>
    context.json(
      listThreadSections(
        deps.db,
        projectAccessScopeFor(requirePrincipal(context)),
      ),
    ),
  );

  post(routes.create, (context, payload) => {
    const result = createThreadSection(deps.db, deps.hub, {
      name: requireSectionName(payload.name),
    });
    if (result.status === "duplicate") {
      throwDuplicateSectionName();
    }
    return context.json(result.section, 201);
  });

  patch(routes.update, (context, payload) => {
    assertCanChangeSection(context, payload.id);
    const result = renameThreadSection(deps.db, deps.hub, {
      id: payload.id,
      name: requireSectionName(payload.name),
    });
    if (result.status === "not_found") {
      throwSectionNotFound();
    }
    if (result.status === "duplicate") {
      throwDuplicateSectionName();
    }
    return context.json(result.result);
  });

  del(routes.delete, (context, payload) => {
    assertCanChangeSection(context, payload.id);
    const result = deleteThreadSection(deps.db, deps.hub, { id: payload.id });
    if (!result) {
      throwSectionNotFound();
    }
    return context.json(result);
  });
}
