import { GATE_IDENTITY_HEADER, verifyGateIdentity } from "@bb/tunnel-contract";
import {
  createHash,
  createHmac,
  randomUUID,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, asc, desc, eq, gt, like, lt, ne, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  getPluginKvValue,
  authAccounts,
  authApiKeys,
  authSessions,
  authUsers,
  authVerifications,
  deleteQueuedThreadMessagesByAuthorInTransaction,
  type DbConnection,
} from "@bb/db";
import {
  LOCAL_OWNER_USER_ID,
  roleCeilingValues,
  userRoleSchema,
  type RoleCeiling,
  type UserRole,
} from "@bb/domain";
import type {
  AuthUser,
  PersonalAccessTokenSummary,
  UserInviteSummary,
} from "@bb/server-contract";
import { readOrCreateSecretFile, writeSecretFile } from "@bb/secret-storage";
import { z } from "zod";
import { SERVER_SERVICE_TOKEN_FILE_NAME } from "@bb/config/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MACHINE_AUTH_SYSTEM_USER_ID } from "./machine-auth.js";
import {
  createAuthAttemptLimiter,
  type AuthAttemptLimiter,
} from "./auth-attempt-limiter.js";
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
  roleCeiling: RoleCeiling | null;
  userId: string;
}

export interface AuthenticatedCredential {
  principal: RequestPrincipal;
  isActive(): Promise<boolean>;
}

export const LOCAL_OWNER_PRINCIPAL: RequestPrincipal = {
  kind: "local",
  role: "admin",
  roleCeiling: null,
  userId: LOCAL_OWNER_USER_ID,
};

const SERVICE_PRINCIPAL: RequestPrincipal = {
  kind: "machine",
  role: "admin",
  roleCeiling: null,
  userId: LOCAL_OWNER_USER_ID,
};

const inviteValueSchema = z
  .object({
    role: userRoleSchema,
    email: z.string().nullable(),
    createdByUserId: z.string().min(1),
  })
  .strict();

const connectCredentialSchema = z.object({
  credential: z.string().min(1),
  serverId: z.string().min(1),
});

const shellTokenPayloadSchema = z
  .object({
    userId: z.string().min(1),
    expiresAt: z.number().int().positive(),
    roleCeiling: z.enum(roleCeilingValues).optional(),
  })
  .strict();
const SHELL_TOKEN_PREFIX = "bbshell_";
const SHELL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function issueThreadShellToken(
  dataDir: string,
  args: { userId: string; roleCeiling: RoleCeiling | null },
): Promise<string> {
  const secret = (
    await readFile(join(dataDir, AUTH_SECRET_FILE_NAME), "utf8")
  ).trim();
  const payload = Buffer.from(
    JSON.stringify({
      userId: args.userId,
      expiresAt: Date.now() + SHELL_TOKEN_TTL_MS,
      ...(args.roleCeiling === null ? {} : { roleCeiling: args.roleCeiling }),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${SHELL_TOKEN_PREFIX}${payload}.${signature}`;
}

export function isSystemUserId(userId: string): boolean {
  return (
    userId === LOCAL_OWNER_USER_ID || userId === MACHINE_AUTH_SYSTEM_USER_ID
  );
}

export function readUserRole(
  db: DbConnection,
  userId: string,
): UserRole | null {
  return (
    db
      .select({ role: authUsers.role })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .get()?.role ?? null
  );
}

export class UserAuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409 | 429,
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
  id: string;
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
  listInvites(): UserInviteSummary[];
  revokeInvite(id: string): boolean;
  updateUserRole(userId: string, role: UserRole): AuthUser;
  removeUser(userId: string): string[];
  listPersonalAccessTokens(userId: string): PersonalAccessTokenSummary[];
  needsBootstrap(): boolean;
  authenticate(headers: Headers): Promise<AuthenticatedCredential | null>;
  onAuthorizationChange(listener: () => void): () => void;
  resolvePrincipal(headers: Headers): Promise<RequestPrincipal | null>;
  revokePersonalAccessToken(args: { id: string; userId: string }): boolean;
  signIn(args: SignInArgs): Promise<UserAuthResult>;
  signOut(headers: Headers): Promise<string[]>;
  signUp(args: SignUpArgs): Promise<UserAuthResult>;
}

interface CreateUserAuthServiceArgs {
  dataDir: string;
  db: DbConnection;
  attemptLimiter?: AuthAttemptLimiter;
  logger: ServerLogger;
  secureCookies: boolean;
}

function throttled(retryAfterMs: number): UserAuthError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new UserAuthError(
    429,
    "rate_limited",
    `Too many sign-in attempts. Try again in ${seconds} seconds.`,
  );
}

export function usesSecureSessionCookies(appUrl: string | undefined): boolean {
  if (appUrl === undefined) return false;
  try {
    return new URL(appUrl).protocol === "https:";
  } catch {
    return false;
  }
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
      useSecureCookies: args.secureCookies,
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
  const attemptLimiter = args.attemptLimiter ?? createAuthAttemptLimiter();
  const authorizationListeners = new Set<() => void>();

  function onAuthorizationChange(listener: () => void): () => void {
    authorizationListeners.add(listener);
    return () => {
      authorizationListeners.delete(listener);
    };
  }

  function notifyAuthorizationChange(): void {
    for (const listener of authorizationListeners) {
      try {
        listener();
      } catch (error) {
        args.logger.warn(
          `Authorization change listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
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

  function assertMutableUser(userId: string, losingAdmin: boolean): AuthUser {
    if (
      userId === LOCAL_OWNER_USER_ID ||
      userId === MACHINE_AUTH_SYSTEM_USER_ID
    ) {
      throw new UserAuthError(
        409,
        "protected_user",
        "System users cannot be changed or removed",
      );
    }
    const user = getUser(userId);
    if (user === null)
      throw new UserAuthError(404, "user_not_found", "User not found");
    if (losingAdmin && user.role === "admin") {
      const otherAdmin = args.db
        .select({ id: authUsers.id })
        .from(authUsers)
        .innerJoin(authAccounts, eq(authAccounts.userId, authUsers.id))
        .where(
          and(
            eq(authUsers.role, "admin"),
            ne(authUsers.id, userId),
            eq(authAccounts.providerId, CREDENTIAL_PROVIDER_ID),
          ),
        )
        .limit(1)
        .get();
      if (otherAdmin === undefined)
        throw new UserAuthError(
          409,
          "last_admin",
          "The last account admin cannot be removed or demoted",
        );
    }
    return user;
  }

  function updateUserRole(userId: string, role: UserRole): AuthUser {
    const updated = args.db.transaction(() => {
      const user = assertMutableUser(userId, role !== "admin");
      args.db
        .update(authUsers)
        .set({ role, updatedAt: new Date() })
        .where(eq(authUsers.id, userId))
        .run();
      return { ...user, role };
    });
    notifyAuthorizationChange();
    return updated;
  }

  function removeUser(userId: string): string[] {
    const queueChangedThreadIds = args.db.transaction((tx) => {
      assertMutableUser(userId, true);
      const threadIds = deleteQueuedThreadMessagesByAuthorInTransaction(
        tx,
        userId,
      );
      tx.delete(authUsers).where(eq(authUsers.id, userId)).run();
      return threadIds;
    });
    patCache.clear();
    notifyAuthorizationChange();
    return queueChangedThreadIds;
  }

  function listInvites(): UserInviteSummary[] {
    return args.db
      .select()
      .from(authVerifications)
      .where(
        and(
          like(authVerifications.identifier, `${INVITE_IDENTIFIER_PREFIX}%`),
          gt(authVerifications.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(authVerifications.createdAt))
      .all()
      .flatMap((row) => {
        let value: unknown;
        try {
          value = JSON.parse(row.value);
        } catch {
          return [];
        }
        const parsed = inviteValueSchema.safeParse(value);
        return parsed.success
          ? [
              {
                id: row.id,
                ...parsed.data,
                createdAt: row.createdAt.getTime(),
                expiresAt: row.expiresAt.getTime(),
              },
            ]
          : [];
      });
  }

  function revokeInvite(id: string): boolean {
    return (
      args.db
        .delete(authVerifications)
        .where(
          and(
            eq(authVerifications.id, id),
            like(authVerifications.identifier, `${INVITE_IDENTIFIER_PREFIX}%`),
          ),
        )
        .run().changes > 0
    );
  }

  function principalForUser(
    userId: string,
    kind: PrincipalKind,
  ): RequestPrincipal | null {
    const user = getUser(userId);
    return user === null
      ? null
      : { kind, role: user.role, roleCeiling: null, userId: user.id };
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

  function principalStillAuthorized(principal: RequestPrincipal): boolean {
    const user = getUser(principal.userId);
    return user !== null && user.role === principal.role;
  }

  function credentialFor(
    principal: RequestPrincipal | null,
    isCredentialActive: () => boolean | Promise<boolean>,
  ): AuthenticatedCredential | null {
    if (principal === null) return null;
    return {
      principal,
      isActive: async () =>
        principalStillAuthorized(principal) && (await isCredentialActive()),
    };
  }

  function sessionActive(sessionToken: string): boolean {
    const row = args.db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.token, sessionToken),
          gt(authSessions.expiresAt, new Date()),
        ),
      )
      .get();
    return row !== undefined;
  }

  async function resolvePrincipal(
    headers: Headers,
  ): Promise<RequestPrincipal | null> {
    return (await authenticate(headers))?.principal ?? null;
  }

  async function authenticate(
    headers: Headers,
  ): Promise<AuthenticatedCredential | null> {
    const gateToken = headers.get(GATE_IDENTITY_HEADER);
    headers.delete(GATE_IDENTITY_HEADER);
    if (gateToken !== null) {
      const stored = getPluginKvValue(args.db, "bb-account", "credential");
      let value: unknown;
      try {
        value = stored === undefined ? null : JSON.parse(stored);
      } catch {
        return null;
      }
      const parsed = connectCredentialSchema.safeParse(value);
      if (!parsed.success) return null;
      const identity = await verifyGateIdentity(
        gateToken,
        parsed.data.credential,
        parsed.data.serverId,
      );
      if (identity === null) return null;
      const gatePrincipal = args.db.transaction(() => {
        const email = normalizeEmail(identity.email);
        const existing = args.db
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.email, email))
          .get();
        if (existing !== undefined) {
          if (
            existing.id === LOCAL_OWNER_USER_ID ||
            existing.id === MACHINE_AUTH_SYSTEM_USER_ID
          )
            return null;
          return principalForUser(existing.id, "user");
        }
        const row = args.db
          .select()
          .from(authVerifications)
          .where(
            and(
              like(
                authVerifications.identifier,
                `${INVITE_IDENTIFIER_PREFIX}%`,
              ),
              gt(authVerifications.expiresAt, new Date()),
              sql`json_extract(CASE WHEN json_valid(${authVerifications.value}) THEN ${authVerifications.value} ELSE '{}' END, '$.email') = ${email}`,
            ),
          )
          .orderBy(asc(authVerifications.createdAt))
          .limit(1)
          .get();
        const invite =
          row === undefined
            ? null
            : inviteValueSchema.safeParse(JSON.parse(row.value));
        if (row === undefined || invite === null || !invite.success)
          throw new UserAuthError(
            403,
            "invite_required",
            "Connect access requires an invite for this email on this server",
          );
        const userId = `usr_${randomUUID()}`;
        const now = new Date();
        args.db
          .insert(authUsers)
          .values({
            id: userId,
            email,
            name: email,
            emailVerified: true,
            role: "member",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        args.db
          .delete(authVerifications)
          .where(eq(authVerifications.id, row.id))
          .run();
        return principalForUser(userId, "user");
      });
      return credentialFor(gatePrincipal, () => true);
    }
    const token = bearerToken(headers);
    if (token !== null) {
      if (timingSafeEqualStrings(token, serviceToken)) {
        return { principal: SERVICE_PRINCIPAL, isActive: async () => true };
      }
      if (token.startsWith(SHELL_TOKEN_PREFIX)) {
        const parts = token.slice(SHELL_TOKEN_PREFIX.length).split(".");
        if (parts.length !== 2) return null;
        const [payload, signature] = parts;
        const expected = createHmac("sha256", secret)
          .update(payload)
          .digest("base64url");
        if (!timingSafeEqualStrings(expected, signature)) return null;
        let value: unknown;
        try {
          value = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8"),
          );
        } catch {
          return null;
        }
        const parsed = shellTokenPayloadSchema.safeParse(value);
        if (!parsed.success || parsed.data.expiresAt <= Date.now()) return null;
        const expiresAt = parsed.data.expiresAt;
        const roleCeiling = parsed.data.roleCeiling ?? null;
        const shellPrincipal = principalForUser(parsed.data.userId, "user");
        if (shellPrincipal === null || roleCeiling === null) {
          return credentialFor(shellPrincipal, () => expiresAt > Date.now());
        }
        return {
          principal: { ...shellPrincipal, role: roleCeiling, roleCeiling },
          isActive: async () =>
            getUser(shellPrincipal.userId) !== null && expiresAt > Date.now(),
        };
      }
      if (!token.startsWith(USER_PAT_PREFIX)) {
        return null;
      }
      const userId = await verifyPersonalAccessToken(token);
      return userId === null
        ? null
        : credentialFor(
            principalForUser(userId, "user"),
            async () => (await verifyPersonalAccessToken(token)) === userId,
          );
    }
    if (headers.get("cookie") === null) {
      return null;
    }
    const session = await auth.api.getSession({ headers });
    if (session === null) {
      return null;
    }
    const sessionToken = session.session.token;
    return credentialFor(principalForUser(session.user.id, "user"), () =>
      sessionActive(sessionToken),
    );
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
        signUpArgs.inviteToken === null
          ? null
          : findInvite(signUpArgs.inviteToken);
      if ((!bootstrap || signUpArgs.inviteToken !== null) && invite === null) {
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
    const email = normalizeEmail(signInArgs.email);
    const retryAfterMs = attemptLimiter.acquire(email);
    if (retryAfterMs !== null) throw throttled(retryAfterMs);
    let result;
    try {
      result = await auth.api.signInEmail({
        body: { email, password: signInArgs.password },
        returnHeaders: true,
      });
      attemptLimiter.reset(email);
    } catch (error) {
      const status = errorStatusCode(error);
      if (status === 401 || status === 400 || status === 403) {
        attemptLimiter.recordFailure(email);
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
    } finally {
      notifyAuthorizationChange();
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
    if (result.changes > 0) notifyAuthorizationChange();
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
    const id = randomBytes(16).toString("hex");
    args.db
      .insert(authVerifications)
      .values({
        id,
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
      id,
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
    listInvites,
    revokeInvite,
    updateUserRole,
    removeUser,
    listPersonalAccessTokens,
    needsBootstrap,
    authenticate,
    onAuthorizationChange,
    resolvePrincipal,
    revokePersonalAccessToken,
    signIn,
    signOut,
    signUp,
  };
}
