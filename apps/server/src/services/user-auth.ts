import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, like, lt, ne } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  authAccounts,
  authApiKeys,
  authSessions,
  authUsers,
  authVerifications,
  type DbConnection,
} from "@bb/db";
import { LOCAL_OWNER_USER_ID, userRoleSchema, type UserRole } from "@bb/domain";
import type { AuthUser, PersonalAccessTokenSummary } from "@bb/server-contract";
import { readOrCreateSecretFile, writeSecretFile } from "@bb/secret-storage";
import { z } from "zod";
import { SERVER_SERVICE_TOKEN_FILE_NAME } from "@bb/config/server";
import { join } from "node:path";
import { MACHINE_AUTH_SYSTEM_USER_ID } from "./machine-auth.js";
import type { ServerLogger } from "../types.js";

const AUTH_SECRET_FILE_NAME = "auth-secret";
export const USER_PAT_CONFIG_ID = "user-pat";
const USER_PAT_PREFIX = "bbpat_";
const CREDENTIAL_PROVIDER_ID = "credential";
const INVITE_IDENTIFIER_PREFIX = "bb-invite:";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAT_CACHE_TTL_MS = 30_000;
const PAT_CACHE_MAX_ENTRIES = 1024;
const SESSION_COOKIE_PREFIX = "bb";

export type PrincipalKind = "user" | "local" | "machine";

export interface RequestPrincipal {
  kind: PrincipalKind;
  role: UserRole;
  userId: string;
}

export const LOCAL_OWNER_PRINCIPAL: RequestPrincipal = {
  kind: "local",
  role: "admin",
  userId: LOCAL_OWNER_USER_ID,
};

const SERVICE_PRINCIPAL: RequestPrincipal = {
  kind: "machine",
  role: "admin",
  userId: LOCAL_OWNER_USER_ID,
};

const inviteValueSchema = z
  .object({
    role: userRoleSchema,
    email: z.string().nullable(),
    createdByUserId: z.string().min(1),
  })
  .strict();

export class UserAuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UserAuthError";
  }
}

export interface UserAuthResult {
  setCookieHeaders: string[];
  user: AuthUser;
}

export interface SignUpArgs {
  email: string;
  inviteToken: string | null;
  name: string;
  password: string;
}

export interface SignInArgs {
  email: string;
  password: string;
}

export interface CreateInviteArgs {
  createdByUserId: string;
  email: string | null;
  role: UserRole;
}

export interface CreatedInvite {
  email: string | null;
  expiresAt: number;
  role: UserRole;
  token: string;
}

export interface CreatedPersonalAccessToken {
  summary: PersonalAccessTokenSummary;
  token: string;
}

export interface UserAuthService {
  readonly serviceToken: string;
  createInvite(args: CreateInviteArgs): Promise<CreatedInvite>;
  createPersonalAccessToken(args: {
    name: string;
    userId: string;
  }): Promise<CreatedPersonalAccessToken>;
  getUser(userId: string): AuthUser | null;
  listUsers(): AuthUser[];
  listPersonalAccessTokens(userId: string): PersonalAccessTokenSummary[];
  needsBootstrap(): boolean;
  resolvePrincipal(headers: Headers): Promise<RequestPrincipal | null>;
  revokePersonalAccessToken(args: { id: string; userId: string }): boolean;
  signIn(args: SignInArgs): Promise<UserAuthResult>;
  signOut(headers: Headers): Promise<string[]>;
  signUp(args: SignUpArgs): Promise<UserAuthResult>;
}

interface CreateUserAuthServiceArgs {
  dataDir: string;
  db: DbConnection;
  logger: ServerLogger;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

function bearerToken(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function errorStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const statusCode = Reflect.get(error, "statusCode");
  return typeof statusCode === "number" ? statusCode : null;
}

function setCookieHeaders(headers: Headers): string[] {
  return headers.getSetCookie();
}

export async function createUserAuthService(
  args: CreateUserAuthServiceArgs,
): Promise<UserAuthService> {
  const secret = await readOrCreateSecretFile({
    bytes: 32,
    dataDir: args.dataDir,
    encoding: "hex",
    fileName: AUTH_SECRET_FILE_NAME,
  });
  let registrationRole: UserRole = "member";
  const auth = betterAuth({
    baseURL: "http://localhost",
    secret,
    database: drizzleAdapter(args.db, {
      provider: "sqlite",
      schema: {
        account: authAccounts,
        apikey: authApiKeys,
        session: authSessions,
        user: authUsers,
        verification: authVerifications,
      },
    }),
    advanced: {
      cookiePrefix: SESSION_COOKIE_PREFIX,
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: { ...user, role: registrationRole },
          }),
        },
      },
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "member",
          input: false,
        },
      },
    },
    plugins: [
      apiKey([
        {
          configId: USER_PAT_CONFIG_ID,
          defaultPrefix: USER_PAT_PREFIX,
          enableMetadata: false,
          references: "user",
          requireName: false,
        },
      ]),
    ],
  });
  const serviceToken = randomBytes(32).toString("base64url");
  await writeSecretFile(
    join(args.dataDir, SERVER_SERVICE_TOKEN_FILE_NAME),
    serviceToken,
  );
  const patCache = new Map<string, { userId: string; validUntilMs: number }>();
  let signUpQueue: Promise<unknown> = Promise.resolve();

  function serializeSignUp<T>(work: () => Promise<T>): Promise<T> {
    const next = signUpQueue.then(work, work);
    signUpQueue = next.catch(() => undefined);
    return next;
  }

  function getUser(userId: string): AuthUser | null {
    const row = args.db
      .select({
        id: authUsers.id,
        name: authUsers.name,
        email: authUsers.email,
        role: authUsers.role,
      })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .get();
    return row ?? null;
  }

  function listUsers(): AuthUser[] {
    return args.db
      .select({
        id: authUsers.id,
        name: authUsers.name,
        email: authUsers.email,
        role: authUsers.role,
      })
      .from(authUsers)
      .where(ne(authUsers.id, MACHINE_AUTH_SYSTEM_USER_ID))
      .orderBy(asc(authUsers.name), asc(authUsers.id))
      .all();
  }

  function principalForUser(
    userId: string,
    kind: PrincipalKind,
  ): RequestPrincipal | null {
    const user = getUser(userId);
    return user === null ? null : { kind, role: user.role, userId: user.id };
  }

  function needsBootstrap(): boolean {
    const row = args.db
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID))
      .limit(1)
      .get();
    return row === undefined;
  }

  async function verifyPersonalAccessToken(
    token: string,
  ): Promise<string | null> {
    const cacheKey = sha256Hex(token);
    const now = Date.now();
    const cached = patCache.get(cacheKey);
    if (cached !== undefined && now < cached.validUntilMs) {
      return cached.userId;
    }
    patCache.delete(cacheKey);
    const result = await auth.api.verifyApiKey({
      body: { configId: USER_PAT_CONFIG_ID, key: token },
    });
    if (!result.valid || !result.key || !result.key.enabled) {
      return null;
    }
    const expiresAtMs = result.key.expiresAt?.getTime() ?? null;
    if (expiresAtMs !== null && Date.now() >= expiresAtMs) {
      return null;
    }
    patCache.set(cacheKey, {
      userId: result.key.referenceId,
      validUntilMs: Math.min(now + PAT_CACHE_TTL_MS, expiresAtMs ?? Infinity),
    });
    while (patCache.size > PAT_CACHE_MAX_ENTRIES) {
      const oldest = patCache.keys().next();
      if (!oldest.done) patCache.delete(oldest.value);
    }
    return result.key.referenceId;
  }

  async function resolvePrincipal(
    headers: Headers,
  ): Promise<RequestPrincipal | null> {
    const token = bearerToken(headers);
    if (token !== null) {
      if (timingSafeEqualStrings(token, serviceToken)) {
        return SERVICE_PRINCIPAL;
      }
      if (!token.startsWith(USER_PAT_PREFIX)) {
        return null;
      }
      const userId = await verifyPersonalAccessToken(token);
      return userId === null ? null : principalForUser(userId, "user");
    }
    if (headers.get("cookie") === null) {
      return null;
    }
    const session = await auth.api.getSession({ headers });
    if (session === null) {
      return null;
    }
    return principalForUser(session.user.id, "user");
  }

  function findInvite(token: string) {
    const row = args.db
      .select()
      .from(authVerifications)
      .where(
        eq(
          authVerifications.identifier,
          `${INVITE_IDENTIFIER_PREFIX}${sha256Hex(token)}`,
        ),
      )
      .get();
    if (row === undefined || row.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      return null;
    }
    const parsed = inviteValueSchema.safeParse(value);
    if (!parsed.success) {
      args.logger.warn({ inviteId: row.id }, "Ignoring malformed user invite");
      return null;
    }
    return { id: row.id, ...parsed.data };
  }

  async function signUp(signUpArgs: SignUpArgs): Promise<UserAuthResult> {
    return serializeSignUp(async () => {
      const email = normalizeEmail(signUpArgs.email);
      const bootstrap = needsBootstrap();
      const invite =
        bootstrap || signUpArgs.inviteToken === null
          ? null
          : findInvite(signUpArgs.inviteToken);
      if (!bootstrap && invite === null) {
        throw new UserAuthError(
          403,
          "invite_required",
          "Registration on this server requires a valid invite",
        );
      }
      if (invite !== null && invite.email !== null && invite.email !== email) {
        throw new UserAuthError(
          403,
          "invite_email_mismatch",
          "This invite was issued for a different email address",
        );
      }
      let result;
      registrationRole = bootstrap ? "admin" : (invite?.role ?? "member");
      try {
        result = await auth.api.signUpEmail({
          body: { email, name: signUpArgs.name, password: signUpArgs.password },
          returnHeaders: true,
        });
      } catch (error) {
        const status = errorStatusCode(error);
        if (status === 422 || status === 409) {
          throw new UserAuthError(
            409,
            "user_exists",
            "A user with this email already exists",
          );
        }
        throw error;
      }
      const userId = result.response.user.id;
      if (invite !== null) {
        args.db
          .delete(authVerifications)
          .where(eq(authVerifications.id, invite.id))
          .run();
      }
      const user = getUser(userId);
      if (user === null) {
        throw new Error("Registered user is missing");
      }
      return { setCookieHeaders: setCookieHeaders(result.headers), user };
    });
  }

  async function signIn(signInArgs: SignInArgs): Promise<UserAuthResult> {
    let result;
    try {
      result = await auth.api.signInEmail({
        body: {
          email: normalizeEmail(signInArgs.email),
          password: signInArgs.password,
        },
        returnHeaders: true,
      });
    } catch (error) {
      const status = errorStatusCode(error);
      if (status === 401 || status === 400 || status === 403) {
        throw new UserAuthError(
          401,
          "invalid_credentials",
          "Invalid email or password",
        );
      }
      throw error;
    }
    const user = getUser(result.response.user.id);
    if (user === null) {
      throw new UserAuthError(
        401,
        "invalid_credentials",
        "Invalid email or password",
      );
    }
    return { setCookieHeaders: setCookieHeaders(result.headers), user };
  }

  async function signOut(headers: Headers): Promise<string[]> {
    const cookie = headers.get("cookie");
    if (cookie === null) return [];
    try {
      const result = await auth.api.signOut({
        headers: new Headers({ cookie }),
        returnHeaders: true,
      });
      return setCookieHeaders(result.headers);
    } catch (error) {
      const status = errorStatusCode(error);
      if (status !== null && status < 500) return [];
      throw error;
    }
  }

  function toTokenSummary(row: {
    createdAt: Date;
    id: string;
    lastRequest: Date | null;
    name: string | null;
    start: string | null;
  }): PersonalAccessTokenSummary {
    return {
      id: row.id,
      name: row.name ?? "",
      start: row.start,
      createdAt: row.createdAt.getTime(),
      lastUsedAt: row.lastRequest?.getTime() ?? null,
    };
  }

  async function createPersonalAccessToken(createArgs: {
    name: string;
    userId: string;
  }): Promise<CreatedPersonalAccessToken> {
    const created = await auth.api.createApiKey({
      body: {
        configId: USER_PAT_CONFIG_ID,
        name: createArgs.name,
        rateLimitEnabled: false,
        userId: createArgs.userId,
      },
    });
    return {
      token: created.key,
      summary: toTokenSummary({
        createdAt: created.createdAt,
        id: created.id,
        lastRequest: null,
        name: created.name,
        start: created.start,
      }),
    };
  }

  function listPersonalAccessTokens(
    userId: string,
  ): PersonalAccessTokenSummary[] {
    return args.db
      .select({
        createdAt: authApiKeys.createdAt,
        id: authApiKeys.id,
        lastRequest: authApiKeys.lastRequest,
        name: authApiKeys.name,
        start: authApiKeys.start,
      })
      .from(authApiKeys)
      .where(
        and(
          eq(authApiKeys.configId, USER_PAT_CONFIG_ID),
          eq(authApiKeys.referenceId, userId),
          eq(authApiKeys.enabled, true),
        ),
      )
      .orderBy(desc(authApiKeys.createdAt))
      .all()
      .map(toTokenSummary);
  }

  function revokePersonalAccessToken(revokeArgs: {
    id: string;
    userId: string;
  }): boolean {
    const result = args.db
      .delete(authApiKeys)
      .where(
        and(
          eq(authApiKeys.id, revokeArgs.id),
          eq(authApiKeys.configId, USER_PAT_CONFIG_ID),
          eq(authApiKeys.referenceId, revokeArgs.userId),
        ),
      )
      .run();
    patCache.clear();
    return result.changes > 0;
  }

  async function createInvite(
    inviteArgs: CreateInviteArgs,
  ): Promise<CreatedInvite> {
    const token = `bbinv_${randomBytes(24).toString("base64url")}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    const email =
      inviteArgs.email === null ? null : normalizeEmail(inviteArgs.email);
    args.db
      .delete(authVerifications)
      .where(
        and(
          like(authVerifications.identifier, `${INVITE_IDENTIFIER_PREFIX}%`),
          lt(authVerifications.expiresAt, now),
        ),
      )
      .run();
    args.db
      .insert(authVerifications)
      .values({
        id: randomBytes(16).toString("hex"),
        identifier: `${INVITE_IDENTIFIER_PREFIX}${sha256Hex(token)}`,
        value: JSON.stringify({
          role: inviteArgs.role,
          email,
          createdByUserId: inviteArgs.createdByUserId,
        }),
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return {
      email,
      expiresAt: expiresAt.getTime(),
      role: inviteArgs.role,
      token,
    };
  }

  return {
    serviceToken,
    createInvite,
    createPersonalAccessToken,
    getUser,
    listUsers,
    listPersonalAccessTokens,
    needsBootstrap,
    resolvePrincipal,
    revokePersonalAccessToken,
    signIn,
    signOut,
    signUp,
  };
}
