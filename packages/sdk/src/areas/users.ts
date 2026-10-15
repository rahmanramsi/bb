import type {
  AddConnectMemberRequest,
  AddConnectMemberResponse,
  ConnectMemberListResponse,
  AuthUserResponse,
  PluginCallerGrantListResponse,
  UpdateUserRoleRequest,
  UserListResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface ExperimentalUsersListArgs {
  signal?: AbortSignal;
}

export type ExperimentalUsersListResult = UserListResponse;

export interface ExperimentalUsersArea {
  listConnectMembers(
    input?: ExperimentalUsersListArgs,
  ): Promise<ConnectMemberListResponse>;
  addConnectMember(
    input: AddConnectMemberRequest & { signal?: AbortSignal },
  ): Promise<AddConnectMemberResponse>;
  removeConnectMember(input: {
    userId: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true }>;
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
  listPluginGrants(input: {
    userId: string;
    signal?: AbortSignal;
  }): Promise<PluginCallerGrantListResponse>;
  revokePluginGrant(input: {
    userId: string;
    grantId: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true }>;
}

export function createUsersArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalUsersArea {
  return {
    async listConnectMembers(input = {}) {
      return transport.readJson(
        transport.api.v1.users["connect-members"].$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async addConnectMember(input) {
      return transport.readJson(
        transport.api.v1.users["connect-members"].$post(
          { json: { email: input.email, role: input.role ?? "member" } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async removeConnectMember(input) {
      return transport.readJson(
        transport.api.v1.users["connect-members"][":id"].$delete(
          { param: { id: input.userId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
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
    async listPluginGrants(input) {
      return transport.readJson(
        transport.api.v1.users[":id"]["plugin-grants"].$get(
          { param: { id: input.userId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async revokePluginGrant(input) {
      return transport.readJson(
        transport.api.v1.users[":id"]["plugin-grants"][":grantId"].$delete(
          { param: { id: input.userId, grantId: input.grantId } },
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
