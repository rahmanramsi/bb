/** A JSON-safe path segment reported by a Standard Schema validation issue. */
export type PluginRpcIssuePathSegment = string | number;

/** Validator-neutral validation detail carried by an RPC error envelope. */
export interface PluginRpcValidationIssue {
  message: string;
  path?: PluginRpcIssuePathSegment[];
}

/** Stable wire error categories for plugin RPC. */
export type PluginRpcErrorCode =
  | "invalid_json"
  | "invalid_input"
  | "handler_error"
  | "invalid_output"
  | "non_json_result"
  | "unknown_method"
  | "forbidden";

/** Structured RPC failure returned as `{ ok: false, error }`. */
export interface PluginRpcError {
  code: PluginRpcErrorCode;
  message: string;
  issues?: PluginRpcValidationIssue[];
}

/**
 * Thrown by an rpc handler to refuse its caller, for methods that need an
 * admin only for some inputs. The host answers HTTP 403 with error code
 * `forbidden` and this message, the same reply as a contract's
 * `experimental_requiredRole`. Every other thrown error stays `handler_error`.
 */
export class experimental_PluginRpcForbiddenError extends Error {
  readonly code = "forbidden";

  constructor(message: string) {
    super(message);
    this.name = "PluginRpcForbiddenError";
  }
}

/**
 * The validator-neutral subset of Standard Schema v1 used by plugin contracts.
 * Zod 4 schemas implement this interface directly; other validators can do
 * the same without becoming part of BB's public protocol.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | StandardSchemaV1Result<Output>
      | Promise<StandardSchemaV1Result<Output>>;
    readonly jsonSchema?: {
      readonly input: (options: { target: string }) => Record<string, unknown>;
      readonly output: (options: { target: string }) => Record<string, unknown>;
    };
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaV1Issue[] };

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?:
    | PropertyKey
    | readonly (PropertyKey | { readonly key: PropertyKey })[];
}

export type StandardSchemaV1InferInput<Schema extends StandardSchemaV1> =
  NonNullable<Schema["~standard"]["types"]>["input"];

export type StandardSchemaV1InferOutput<Schema extends StandardSchemaV1> =
  NonNullable<Schema["~standard"]["types"]>["output"];

export interface PluginRpcMethodContract<
  InputSchema extends StandardSchemaV1 = StandardSchemaV1,
  OutputSchema extends StandardSchemaV1 = StandardSchemaV1,
> {
  readonly experimental_description?: string;
  /**
   * `"admin"` limits the method to server admins. In multi-user mode the host
   * answers other callers with HTTP 403 and error code `forbidden` before the
   * handler runs. Mark methods that change server-wide configuration,
   * credentials, or other admin-only state.
   */
  readonly experimental_requiredRole?: "admin";
  readonly input: InputSchema;
  readonly output: OutputSchema;
}

export type PluginRpcContract = Readonly<
  Record<string, PluginRpcMethodContract>
>;

/** Define a shared RPC contract while preserving exact method/schema types. */
export function defineRpcContract<const Contract extends PluginRpcContract>(
  contract: Contract,
): Contract {
  return contract;
}

/**
 * Who invoked a plugin entry point (rpc method, HTTP or WebSocket route, CLI
 * command, or agent tool).
 *
 * - `client`: an authenticated person through the app, the `bb` CLI, a
 *   thread's `BB_TOKEN`, or another credential. `role` is the account's
 *   server role, `roleCeiling` is the cap the credential carries (`"member"`
 *   for a capped `BB_TOKEN`, otherwise `null`), and `effectiveRole` is the
 *   authority the request actually has. For an agent tool it is the author of
 *   the turn that called the tool. In local mode every client is the local
 *   owner admin. The server takes `userId` from the request's credential,
 *   never from its body; key `bb.storage.experimental_forUser`,
 *   `bb.settings.experimental_getForUser`, and `bb.realtime.publish`'s
 *   `experimental_userId` with it.
 * - `plugin`: a loaded plugin (or this one) called through its own
 *   `bb.sdk.plugins.callRpc`; the host verifies that with a per-load token
 *   only the server knows.
 * - `system`: bb itself, with no person behind the request (the server
 *   service credential, or an agent tool called from a turn that has no human
 *   author).
 */
export type ExperimentalPluginCaller =
  | {
      readonly kind: "client";
      readonly userId: string;
      readonly role: "admin" | "member";
      readonly roleCeiling: "member" | null;
      readonly effectiveRole: "admin" | "member";
    }
  | { readonly kind: "plugin"; readonly pluginId: string }
  | { readonly kind: "system" };

/** The caller of an rpc method; the same shape as every other entry point's. */
export type ExperimentalPluginRpcCaller = ExperimentalPluginCaller;

/**
 * The identity of one plugin entry-point invocation. Pass it to
 * `bb.sdk.experimental_asCaller` to act as that caller while the invocation
 * runs.
 */
export interface ExperimentalPluginCallerContext {
  readonly experimental_caller: ExperimentalPluginCaller;
}

/** Second argument of every rpc handler. */
export type ExperimentalPluginRpcHandlerContext =
  ExperimentalPluginCallerContext;

export type PluginRpcHandlers<Contract extends PluginRpcContract> = {
  [Method in keyof Contract]: (
    input: StandardSchemaV1InferOutput<Contract[Method]["input"]>,
  ) =>
    | StandardSchemaV1InferInput<Contract[Method]["output"]>
    | Promise<StandardSchemaV1InferInput<Contract[Method]["output"]>>;
};

/**
 * Handlers as `bb.rpc.register` calls them: the validated input, then the
 * call's context. A `PluginRpcHandlers` map is assignable to this type, so
 * handlers that ignore the context keep their one-argument signature.
 */
export type ExperimentalPluginRpcHandlersWithContext<
  Contract extends PluginRpcContract,
> = {
  [Method in keyof Contract]: (
    input: StandardSchemaV1InferOutput<Contract[Method]["input"]>,
    context: ExperimentalPluginRpcHandlerContext,
  ) =>
    | StandardSchemaV1InferInput<Contract[Method]["output"]>
    | Promise<StandardSchemaV1InferInput<Contract[Method]["output"]>>;
};

type PluginRpcCallInput<Method extends PluginRpcMethodContract> =
  StandardSchemaV1InferInput<Method["input"]>;

export type PluginRpcCallArgs<Method extends PluginRpcMethodContract> =
  null extends PluginRpcCallInput<Method>
    ? [input?: PluginRpcCallInput<Method>]
    : [input: PluginRpcCallInput<Method>];

export type PluginRpcResult<Method extends PluginRpcMethodContract> =
  StandardSchemaV1InferOutput<Method["output"]>;
