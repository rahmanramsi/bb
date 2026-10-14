import type {
  AuthUserResponse,
  UpdateUserRoleRequest,
  UserListResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface ExperimentalUsersListArgs {
  signal?: AbortSignal;
}

export type ExperimentalUsersListResult = UserListResponse;

export interface ExperimentalUsersArea {
  directory(
    args?: ExperimentalUsersListArgs,
  ): Promise<ExperimentalUsersListResult>;
  updateRole(
    input: UpdateUserRoleRequest & { userId: string; signal?: AbortSignal },
  ): Promise<AuthUserResponse>;
  remove(input: {
    userId: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true }>;
  list(args?: ExperimentalUsersListArgs): Promise<ExperimentalUsersListResult>;
}

export function createUsersArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalUsersArea {
  return {
    async directory(input = {}) {
      return transport.readJson(
        transport.api.v1.users.directory.$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async updateRole(input) {
      return transport.readJson(
        transport.api.v1.users[":id"].role.$put(
          { param: { id: input.userId }, json: { role: input.role } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async remove(input) {
      return transport.readJson(
        transport.api.v1.users[":id"].$delete(
          { param: { id: input.userId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async list(input = {}) {
      return transport.readJson(
        transport.api.v1.users.$get({}, ...signalRequestArgs(input.signal)),
      );
    },
  };
}
