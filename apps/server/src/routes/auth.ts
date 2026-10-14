import type { Hono } from "hono";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import {
  assertAdmin,
  getRequestPrincipal,
  requirePrincipal,
} from "../request-context.js";
import { UserAuthError } from "../services/user-auth.js";
import type { ServerAppDeps } from "../types.js";

type AuthRouteDeps = Pick<ServerAppDeps, "config" | "userAuth">;

interface ResponseHeaderWriter {
  header(name: string, value: string, options: { append: boolean }): void;
}

function appendSetCookieHeaders(
  context: ResponseHeaderWriter,
  headers: string[],
): void {
  for (const header of headers) {
    context.header("set-cookie", header, { append: true });
  }
}

function toApiError(error: unknown): unknown {
  return error instanceof UserAuthError
    ? new ApiError(error.status, error.code, error.message)
    : error;
}

function assertMultiUserMode(deps: AuthRouteDeps): void {
  if (deps.config.authMode !== "multi") {
    throw new ApiError(
      409,
      "auth_mode_local",
      "This server runs in local auth mode; set BB_AUTH_MODE=multi to enable accounts",
    );
  }
}

export function registerAuthRoutes(app: Hono, deps: AuthRouteDeps): void {
  const { del, get, post, put } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.auth;

  get(routes.session, (context) => {
    const principal = getRequestPrincipal(context);
    return context.json({
      authMode: deps.config.authMode,
      needsBootstrap:
        deps.config.authMode === "multi" && deps.userAuth.needsBootstrap(),
      principalKind: principal?.kind ?? null,
      user: principal === null ? null : deps.userAuth.getUser(principal.userId),
    });
  });

  post(routes.signUp, async (context, payload) => {
    assertMultiUserMode(deps);
    try {
      const result = await deps.userAuth.signUp({
        email: payload.email,
        inviteToken: payload.inviteToken ?? null,
        name: payload.name,
        password: payload.password,
      });
      appendSetCookieHeaders(context, result.setCookieHeaders);
      return context.json({ user: result.user }, 201);
    } catch (error) {
      throw toApiError(error);
    }
  });

  post(routes.signIn, async (context, payload) => {
    assertMultiUserMode(deps);
    try {
      const result = await deps.userAuth.signIn(payload);
      appendSetCookieHeaders(context, result.setCookieHeaders);
      return context.json({ user: result.user });
    } catch (error) {
      throw toApiError(error);
    }
  });

  post(routes.signOut, async (context) => {
    appendSetCookieHeaders(
      context,
      await deps.userAuth.signOut(context.req.raw.headers),
    );
    return context.json({ ok: true as const });
  });

  get(routes.listTokens, (context) => {
    const principal = requirePrincipal(context);
    return context.json({
      tokens: deps.userAuth.listPersonalAccessTokens(principal.userId),
    });
  });

  post(routes.createToken, async (context, payload) => {
    const principal = requirePrincipal(context);
    const created = await deps.userAuth.createPersonalAccessToken({
      name: payload.name,
      userId: principal.userId,
    });
    return context.json(created, 201);
  });

  del(routes.revokeToken, (context) => {
    const principal = requirePrincipal(context);
    const revoked = deps.userAuth.revokePersonalAccessToken({
      id: context.req.param("id"),
      userId: principal.userId,
    });
    if (!revoked) {
      throw new ApiError(404, "token_not_found", "Token not found");
    }
    return context.json({ ok: true as const });
  });

  get(publicApiRoutes.users.list, (context) => {
    assertAdmin(context);
    return context.json({ users: deps.userAuth.listUsers() });
  });

  get(publicApiRoutes.me, (context) => {
    const principal = requirePrincipal(context);
    const user = deps.userAuth.getUser(principal.userId);
    if (user === null) throw new ApiError(401, "unauthorized", "Unauthorized");
    return context.json({ user });
  });

  get(publicApiRoutes.users.directory, (context) => {
    requirePrincipal(context);
    return context.json({ users: deps.userAuth.listUsers() });
  });

  put(publicApiRoutes.users.updateRole, (context, payload) => {
    assertAdmin(context);
    try {
      return context.json({
        user: deps.userAuth.updateUserRole(
          context.req.param("id"),
          payload.role,
        ),
      });
    } catch (error) {
      throw toApiError(error);
    }
  });

  del(publicApiRoutes.users.remove, (context) => {
    assertAdmin(context);
    try {
      deps.userAuth.removeUser(context.req.param("id"));
    } catch (error) {
      throw toApiError(error);
    }
    return context.json({ ok: true as const });
  });

  get(routes.listInvites, (context) => {
    assertAdmin(context);
    return context.json({ invites: deps.userAuth.listInvites() });
  });

  del(routes.revokeInvite, (context) => {
    assertAdmin(context);
    if (!deps.userAuth.revokeInvite(context.req.param("id")))
      throw new ApiError(404, "invite_not_found", "Invite not found");
    return context.json({ ok: true as const });
  });

  post(routes.acceptInvite, async (context, payload) => {
    assertMultiUserMode(deps);
    try {
      const result = await deps.userAuth.signUp(payload);
      appendSetCookieHeaders(context, result.setCookieHeaders);
      return context.json({ user: result.user }, 201);
    } catch (error) {
      throw toApiError(error);
    }
  });

  post(routes.createInvite, async (context, payload) => {
    const principal = assertAdmin(context);
    const invite = await deps.userAuth.createInvite({
      createdByUserId: principal.userId,
      email: payload.email ?? null,
      role: payload.role ?? "member",
    });
    return context.json(invite, 201);
  });
}
