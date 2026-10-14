import { createNodeBbSdk, type BbSdk } from "@bb/sdk/node";
import { resolveCliAuthToken } from "./auth-store.js";
import type { Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  const url = input instanceof Request ? input.url : input.toString();
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  if (!headers.has("authorization")) {
    const token = resolveCliAuthToken(url);
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

export function createCliBbSdk(baseUrl: string): BbSdk {
  return createNodeBbSdk({
    baseUrl,
    fetch: cliFetch,
    context: { authToken: resolveCliAuthToken(baseUrl) },
  });
}
