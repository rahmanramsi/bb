import { createApiClient } from "@bb/server-contract";
import {
  readJsonResponse,
  readVoidResponse,
  resolveResponse,
} from "./response.js";
import type { BbSdkTransport, CreateHttpTransportArgs } from "./transport.js";

const SAME_ORIGIN_BASE_URL = "";

export function createHttpTransport(
  args: CreateHttpTransportArgs,
): BbSdkTransport {
  const baseUrl = args.baseUrl ?? SAME_ORIGIN_BASE_URL;
  const baseFetch = args.fetch ?? fetch;
  const token = args.context?.authToken;
  const fetchImpl: typeof baseFetch =
    token === undefined
      ? baseFetch
      : (input, init) => {
          const headers = new Headers(
            input instanceof Request ? input.headers : undefined,
          );
          new Headers(init?.headers).forEach((value, key) =>
            headers.set(key, value),
          );
          headers.set("authorization", `Bearer ${token}`);
          return baseFetch(input, { ...init, headers });
        };
  const client = createApiClient(baseUrl, { fetch: fetchImpl });

  return {
    api: client.api,
    baseUrl,
    fetch: fetchImpl,
    ...(args.realtimeUrl ? { realtimeUrl: args.realtimeUrl } : {}),
    runtime: args.runtime,
    websocket: args.websocket,
    readJson: readJsonResponse,
    readVoid: readVoidResponse,
    resolve: resolveResponse,
  };
}
