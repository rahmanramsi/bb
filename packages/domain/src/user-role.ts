import { z } from "zod";

export const userRoleValues = ["admin", "member"] as const;
export const userRoleSchema = z.enum(userRoleValues);
export type UserRole = z.infer<typeof userRoleSchema>;

export const roleCeilingValues = ["member"] as const;
export type RoleCeiling = (typeof roleCeilingValues)[number];

export const LOCAL_OWNER_USER_ID = "usr_local_owner";
export const TEAM_THREAD_VIEWER_ID = "*team";
