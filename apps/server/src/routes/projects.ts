import {
  projectMachineEnvironmentView,
  replaceMachineEnvironment,
} from "../services/machines/environment-settings.js";
import {
  setMachineEnvironmentVariable,
  deleteMachineEnvironmentVariable,
} from "../services/machines/environment-storage.js";
import {
  getGateAuthKind,
  requirePrincipal,
  requireThreadViewerId,
} from "../request-context.js";
import {
  countProjectSources,
  findOrCreateProjectByLocalPathSource,
  getPersonalProject,
  getProjectExecutionDefaults,
  getPublicProjectByLocalPathSource,
  deleteProjectSource,
  getProjectSourceByHost,
  getProjectSourceForProject,
  listProjectExecutionDefaultsByProjectIds,
  listActiveProjects,
  addProjectMember,
  getAuthUserIdentity,
  listProjectMemberUserIds,
  listProjectMembers,
  removeProjectMember,
  listProjectSourcesByProjectIds,
  listThreadSections,
  listThreadsWithPendingInteractionStateForProjects,
  reorderProject,
  updateProject,
  updateProjectSource,
  setProjectGitRemoteUrlIfMissing,
  type ReorderProjectResult,
} from "@bb/db";
import {
  projectListIncludeOptionSchema,
  publicApiRoutes,
  typedRoutes,
  type ProjectListIncludeOption,
  type ProjectBranchesQuery,
  type ProjectListQuery,
  type ProjectMembersResponse,
  type ProjectResponse,
  type ProjectWithThreadsResponse,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import {
  copyProjectAttachments,
  readAttachment,
  storeAttachment,
} from "../services/projects/attachments.js";
import {
  requireNonDestroyedHostWithStatus,
  requireProject,
  requirePublicProject,
  requirePublicStandardProject,
} from "../services/lib/entity-lookup.js";
import {
  DEFAULT_PROJECT_VISIBILITY,
  isWindowsHostPath,
  PROMPT_HISTORY_ENTRY_LIMIT,
  type ProjectVisibility,
} from "@bb/domain";
import type { RequestPrincipal } from "../services/user-auth.js";
import {
  assertCanManageProject,
  canManageProject,
  projectAccessScopeFor,
} from "../services/projects/project-access.js";
import { toThreadListEntryResponses } from "../services/threads/thread-runtime-display.js";
import { callHostRetryableOnlineRpc } from "../services/hosts/online-rpc.js";
import {
  cloneProjectSourceOnHost,
  registerProjectSourceOnHost,
  projectSourceHostConflict,
} from "../services/projects/project-source-setup.js";
import {
  deleteProjectSkill,
  listProjectSkillFiles,
  listProjectSkills,
  readProjectSkill,
  writeProjectSkill,
} from "../services/skills/skill-listing.js";
import { requestMatchesEntityTag } from "../services/hosts/daemon-file-response.js";
import { parseBoundedPositiveOptionalInteger } from "../services/lib/validation.js";
import {
  buildCommandListResponse,
  providerHasCommandSurface,
} from "../services/threads/provider-command-typeahead.js";
import {
  beginProjectDeletion,
  requestProjectDeletionAdvance,
} from "../services/projects/project-deletion.js";
import { resolveDefaultWorktreeBaseBranch } from "../services/projects/worktree-base-branch.js";
import { listProjectPromptHistory } from "../services/prompt-history.js";
import { parsePathKindInclusion } from "./path-list-inclusion.js";
import {
  DEFAULT_PATH_LIST_EXCLUDE_NAMES,
  WORKSPACE_PATH_LIST_INCLUDE_HIDDEN,
} from "./path-list-policy.js";
import {
  normalizeBranchQuery,
  parseBranchListLimit,
} from "./branch-list-query.js";
import { parseFileListLimit } from "./file-list-query.js";
import { resolveSkillCatalog } from "../services/skills/skill-catalog.js";
import {
  readWorkspaceAgentContext,
  type WorkspaceAgentContext,
} from "../services/threads/workspace-agent-context.js";
import { resolveSharedSkills } from "../services/skills/shared-skills.js";
import {
  providerHasNativeRootSurface,
  scanProviderNativeRoots,
} from "../services/providers/native-roots.js";
import { assertUsableHostId } from "../services/hosts/primary-host.js";
import {
  resolveProjectCommandWorkspace,
  resolveProjectWorkspaceTarget,
} from "../services/projects/project-workspace.js";

type ProjectResponseProjectFields = Omit<
  ProjectResponse,
  "sources" | "viewerCanManage"
>;
const ATTACHMENT_CONTENT_CACHE_CONTROL = "private, immutable, max-age=31536000";

function toProjectResponseProjectFields(
  project: ProjectResponseProjectFields,
  principal: RequestPrincipal,
): Omit<ProjectResponse, "sources"> {
  return {
    id: project.id,
    kind: project.kind,
    name: project.name,
    gitRemoteUrl: project.gitRemoteUrl,
    visibility: project.visibility,
    ownerUserId: project.ownerUserId,
    viewerCanManage:
      project.kind === "standard" && canManageProject(project, principal),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function buildProjectResponsesFromRows(
  deps: AppDeps,
  projects: ProjectResponseProjectFields[],
  principal: RequestPrincipal,
): ProjectResponse[] {
  if (projects.length === 0) {
    return [];
  }
  const sourcesByProjectId = new Map<string, ProjectResponse["sources"]>();
  for (const source of listProjectSourcesByProjectIds(
    deps.db,
    projects.map((project) => project.id),
  )) {
    const projectSources = sourcesByProjectId.get(source.projectId);
    if (projectSources) {
      projectSources.push(source);
      continue;
    }
    sourcesByProjectId.set(source.projectId, [source]);
  }

  return projects.map((project) => ({
    ...toProjectResponseProjectFields(project, principal),
    sources: sourcesByProjectId.get(project.id) ?? [],
  }));
}

function buildProjectResponse(
  deps: AppDeps,
  projectId: string,
  principal: RequestPrincipal,
): ProjectResponse {
  const response = buildProjectResponsesFromRows(
    deps,
    [requirePublicStandardProject(deps.db, projectId)],
    principal,
  )[0];
  if (!response) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return response;
}

interface ProjectListOptions {
  includePersonal: boolean;
  principal: RequestPrincipal;
  visibility: ProjectVisibility | null;
}

function listDiscoverableProjects(
  deps: AppDeps,
  options: ProjectListOptions,
): ProjectResponseProjectFields[] {
  const projects = listActiveProjects(deps.db, {
    access: projectAccessScopeFor(options.principal),
    visibility: options.visibility,
  });
  if (!options.includePersonal || options.visibility === "private") {
    return projects;
  }
  const personalProject = getPersonalProject(deps.db);
  if (!personalProject) {
    throw new ApiError(
      500,
      "internal_error",
      "Personal project is not initialized",
    );
  }
  return [personalProject, ...projects];
}

function toProjectOrderResponse(
  deps: AppDeps,
  result: ReorderProjectResult,
  principal: RequestPrincipal,
): ProjectResponse[] {
  switch (result.kind) {
    case "reordered":
    case "unchanged":
      return buildProjectResponsesFromRows(deps, result.projects, principal);
    case "not_found":
      throw new ApiError(404, "project_not_found", "Project not found");
    case "stale_neighbor":
      throw new ApiError(409, "invalid_request", "Project order changed");
    case "invalid_neighbor_order":
      throw new ApiError(409, "invalid_request", "Project order is invalid");
  }
}

function parseProjectListIncludes(
  query: ProjectListQuery,
): Set<ProjectListIncludeOption> {
  const includes = new Set<ProjectListIncludeOption>();
  if (!query.include) {
    return includes;
  }
  for (const value of query.include.split(",")) {
    includes.add(projectListIncludeOptionSchema.parse(value));
  }
  return includes;
}

function buildProjectsWithThreadsResponse(
  deps: AppDeps,
  options: ProjectListOptions,
  viewerUserId: string,
): ProjectWithThreadsResponse[] {
  return buildProjectsWithThreadsResponseFromRows(
    deps,
    listDiscoverableProjects(deps, options),
    viewerUserId,
    options.principal,
  );
}

function buildProjectsWithThreadsResponseFromRows(
  deps: AppDeps,
  projectRows: ProjectResponseProjectFields[],
  viewerUserId: string,
  principal: RequestPrincipal,
): ProjectWithThreadsResponse[] {
  const projects = buildProjectResponsesFromRows(deps, projectRows, principal);
  const projectIds = projects.map((project) => project.id);
  const threadRows = listThreadsWithPendingInteractionStateForProjects(
    deps.db,
    { archived: false, projectIds, viewerUserId },
  );
  const threadResponses = toThreadListEntryResponses(deps, {
    threads: threadRows,
  });
  const threadsByProjectId = new Map<
    string,
    ProjectWithThreadsResponse["threads"]
  >();
  for (const thread of threadResponses) {
    const projectThreads = threadsByProjectId.get(thread.projectId);
    if (projectThreads) {
      projectThreads.push(thread);
      continue;
    }
    threadsByProjectId.set(thread.projectId, [thread]);
  }
  const defaultsByProjectId = listProjectExecutionDefaultsByProjectIds(
    deps.db,
    { projectIds },
  );

  return projects.map((project) => ({
    ...project,
    threads: threadsByProjectId.get(project.id) ?? [],
    defaultExecutionOptions: defaultsByProjectId.get(project.id) ?? null,
  }));
}

interface SidebarBootstrapOptions {
  principal: RequestPrincipal;
  viewerUserId: string;
  visibility: ProjectVisibility | null;
}

function buildSidebarBootstrapResponse(
  deps: AppDeps,
  { principal, viewerUserId, visibility }: SidebarBootstrapOptions,
) {
  const personalProject = getPersonalProject(deps.db);
  if (!personalProject) {
    throw new ApiError(
      500,
      "internal_error",
      "Personal project is not initialized",
    );
  }
  const personalProjectResponse = buildProjectsWithThreadsResponseFromRows(
    deps,
    [personalProject],
    viewerUserId,
    principal,
  )[0];
  if (!personalProjectResponse) {
    throw new ApiError(
      500,
      "internal_error",
      "Personal project response was not built",
    );
  }
  return {
    sections: listThreadSections(deps.db, projectAccessScopeFor(principal)),
    projects: buildProjectsWithThreadsResponseFromRows(
      deps,
      listActiveProjects(deps.db, {
        access: projectAccessScopeFor(principal),
        visibility,
      }),
      viewerUserId,
      principal,
    ),
    personalProject: personalProjectResponse,
  };
}

function requireProjectMemberUser(deps: Pick<AppDeps, "db">, userId: string) {
  const user = getAuthUserIdentity(deps.db, userId);
  if (user === null) {
    throw new ApiError(404, "user_not_found", "User not found");
  }
  return user;
}

function assertExistingProjectMatchesRequestedAccess(
  deps: Pick<AppDeps, "db">,
  project: {
    id: string;
    ownerUserId: string | null;
    visibility: ProjectVisibility;
  },
  requested: {
    memberUserIds: readonly string[];
    visibility: ProjectVisibility | undefined;
  },
): void {
  const existingAccessUserIds = new Set([
    ...listProjectMemberUserIds(deps.db, project.id),
    ...(project.ownerUserId === null ? [] : [project.ownerUserId]),
  ]);
  if (
    (requested.visibility !== undefined &&
      requested.visibility !== project.visibility) ||
    requested.memberUserIds.some((userId) => !existingAccessUserIds.has(userId))
  ) {
    throw new ApiError(
      409,
      "project_access_conflict",
      "A project for this folder already exists with different access settings. Open it and change its access in project settings instead.",
    );
  }
}

function buildProjectMembersResponse(
  deps: Pick<AppDeps, "db">,
  project: { id: string; ownerUserId: string | null; createdAt: number },
): ProjectMembersResponse {
  const owner =
    project.ownerUserId === null
      ? null
      : getAuthUserIdentity(deps.db, project.ownerUserId);
  return {
    owner:
      owner === null
        ? null
        : {
            userId: owner.id,
            name: owner.name,
            email: owner.email,
            addedAt: project.createdAt,
          },
    members: listProjectMembers(deps.db, project.id).map((member) => ({
      userId: member.userId,
      name: member.name,
      email: member.email,
      addedAt: member.addedAt,
    })),
  };
}

interface RequireProjectSourceArgs {
  projectId: string;
  sourceId: string;
}

function requireProjectSource(
  deps: Pick<AppDeps, "db">,
  args: RequireProjectSourceArgs,
) {
  const source = getProjectSourceForProject(deps.db, args);
  if (!source) {
    throw new ApiError(404, "invalid_request", "Project source not found");
  }
  return source;
}

function assertPathMatchesHostPlatform(
  deps: Pick<AppDeps, "hub">,
  args: { hostId: string; path: string },
): void {
  const platform = deps.hub.getDaemonPlatformForHost(args.hostId);
  if (platform === null || platform === "unknown") {
    return;
  }
  const isWindowsPath = isWindowsHostPath(args.path);
  if (platform === "win32" && !isWindowsPath) {
    throw new ApiError(
      400,
      "invalid_request",
      "This machine uses Windows paths. Use an absolute path like C:\\Users\\me\\repo.",
    );
  }
  if (platform !== "win32" && isWindowsPath) {
    throw new ApiError(
      400,
      "invalid_request",
      "This machine uses POSIX paths. Use an absolute path like /home/me/repo.",
    );
  }
}

async function inspectProjectGitRemoteBestEffort(
  deps: AppDeps,
  args: { hostId: string; path: string },
): Promise<string | null> {
  try {
    const inspection = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: { type: "project.inspect", path: args.path },
    });
    return inspection.gitRemoteUrl;
  } catch (error) {
    deps.logger.warn(
      { err: error, hostId: args.hostId, path: args.path },
      "Unable to inspect project source; continuing without a Git remote anchor",
    );
    return null;
  }
}

export function registerProjectRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, put, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.projects;
  del(routes.deleteMachineEnvironmentVariable, async (context, payload) => {
    if (getGateAuthKind(context) === "machine")
      throw new ApiError(
        403,
        "forbidden",
        "Machine credentials cannot change project environment settings",
      );
    const project = requirePublicProject(deps.db, context.req.param("id"));
    await deleteMachineEnvironmentVariable(deps.db, payload.name, project.id);
    deps.hub.notifySystem(["config-changed"]);
    return context.json(
      await projectMachineEnvironmentView(deps.db, project.id),
    );
  });

  post(routes.setMachineEnvironmentVariable, async (context, payload) => {
    if (getGateAuthKind(context) === "machine")
      throw new ApiError(
        403,
        "forbidden",
        "Machine credentials cannot change project environment settings",
      );
    const project = requirePublicProject(deps.db, context.req.param("id"));
    await setMachineEnvironmentVariable(
      deps.db,
      deps.config.dataDir,
      payload,
      project.id,
    );
    deps.hub.notifySystem(["config-changed"]);
    return context.json(
      await projectMachineEnvironmentView(deps.db, project.id),
    );
  });

  put(routes.replaceMachineEnvironment, async (context, payload) => {
    if (getGateAuthKind(context) === "machine")
      throw new ApiError(
        403,
        "forbidden",
        "Machine credentials cannot change project environment settings",
      );
    const project = requirePublicProject(deps.db, context.req.param("id"));
    await replaceMachineEnvironment(
      deps.db,
      deps.config.dataDir,
      payload,
      project.id,
    );
    deps.hub.notifySystem(["config-changed"]);
    return context.json(
      await projectMachineEnvironmentView(deps.db, project.id),
    );
  });

  get(routes.machineEnvironment, async (context) => {
    const project = requirePublicProject(deps.db, context.req.param("id"));
    return context.json(
      await projectMachineEnvironmentView(deps.db, project.id),
    );
  });

  get(routes.list, (context, query) => {
    const includes = parseProjectListIncludes(query);
    const principal = requirePrincipal(context);
    const options: ProjectListOptions = {
      includePersonal: query.includePersonal === "true",
      principal,
      visibility: query.visibility ?? null,
    };
    if (includes.has("threads")) {
      return context.json(
        buildProjectsWithThreadsResponse(
          deps,
          options,
          requireThreadViewerId(context),
        ),
      );
    }
    return context.json(
      buildProjectResponsesFromRows(
        deps,
        listDiscoverableProjects(deps, options),
        principal,
      ),
    );
  });

  get(routes.sidebarBootstrap, (context, query) =>
    context.json(
      buildSidebarBootstrapResponse(deps, {
        principal: requirePrincipal(context),
        viewerUserId: requireThreadViewerId(context),
        visibility: query.visibility ?? null,
      }),
    ),
  );

  post(routes.create, async (context, payload) => {
    const { source } = payload;
    if (source.type === "local_path") {
      requireNonDestroyedHostWithStatus(deps, source.hostId);
      assertUsableHostId(deps, { hostId: source.hostId });
      assertPathMatchesHostPlatform(deps, source);
    }
    const principal = requirePrincipal(context);
    const lookupAccess = projectAccessScopeFor(principal);
    const existingProject = getPublicProjectByLocalPathSource(
      deps.db,
      source,
      lookupAccess,
    );
    const memberUserIds = [...new Set(payload.memberUserIds ?? [])];
    if (existingProject) {
      assertExistingProjectMatchesRequestedAccess(deps, existingProject, {
        memberUserIds,
        visibility: payload.visibility,
      });
      return context.json(
        buildProjectResponse(deps, existingProject.id, principal),
        201,
      );
    }
    for (const userId of memberUserIds) {
      requireProjectMemberUser(deps, userId);
    }
    const gitRemoteUrl = await inspectProjectGitRemoteBestEffort(deps, source);
    const { project } = findOrCreateProjectByLocalPathSource(
      deps.db,
      deps.hub,
      {
        name: payload.name,
        source,
        access: {
          ownerUserId: principal.kind === "user" ? principal.userId : null,
          visibility: payload.visibility ?? DEFAULT_PROJECT_VISIBILITY,
          memberUserIds,
        },
      },
      lookupAccess,
    );
    if (gitRemoteUrl !== null) {
      setProjectGitRemoteUrlIfMissing(
        deps.db,
        deps.hub,
        project.id,
        gitRemoteUrl,
      );
    }
    return context.json(buildProjectResponse(deps, project.id, principal), 201);
  });

  get(routes.get, (context) =>
    context.json(
      buildProjectResponsesFromRows(
        deps,
        [requirePublicProject(deps.db, context.req.param("id"))],
        requirePrincipal(context),
      )[0],
    ),
  );

  get(routes.defaultExecutionOptions, (context) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);
    return context.json(getProjectExecutionDefaults(deps.db, { projectId }));
  });

  get(routes.promptHistory, (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);
    const limit = parseBoundedPositiveOptionalInteger({
      defaultValue: PROMPT_HISTORY_ENTRY_LIMIT,
      max: PROMPT_HISTORY_ENTRY_LIMIT,
      name: "limit",
      value: query.limit,
    });

    return context.json(
      listProjectPromptHistory(deps, {
        projectId,
        limit,
        userId: requirePrincipal(context).userId,
      }),
    );
  });

  patch(routes.update, async (context, payload) => {
    const principal = requirePrincipal(context);
    const existing = requirePublicStandardProject(
      deps.db,
      context.req.param("id"),
    );
    assertCanManageProject(deps.db, existing, principal);
    const project = updateProject(deps.db, deps.hub, existing.id, payload);
    if (!project) {
      throw new ApiError(404, "project_not_found", "Project not found");
    }
    if (
      payload.visibility !== undefined &&
      payload.visibility !== existing.visibility
    ) {
      deps.hub.notifyProjectAccessChanged(
        project.id,
        existing.visibility === "public" ? "everyone" : [],
      );
    }
    return context.json(buildProjectResponse(deps, project.id, principal));
  });

  get(routes.listMembers, (context) => {
    const project = requirePublicStandardProject(
      deps.db,
      context.req.param("id"),
    );
    return context.json(buildProjectMembersResponse(deps, project));
  });

  put(routes.addMember, (context) => {
    const principal = requirePrincipal(context);
    const project = requirePublicStandardProject(
      deps.db,
      context.req.param("id"),
    );
    assertCanManageProject(deps.db, project, principal);
    const userId = context.req.param("userId");
    requireProjectMemberUser(deps, userId);
    if (
      userId !== project.ownerUserId &&
      addProjectMember(deps.db, {
        projectId: project.id,
        userId,
        addedByUserId: principal.kind === "user" ? principal.userId : null,
      })
    ) {
      deps.hub.notifyProjectAccessChanged(project.id);
    }
    return context.json(buildProjectMembersResponse(deps, project));
  });

  del(routes.removeMember, (context) => {
    const principal = requirePrincipal(context);
    const project = requirePublicStandardProject(
      deps.db,
      context.req.param("id"),
    );
    assertCanManageProject(deps.db, project, principal);
    const userId = context.req.param("userId");
    if (removeProjectMember(deps.db, { projectId: project.id, userId })) {
      deps.hub.notifyProjectAccessChanged(project.id, [userId]);
    }
    return context.json(buildProjectMembersResponse(deps, project));
  });

  patch(routes.reorder, async (context, payload) => {
    const projectId = context.req.param("id");
    requirePublicStandardProject(deps.db, projectId);
    const principal = requirePrincipal(context);
    return context.json(
      toProjectOrderResponse(
        deps,
        reorderProject({
          access: projectAccessScopeFor(principal),
          db: deps.db,
          notifier: deps.hub,
          projectId,
          previousProjectId: payload.previousProjectId,
          nextProjectId: payload.nextProjectId,
        }),
        principal,
      ),
    );
  });

  del(routes.delete, async (context) => {
    const id = context.req.param("id");
    const project = requireProject(deps.db, id);
    if (project.kind === "personal") {
      throw new ApiError(
        409,
        "invalid_request",
        "The personal project cannot be deleted",
      );
    }
    assertCanManageProject(deps.db, project, requirePrincipal(context));
    beginProjectDeletion(deps, { projectId: id });
    requestProjectDeletionAdvance(deps, { projectId: id });
    return context.json({ ok: true });
  });

  post(routes.createSource, async (context, payload) => {
    const projectId = context.req.param("id");
    const project = requirePublicStandardProject(deps.db, projectId);
    requireNonDestroyedHostWithStatus(deps, payload.hostId);
    assertUsableHostId(deps, { hostId: payload.hostId });
    if (getProjectSourceByHost(deps.db, projectId, payload.hostId)) {
      throw projectSourceHostConflict();
    }
    const requestedPath =
      payload.type === "clone" ? payload.targetPath : payload.path;
    if (requestedPath !== undefined) {
      assertPathMatchesHostPlatform(deps, {
        hostId: payload.hostId,
        path: requestedPath,
      });
    }
    const source =
      payload.type === "clone"
        ? await cloneProjectSourceOnHost(deps, {
            projectId,
            projectName: project.name,
            hostId: payload.hostId,
            remoteUrl: payload.remoteUrl ?? project.gitRemoteUrl,
            ...(payload.targetPath !== undefined
              ? { targetPath: payload.targetPath }
              : {}),
          })
        : registerProjectSourceOnHost(deps, {
            projectId,
            hostId: payload.hostId,
            path: payload.path,
            gitRemoteUrl: await inspectProjectGitRemoteBestEffort(
              deps,
              payload,
            ),
          });
    return context.json(source, 201);
  });

  patch(routes.updateSource, async (context, payload) => {
    const projectId = context.req.param("id");
    const project = requirePublicStandardProject(deps.db, projectId);
    const existing = requireProjectSource(deps, {
      projectId,
      sourceId: context.req.param("sourceId"),
    });
    if (existing.type === "local_path") {
      assertUsableHostId(deps, { hostId: existing.hostId });
      if (payload.path) {
        assertPathMatchesHostPlatform(deps, {
          hostId: existing.hostId,
          path: payload.path,
        });
      }
    }
    if (payload.type !== existing.type) {
      throw new ApiError(
        400,
        "invalid_request",
        `Source type mismatch: source is ${existing.type} but request specifies ${payload.type}`,
      );
    }
    const source = updateProjectSource(
      deps.db,
      deps.hub,
      context.req.param("sourceId"),
      {
        ...(payload.path ? { path: payload.path } : {}),
        ...(payload.isDefault ? { isDefault: payload.isDefault } : {}),
      },
    );
    if (!source) {
      throw new ApiError(404, "invalid_request", "Project source not found");
    }
    if (project.gitRemoteUrl === null && source.type === "local_path") {
      const gitRemoteUrl = await inspectProjectGitRemoteBestEffort(
        deps,
        source,
      );
      if (gitRemoteUrl !== null) {
        setProjectGitRemoteUrlIfMissing(
          deps.db,
          deps.hub,
          projectId,
          gitRemoteUrl,
        );
      }
    }
    return context.json(source);
  });

  del(routes.deleteSource, (context) => {
    const projectId = context.req.param("id");
    const project = requireProject(deps.db, projectId);
    if (project.kind !== "standard") {
      throw new ApiError(404, "project_not_found", "Project not found");
    }
    requireProjectSource(deps, {
      projectId,
      sourceId: context.req.param("sourceId"),
    });
    const sourceCount = countProjectSources(deps.db, { projectId });
    if (sourceCount <= 1 && project.deletedAt === null) {
      throw new ApiError(
        409,
        "invalid_request",
        "Cannot delete the last source of a project",
      );
    }
    const deleted = deleteProjectSource(
      deps.db,
      deps.hub,
      context.req.param("sourceId"),
    );
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Project source not found");
    }
    return context.json({ ok: true });
  });

  get(routes.files, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const limit = parseFileListLimit(query.limit);

    const target = resolveProjectWorkspaceTarget(deps, {
      projectId,
      environmentId: query.environmentId,
      hostId: query.hostId,
    });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.list_files",
        path: target.path,
        ...(query.query ? { query: query.query } : {}),
        limit,
        includeHidden: WORKSPACE_PATH_LIST_INCLUDE_HIDDEN,
        respectGitIgnore: true,
        excludeNames: [...DEFAULT_PATH_LIST_EXCLUDE_NAMES],
      },
    });
    return context.json({ files: result.files, truncated: result.truncated });
  });

  get(routes.paths, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const limit = parseFileListLimit(query.limit);

    const target = resolveProjectWorkspaceTarget(deps, {
      projectId,
      environmentId: query.environmentId,
      hostId: query.hostId,
    });
    const inclusion = parsePathKindInclusion({
      includeFiles: query.includeFiles,
      includeDirectories: query.includeDirectories,
    });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.list_paths",
        path: target.path,
        ...(query.query ? { query: query.query } : {}),
        limit,
        includeFiles: inclusion.includeFiles,
        includeDirectories: inclusion.includeDirectories,
        includeHidden: WORKSPACE_PATH_LIST_INCLUDE_HIDDEN,
        respectGitIgnore: true,
        excludeNames: [...DEFAULT_PATH_LIST_EXCLUDE_NAMES],
      },
    });
    return context.json({ paths: result.paths, truncated: result.truncated });
  });

  get(routes.commands, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const registration = deps.providerRegistry.get(query.provider);
    if (registration === null || !providerHasCommandSurface(registration)) {
      return context.json({ commands: [] });
    }

    const workspace = resolveProjectCommandWorkspace(deps, {
      projectId,
      environmentId: query.environmentId,
      hostId: query.hostId,
    });
    const listProviderCommands = async () => {
      if (!providerHasNativeRootSurface(registration)) {
        return { commands: [] };
      }
      return scanProviderNativeRoots(deps, {
        type: "host.list_commands",
        registration,
        hostId: workspace.hostId,
        cwd: workspace.cwd,
      });
    };
    const readWorkspaceSkills = async (): Promise<
      Pick<WorkspaceAgentContext, "projectSkillSources" | "sharedSkills">
    > =>
      workspace.cwd === null
        ? {
            projectSkillSources: [],
            sharedSkills: await resolveSharedSkills(deps, {
              hostId: workspace.hostId,
              cwd: null,
            }),
          }
        : readWorkspaceAgentContext(deps, {
            hostId: workspace.hostId,
            workspacePath: workspace.cwd,
            includeAgentInstructions: false,
          });
    const [result, workspaceSkills] = await Promise.all([
      listProviderCommands(),
      readWorkspaceSkills(),
    ]);
    const skillCatalog = resolveSkillCatalog(deps, {
      projectSkillSources: workspaceSkills.projectSkillSources,
      sharedSkillSources: workspaceSkills.sharedSkills.runtimeSources,
    });
    return context.json(
      buildCommandListResponse({
        commands: result.commands,
        includeBuiltinCompact: deps.providerRegistry.supportsManualCompaction(
          query.provider,
        ),
        skillCatalog,
      }),
    );
  });

  const requireProjectSkillWorkspace = (
    projectId: string,
    environmentId: string | null,
  ) => {
    requirePublicProject(deps.db, projectId);
    return resolveProjectCommandWorkspace(deps, {
      projectId,
      environmentId: environmentId ?? undefined,
    });
  };

  get(routes.skills, async (context, query) => {
    const workspace = requireProjectSkillWorkspace(
      context.req.param("id"),
      query.environmentId,
    );
    const skills = await listProjectSkills(deps, { workspace });
    return context.json({ skills });
  });

  del(routes.deleteSkill, async (context, payload) => {
    const workspace = requireProjectSkillWorkspace(
      context.req.param("id"),
      payload.environmentId,
    );
    const deletedPath = await deleteProjectSkill(deps, {
      skillId: payload.skillId,
      workspace,
    });
    return context.json({ deletedPath });
  });

  get(routes.skillContent, async (context, query) => {
    const workspace = requireProjectSkillWorkspace(
      context.req.param("id"),
      query.environmentId,
    );
    const content = await readProjectSkill(deps, {
      skillId: query.skillId,
      path: query.path,
      workspace,
    });
    return context.json(content);
  });

  get(routes.skillFiles, async (context, query) => {
    const workspace = requireProjectSkillWorkspace(
      context.req.param("id"),
      query.environmentId,
    );
    return context.json(
      await listProjectSkillFiles(deps, {
        skillId: query.skillId,
        workspace,
      }),
    );
  });

  patch(routes.updateSkill, async (context, payload) => {
    const workspace = requireProjectSkillWorkspace(
      context.req.param("id"),
      payload.environmentId,
    );
    const result = await writeProjectSkill(deps, {
      skillId: payload.skillId,
      content: payload.content,
      revision: payload.revision,
      workspace,
    });
    return context.json(result);
  });

  const readProjectBranches = async (
    projectId: string,
    query: ProjectBranchesQuery,
    remoteRefresh: "background" | "blocking",
  ) => {
    requirePublicStandardProject(deps.db, projectId);

    const source = resolveProjectWorkspaceTarget(deps, {
      projectId,
      hostId: query.hostId,
    });
    const branchQuery = normalizeBranchQuery(query.query);
    const selectedBranch = normalizeBranchQuery(query.selectedBranch);
    const inspectionPromise = callHostRetryableOnlineRpc(deps, {
      hostId: source.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.inspect_git_source",
        path: source.path,
        remoteRefresh,
      },
    });
    const readBranchOptions = () =>
      callHostRetryableOnlineRpc(deps, {
        hostId: source.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_branch_options",
          path: source.path,
          ...(branchQuery ? { query: branchQuery } : {}),
          ...(selectedBranch ? { selectedBranch } : {}),
          limit: parseBranchListLimit(query.limit),
          remoteRefresh: "none",
        },
      });
    const branchOptionsPromise =
      remoteRefresh === "background"
        ? readBranchOptions()
        : inspectionPromise.then(readBranchOptions);
    const [inspection, branchOptions] = await Promise.all([
      inspectionPromise,
      branchOptionsPromise,
    ]);
    const result = { ...inspection, ...branchOptions };
    return {
      ...result,
      defaultWorktreeBaseBranch: resolveDefaultWorktreeBaseBranch(result),
    };
  };

  get(routes.branches, async (context, query) =>
    context.json(
      await readProjectBranches(context.req.param("id"), query, "blocking"),
    ),
  );
  get(routes.branchOptions, async (context, query) =>
    context.json(
      await readProjectBranches(context.req.param("id"), query, "background"),
    ),
  );

  post(routes.uploadAttachment, async (context) => {
    requirePublicProject(deps.db, context.req.param("id"));
    const formData = await context.req.formData();
    const fields = [...formData.keys()];
    if (fields.length === 0) {
      throw new ApiError(400, "invalid_request", "Attachment file is required");
    }
    if (fields.length !== 1 || fields[0] !== "file") {
      throw new ApiError(
        400,
        "invalid_request",
        'Attachment upload accepts exactly one multipart field named "file"',
      );
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "invalid_request", "Attachment file is required");
    }
    if (file.name.trim().length === 0) {
      throw new ApiError(
        400,
        "invalid_request",
        "Attachment filename is required",
      );
    }
    return context.json(
      await storeAttachment(
        deps.db,
        deps.config.dataDir,
        context.req.param("id"),
        file,
      ),
      201,
    );
  });

  post(routes.copyAttachments, async (context, payload) => {
    const targetProjectId = context.req.param("id");
    requirePublicProject(deps.db, targetProjectId);
    requirePublicProject(deps.db, payload.sourceProjectId);
    await copyProjectAttachments(
      deps.db,
      deps.config.dataDir,
      payload.sourceProjectId,
      targetProjectId,
      payload.paths,
    );
    return context.json({ ok: true as const });
  });

  get(routes.attachmentContent, async (context, query) => {
    requirePublicProject(deps.db, context.req.param("id"));
    const attachment = await readAttachment(
      deps.config.dataDir,
      context.req.param("id"),
      query.path,
    );
    const headers = new Headers({
      "cache-control": ATTACHMENT_CONTENT_CACHE_CONTROL,
      "content-type": attachment.mimeType ?? "application/octet-stream",
      etag: attachment.etag,
    });
    if (
      requestMatchesEntityTag(
        context.req.header("if-none-match"),
        attachment.etag,
      )
    ) {
      return new Response(null, { status: 304, headers });
    }
    headers.set("content-length", String(attachment.content.byteLength));
    return new Response(new Uint8Array(attachment.content), {
      status: 200,
      headers,
    });
  });
}
