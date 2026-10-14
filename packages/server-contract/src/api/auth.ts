import {
  roleCeilingValues,
  userRoleSchema,
  type RoleCeiling,
  type UserRole,
} from "@bb/domain";
import { z } from "zod";

export const authModeSchema = z.enum(["local", "multi"]);
export type AuthMode = z.infer<typeof authModeSchema>;

export const authPrincipalKindSchema = z.enum(["user", "local", "machine"]);
export type AuthPrincipalKind = z.infer<typeof authPrincipalKindSchema>;

export const authUserSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
    role: userRoleSchema,
  })
  .strict();
export type AuthUser = z.infer<typeof authUserSchema>;

export const authSessionResponseSchema = z
  .object({
    authMode: authModeSchema,
    needsBootstrap: z.boolean(),
    principalKind: authPrincipalKindSchema.nullable(),
    user: authUserSchema.nullable(),
    effectiveRole: userRoleSchema.nullable(),
    roleCeiling: z.enum(roleCeilingValues).nullable(),
  })
  .strict();
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

export const authSignInRequestSchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(1),
  })
  .strict();
export type AuthSignInRequest = z.infer<typeof authSignInRequestSchema>;

export const authSignUpRequestSchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
    name: z.string().trim().min(1).max(200),
    inviteToken: z.string().min(1).optional(),
  })
  .strict();
export type AuthSignUpRequest = z.infer<typeof authSignUpRequestSchema>;

export interface AuthUserResponse {
  user: AuthUser;
}

export interface AuthMeResponse {
  user: AuthUser;
  effectiveRole: UserRole;
  roleCeiling: RoleCeiling | null;
}

export interface UserListResponse {
  users: AuthUser[];
}

export const createPersonalAccessTokenRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type CreatePersonalAccessTokenRequest = z.infer<
  typeof createPersonalAccessTokenRequestSchema
>;

export interface PersonalAccessTokenSummary {
  id: string;
  name: string;
  start: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PersonalAccessTokenListResponse {
  tokens: PersonalAccessTokenSummary[];
}

export interface CreatePersonalAccessTokenResponse {
  token: string;
  summary: PersonalAccessTokenSummary;
}

export type PathPersonalAccessTokenId = { param: { id: string } };

export const createUserInviteRequestSchema = z
  .object({
    role: userRoleSchema.default("member"),
    email: z.string().trim().email().optional(),
  })
  .strict();
export type CreateUserInviteRequest = z.input<
  typeof createUserInviteRequestSchema
>;

export interface CreateUserInviteResponse {
  id: string;
  token: string;
  role: z.infer<typeof userRoleSchema>;
  email: string | null;
  expiresAt: number;
}

export const updateUserRoleRequestSchema = z
  .object({ role: userRoleSchema })
  .strict();
export type UpdateUserRoleRequest = z.infer<typeof updateUserRoleRequestSchema>;
export type PathUserId = { param: { id: string } };
export type PathUserInviteId = { param: { id: string } };
export interface UserInviteSummary {
  id: string;
  role: z.infer<typeof userRoleSchema>;
  email: string | null;
  expiresAt: number;
  createdAt: number;
  createdByUserId: string;
}
export interface UserInviteListResponse {
  invites: UserInviteSummary[];
}
export const acceptUserInviteRequestSchema = authSignUpRequestSchema.extend({
  inviteToken: z.string().min(1),
});
export type AcceptUserInviteRequest = z.infer<
  typeof acceptUserInviteRequestSchema
>;

export const connectMemberSchema = z
  .object({
    userId: z.string().min(1),
    email: z.string().email(),
    role: userRoleSchema,
  })
  .strict();
export const connectMemberListResponseSchema = z
  .object({ members: z.array(connectMemberSchema) })
  .strict();
export type ConnectMemberListResponse = z.infer<
  typeof connectMemberListResponseSchema
>;
export const addConnectMemberRequestSchema = z
  .object({
    email: z.string().trim().email(),
    role: userRoleSchema.default("member"),
  })
  .strict();
export type AddConnectMemberRequest = z.input<
  typeof addConnectMemberRequestSchema
>;
export interface AddConnectMemberResponse {
  member: z.infer<typeof connectMemberSchema>;
}
