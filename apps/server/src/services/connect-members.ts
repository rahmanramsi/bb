import { getPluginKvValue, type DbConnection } from "@bb/db";
import {
  connectMemberSchema,
  connectMemberListResponseSchema,
  type AddConnectMemberRequest,
} from "@bb/server-contract";
import { z } from "zod";
import { ApiError } from "../errors.js";

const credentialSchema = z.object({
  credential: z.string().min(1),
  serverId: z.string().min(1),
  serverUrl: z.string().url(),
});

async function requestConnectMembers<T>(
  db: DbConnection,
  method: "GET" | "POST" | "DELETE",
  input: AddConnectMemberRequest | string | null,
  responseSchema: z.ZodType<T>,
) {
  const stored = getPluginKvValue(db, "bb-account", "credential");
  let value: unknown;
  try {
    value = stored === undefined ? null : JSON.parse(stored);
  } catch {
    value = null;
  }
  const credential = credentialSchema.safeParse(value);
  if (!credential.success)
    throw new ApiError(
      409,
      "connect_not_paired",
      "Sign this server in with bb account login before sharing it",
    );
  const url = new URL("/api/connect/server-members", credential.data.serverUrl);
  url.searchParams.set("serverId", credential.data.serverId);
  if (typeof input === "string") url.searchParams.set("userId", input);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "x-bb-connect-machine": credential.data.credential,
        "content-type": "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(
      502,
      "connect_unavailable",
      "Could not reach bb connect",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      502,
      "connect_invalid_response",
      "bb connect returned an invalid response",
    );
  }
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    const status =
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 409
        ? response.status
        : 502;
    throw new ApiError(
      status,
      error.success ? error.data.error : "connect_request_failed",
      "bb connect could not update server access",
    );
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      502,
      "connect_invalid_response",
      "bb connect returned an invalid response",
    );
  return parsed.data;
}

export function listConnectMembers(db: DbConnection) {
  return requestConnectMembers(
    db,
    "GET",
    null,
    connectMemberListResponseSchema,
  );
}
export function addConnectMember(
  db: DbConnection,
  input: AddConnectMemberRequest,
) {
  return requestConnectMembers(
    db,
    "POST",
    input,
    z.object({ member: connectMemberSchema }).strict(),
  );
}
export function removeConnectMember(db: DbConnection, userId: string) {
  return requestConnectMembers(
    db,
    "DELETE",
    userId,
    z.object({ ok: z.literal(true) }).strict(),
  );
}
