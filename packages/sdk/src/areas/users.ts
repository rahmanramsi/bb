import type { UserListResponse } from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface ExperimentalUsersListArgs {
  signal?: AbortSignal;
}

export type ExperimentalUsersListResult = UserListResponse;

export interface ExperimentalUsersArea {
  list(args?: ExperimentalUsersListArgs): Promise<ExperimentalUsersListResult>;
}

export function createUsersArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalUsersArea {
  return {
    async list(input = {}) {
      return transport.readJson(
        transport.api.v1.users.$get({}, ...signalRequestArgs(input.signal)),
      );
    },
  };
}
