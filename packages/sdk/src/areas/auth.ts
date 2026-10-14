import type {
  AcceptUserInviteRequest,
  AuthSessionResponse,
  AuthSignInRequest,
  AuthSignUpRequest,
  AuthUserResponse,
  CreatePersonalAccessTokenRequest,
  CreatePersonalAccessTokenResponse,
  CreateUserInviteRequest,
  CreateUserInviteResponse,
  PersonalAccessTokenListResponse,
  UserInviteListResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

type WithSignal<T> = T & { signal?: AbortSignal };

export interface ExperimentalAuthArea {
  me(input?: { signal?: AbortSignal }): Promise<AuthUserResponse>;
  session(input?: { signal?: AbortSignal }): Promise<AuthSessionResponse>;
  signIn(input: WithSignal<AuthSignInRequest>): Promise<AuthUserResponse>;
  signUp(input: WithSignal<AuthSignUpRequest>): Promise<AuthUserResponse>;
  signOut(): Promise<{ ok: true }>;
  createToken(
    input: WithSignal<CreatePersonalAccessTokenRequest>,
  ): Promise<CreatePersonalAccessTokenResponse>;
  listTokens(input?: {
    signal?: AbortSignal;
  }): Promise<PersonalAccessTokenListResponse>;
  revokeToken(input: WithSignal<{ id: string }>): Promise<{ ok: true }>;
  createInvite(
    input: WithSignal<CreateUserInviteRequest>,
  ): Promise<CreateUserInviteResponse>;
  listInvites(input?: {
    signal?: AbortSignal;
  }): Promise<UserInviteListResponse>;
  revokeInvite(input: WithSignal<{ id: string }>): Promise<{ ok: true }>;
  acceptInvite(
    input: WithSignal<AcceptUserInviteRequest>,
  ): Promise<AuthUserResponse>;
}

export function createAuthArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalAuthArea {
  const api = transport.api.v1;
  return {
    me: (input = {}) =>
      transport.readJson(api.me.$get({}, ...signalRequestArgs(input.signal))),
    session: (input = {}) =>
      transport.readJson(
        api.auth.session.$get({}, ...signalRequestArgs(input.signal)),
      ),
    signIn: ({ signal, ...json }) =>
      transport.readJson(
        api.auth["sign-in"].$post({ json }, ...signalRequestArgs(signal)),
      ),
    signUp: ({ signal, ...json }) =>
      transport.readJson(
        api.auth["sign-up"].$post({ json }, ...signalRequestArgs(signal)),
      ),
    signOut: () => transport.readJson(api.auth["sign-out"].$post()),
    createToken: ({ signal, ...json }) =>
      transport.readJson(
        api.auth.tokens.$post({ json }, ...signalRequestArgs(signal)),
      ),
    listTokens: (input = {}) =>
      transport.readJson(
        api.auth.tokens.$get({}, ...signalRequestArgs(input.signal)),
      ),
    revokeToken: ({ id, signal }) =>
      transport.readJson(
        api.auth.tokens[":id"].$delete(
          { param: { id } },
          ...signalRequestArgs(signal),
        ),
      ),
    createInvite: ({ signal, ...json }) =>
      transport.readJson(
        api.auth.invites.$post({ json }, ...signalRequestArgs(signal)),
      ),
    listInvites: (input = {}) =>
      transport.readJson(
        api.auth.invites.$get({}, ...signalRequestArgs(input.signal)),
      ),
    revokeInvite: ({ id, signal }) =>
      transport.readJson(
        api.auth.invites[":id"].$delete(
          { param: { id } },
          ...signalRequestArgs(signal),
        ),
      ),
    acceptInvite: ({ signal, ...json }) =>
      transport.readJson(
        api.auth.invites.accept.$post({ json }, ...signalRequestArgs(signal)),
      ),
  };
}
